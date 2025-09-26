<template>
  <footer
    class="input-area-wrapper"
    @dragenter.prevent="onDragEnter"
    @dragover.prevent
    @dragleave.prevent="onDragLeave"
    @drop.prevent="onDrop"
  >
    <div v-if="isDragging" class="drag-overlay">
      <span>Drop files here</span>
    </div>

    <div class="input-area">
      <!-- Attachment Previews -->
      <div v-if="attachments.length > 0" class="attachment-previews">
        <div v-for="file in attachments" :key="file.id" class="preview-card">
          <div class="preview-thumbnail">
            <img
              v-if="getThumbnailUrl(file)"
              :src="getThumbnailUrl(file)"
              class="thumbnail-image"
            />
            <font-awesome-icon
              v-else
              :icon="getFileTypeIcon(file.mimeType)"
              class="thumbnail-icon"
            />
          </div>
          <div class="preview-details">
            <span class="preview-name">{{ file.name }}</span>
            <span class="preview-size"
              >{{ (file.size / 1024).toFixed(2) }} KB</span
            >
            <div v-if="file.uploadProgress < 100" class="progress-bar">
              <div
                class="progress"
                :style="{ width: file.uploadProgress + '%' }"
              ></div>
            </div>
            <span v-if="file.error" class="preview-error">{{
              file.error
            }}</span>
          </div>
          <button
            class="remove-attachment-btn"
            @click="removeAttachment(file.id)"
          >
            <font-awesome-icon icon="times" />
          </button>
        </div>
      </div>

      <textarea
        ref="promptInput"
        v-model="prompt"
        placeholder="Press Ctrl + Enter to send"
        class="prompt-input"
        rows="1"
        @keydown.tab.exact.prevent="handleTab"
        @keydown.shift.tab.prevent="handleShiftTab"
        @keydown.ctrl.enter="handleSend"
      ></textarea>
      <div class="action-buttons">
        <input
          ref="fileInput"
          type="file"
          style="display: none"
          multiple
          @change="handleFileChange"
        />
        <button class="icon-button" title="Attach file" @click="openFileInput">
          <font-awesome-icon icon="paperclip" />
        </button>
        <button
          class="icon-button"
          :class="{ active: toolSettings.useUrlContext }"
          title="Enable Url Context"
          @click="toggleTool('useUrlContext')"
        >
          <font-awesome-icon icon="link" />
        </button>
        <button
          class="icon-button"
          :class="{ active: toolSettings.useGrounding }"
          title="Enable Search Grounding"
          @click="toggleTool('useGrounding')"
        >
          <font-awesome-icon icon="search" />
        </button>
        <button
          class="icon-button"
          :class="{ active: toolSettings.useCodeExecution }"
          title="Enable Code Execution"
          @click="toggleTool('useCodeExecution')"
        >
          <font-awesome-icon icon="code" />
        </button>
        <button
          class="send-button"
          :title="isSending ? 'Stop' : 'Send'"
          :disabled="isUploadingFiles"
          :class="{ 'is-sending': isSending }"
          @click="handleSend"
        >
          <font-awesome-icon :icon="isSending ? 'stop' : 'paper-plane'" />
        </button>
      </div>
    </div>
  </footer>
</template>

<script setup>
import { computed, ref, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { useChatStore } from '../stores/chat'
import { getFileTypeIcon } from '../utils/fileIcons'
import { BlobUrlManager } from '../utils/blobUrlManager'
const store = useChatStore()
const fileInput = ref(null)
const promptInput = ref(null)
const dragCounter = ref(0)

// --- Computed Properties ---
const prompt = computed({
  get: () => store.promptText,
  set: (value) => {
    store.setPrompt(value)
  },
})

const toolSettings = computed(() => store.composerState.tools)

const attachments = computed(() => store.composerBucket.items)
const isSending = computed(() => store.isGenerating)
const isDragging = computed(() => dragCounter.value > 0)
const isUploadingFiles = computed(() => {
  return attachments.value.some((file) => file.uploadProgress < 100)
})

const thumbnailManager = new BlobUrlManager()

const MAX_PROMPT_HEIGHT = 200

const adjustPromptHeight = () => {
  const textarea = promptInput.value
  if (!textarea) return
  textarea.style.height = 'auto'
  const scrollHeight = textarea.scrollHeight
  const nextHeight = Math.min(scrollHeight, MAX_PROMPT_HEIGHT)
  textarea.style.height = `${nextHeight}px`
  textarea.style.overflowY =
    scrollHeight > MAX_PROMPT_HEIGHT ? 'auto' : 'hidden'
}

onMounted(() => {
  nextTick(adjustPromptHeight)
})

watch(
  prompt,
  () => {
    nextTick(adjustPromptHeight)
  },
  { immediate: true }
)

watch(
  attachments,
  (next) => {
    const nextList = Array.isArray(next) ? next : []
    const keepIds = new Set()

    for (const att of nextList) {
      if (!att?.id) continue
      keepIds.add(att.id)

      if (att.mimeType?.startsWith('image/') && att.blob) {
        thumbnailManager.create(att.id, att.blob)
      }
    }

    thumbnailManager.cleanup(keepIds)
  },
  { deep: true, immediate: true }
)

// --- Methods ---
const toggleTool = (toolName) => {
  store.toggleTool(toolName)
}

const handleSend = () => {
  if (isSending.value) {
    store.cancelGeneration()
  } else {
    store.sendMessage()
  }
}

const handleTab = (event) => {
  const textarea = event.target
  const start = textarea.selectionStart
  const end = textarea.selectionEnd

  if (start !== end) {
    const selectedText = textarea.value.substring(start, end)
    const lines = selectedText.split('\n')
    const indentedLines = lines.map((line) => '    ' + line)
    const indentedText = indentedLines.join('\n')

    const newText =
      textarea.value.substring(0, start) +
      indentedText +
      textarea.value.substring(end)
    prompt.value = newText

    nextTick(() => {
      textarea.selectionStart = start
      textarea.selectionEnd = start + indentedText.length
    })
  } else {
    const tab = '    '
    const newText =
      textarea.value.substring(0, start) + tab + textarea.value.substring(end)
    prompt.value = newText

    nextTick(() => {
      textarea.selectionStart = textarea.selectionEnd = start + tab.length
    })
  }
}

const handleShiftTab = (event) => {
  const textarea = event.target
  const start = textarea.selectionStart
  const end = textarea.selectionEnd

  if (start !== end) {
    const selectedText = textarea.value.substring(start, end)
    const lines = selectedText.split('\n')
    const unindentedLines = lines.map((line) =>
      line.startsWith('    ')
        ? line.substring(4)
        : line.startsWith('\t')
          ? line.substring(1)
          : line
    )
    const unindentedText = unindentedLines.join('\n')

    const newText =
      textarea.value.substring(0, start) +
      unindentedText +
      textarea.value.substring(end)
    prompt.value = newText

    nextTick(() => {
      textarea.selectionStart = start
      textarea.selectionEnd = start + unindentedText.length
    })
  } else {
    const beforeCursor = textarea.value.substring(0, start)
    const lineStart = beforeCursor.lastIndexOf('\n') + 1
    const line = beforeCursor.substring(lineStart)

    let newText = textarea.value
    let newCursorPos = start

    if (line.startsWith('    ')) {
      newText =
        textarea.value.substring(0, lineStart) +
        line.substring(4) +
        textarea.value.substring(start)
      newCursorPos = start - 4
    } else if (line.startsWith('\t')) {
      newText =
        textarea.value.substring(0, lineStart) +
        line.substring(1) +
        textarea.value.substring(start)
      newCursorPos = start - 1
    }

    prompt.value = newText
    nextTick(() => {
      textarea.selectionStart = textarea.selectionEnd = newCursorPos
    })
  }
}

// --- File Handling ---
const openFileInput = () => {
  fileInput.value.click()
}

const handleFileChange = (event) => {
  const files = event.target.files
  if (files && files.length > 0) {
    const providerId = store.currentRequestConfig.providerId
    store.composerBucket.addFiles(files, { providerId })
  }
  event.target.value = '' // Reset input
}

const removeAttachment = (fileId) => {
  store.composerBucket.remove(fileId)
}

// --- Drag and Drop ---
const onDragEnter = () => {
  dragCounter.value++
}

const onDragLeave = () => {
  dragCounter.value--
}

const onDrop = (event) => {
  dragCounter.value = 0
  const files = event.dataTransfer.files
  if (files && files.length > 0) {
    const providerId = store.currentRequestConfig.providerId
    store.composerBucket.addFiles(files, { providerId })
  }
}

const getThumbnailUrl = (attachment) => {
  if (!attachment || !attachment.mimeType?.startsWith('image/')) return null
  return thumbnailManager.get(attachment.id)
}

// Clean up object URLs to prevent memory leaks
const resetPromptHeight = () => {
  const textarea = promptInput.value
  if (!textarea) return
  textarea.style.height = ''
  textarea.style.overflowY = ''
}

onUnmounted(() => {
  resetPromptHeight()
  thumbnailManager.clear()
})
</script>

<style scoped>
.input-area-wrapper {
  padding: 16px 24px 24px;
  background-color: var(--bg-color);
  flex-shrink: 0;
  border-top: 1px solid var(--border-color);
  position: relative;
}

.drag-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: var(--primary-light);
  border: 2px dashed var(--primary-color);
  border-radius: var(--border-radius);
  display: flex;
  justify-content: center;
  align-items: center;
  margin: 8px;
  font-size: 18px;
  font-weight: bold;
  color: var(--primary-color);
  z-index: 10;
}

.input-area {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-color);
  border-radius: var(--border-radius);
  padding: 8px 12px;
  box-shadow: var(--shadow-sm);
}

.attachment-previews {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 12px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border-color);
  margin-bottom: 8px;
}

.preview-card {
  display: flex;
  align-items: center;
  background-color: var(--bg-light);
  border-radius: var(--border-radius);
  padding: 8px;
  gap: 8px;
  position: relative;
}

.preview-thumbnail {
  width: 40px;
  height: 40px;
  flex-shrink: 0;
  display: flex;
  justify-content: center;
  align-items: center;
  background-color: var(--bg-gray);
  border-radius: var(--border-radius);
  overflow: hidden;
}

.thumbnail-image {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.thumbnail-icon {
  font-size: 20px;
  color: var(--text-light);
}

.preview-details {
  flex-grow: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.preview-name {
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text-color);
}

.preview-size {
  font-size: 11px;
  color: var(--text-light);
}

.progress-bar {
  width: 100%;
  height: 4px;
  background-color: var(--border-color);
  border-radius: 2px;
  margin-top: 4px;
}

.progress {
  height: 100%;
  background-color: var(--primary-color);
  border-radius: 2px;
  transition: width 0.2s;
}

.preview-error {
  font-size: 11px;
  color: var(--danger-color);
  font-weight: 500;
}

.remove-attachment-btn {
  position: absolute;
  top: -5px;
  right: -5px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background-color: var(--text-light);
  color: var(--bg-color);
  border: none;
  cursor: pointer;
  display: flex;
  justify-content: center;
  align-items: center;
  font-size: 10px;
}

.prompt-input {
  border: none;
  background: none;
  resize: none;
  font-size: 14px;
  line-height: 1.5;
  max-height: 200px;
  outline: none;
  field-sizing: content;
  overflow-y: auto;
  color: var(--text-color);
}

.action-buttons {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  margin-top: 4px;
}

.icon-button {
  width: 28px;
  height: 28px;
  border-radius: var(--border-radius);
  background: none;
  border: none;
  color: var(--text-light);
  cursor: pointer;
  display: flex;
  justify-content: center;
  align-items: center;
  transition: var(--transition);
}
.icon-button:hover {
  background-color: var(--bg-gray);
}
.icon-button.active {
  background-color: var(--primary-light);
  color: var(--primary-color);
}

.send-button {
  width: 30px;
  height: 30px;
  border-radius: var(--border-radius);
  background-color: var(--primary-color);
  border: none;
  color: white;
  cursor: pointer;
  display: flex;
  justify-content: center;
  align-items: center;
  transition: var(--transition);
}
.send-button:hover:not(:disabled) {
  background-color: var(--primary-dark);
}

.send-button:disabled {
  color: #ccc;
  background-color: var(--bg-gray);
  cursor: not-allowed;
}

.send-button.is-sending {
  background-color: var(--danger-color);
}
.send-button.is-sending:hover {
  background-color: var(--danger-dark);
}
</style>
