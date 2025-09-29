<template>
  <div
    class="edit-area-wrapper"
    :style="{ visibility: isReady ? 'visible' : 'hidden' }"
    @dragenter.prevent="onDragEnter"
    @dragover.prevent
    @dragleave.prevent="onDragLeave"
    @drop.prevent="onDrop"
  >
    <div v-if="isDragging" class="drag-overlay">
      <span>Drop files here</span>
    </div>

    <div class="edit-area">
      <!-- Attachment Previews -->
      <div v-if="attachments.length > 0" class="attachment-previews">
        <div
          v-for="file in attachments"
          :key="file.id"
          class="preview-card"
          :class="{ expired: isExpired(file) }"
        >
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
        ref="textInput"
        v-model="text"
        placeholder="Edit message..."
        class="text-input"
        rows="1"
        @keydown.tab.exact.prevent="handleTab"
        @keydown.shift.tab.prevent="handleShiftTab"
        @keydown.ctrl.enter.prevent="handleSave"
      ></textarea>
      <div class="action-buttons">
        <input
          ref="fileInput"
          type="file"
          style="display: none"
          multiple
          @change="handleFileChange"
        />
        <div class="main-actions">
          <button class="secondary-button" @click="handleCancel">Cancel</button>
          <button class="primary-button" @click="handleSave">Save</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { useChatStore } from '../stores/chat'
import { getFileTypeIcon } from '../utils/fileIcons'
import { BlobUrlManager } from '../utils/blobUrlManager'
const props = defineProps({
  messageId: {
    type: String,
    required: true,
  },
})

const emit = defineEmits(['ready'])

const store = useChatStore()
const fileInput = ref(null)
const textInput = ref(null)
const dragCounter = ref(0)
const isReady = ref(false)

const adjustTextHeight = () => {
  const textarea = textInput.value
  if (!textarea) return

  textarea.style.height = 'auto'

  const style = window.getComputedStyle(textarea)
  const borderTop = parseFloat(style.borderTopWidth) || 0
  const borderBottom = parseFloat(style.borderBottomWidth) || 0
  const lineHeight = parseFloat(style.lineHeight) || 21
  const baseHeight =
    textarea.scrollHeight + borderTop + borderBottom + lineHeight

  textarea.style.height = `${baseHeight}px`
  textarea.style.overflowY = 'hidden'
  textarea.style.overflowX = 'auto'

  const structuralGap = textarea.offsetHeight - textarea.clientHeight
  const scrollbarHeight = Math.max(0, structuralGap - borderTop - borderBottom)
  const needsHorizontalScroll = textarea.scrollWidth > textarea.clientWidth
  if (needsHorizontalScroll && scrollbarHeight > 0) {
    textarea.style.height = `${baseHeight + scrollbarHeight}px`
  }
}

const scheduleHeightAdjustment = () => {
  nextTick(() => {
    requestAnimationFrame(() => {
      adjustTextHeight()
    })
  })
}

// --- Computed Properties ---
const text = computed({
  get: () => store.editingState?.draftText ?? '',
  set: (value) => {
    store.setEditingDraft(value)
  },
})

const attachments = computed(() => store.editorBucket?.items ?? [])

const isDragging = computed(() => dragCounter.value > 0)

const thumbnailManager = new BlobUrlManager()

const getThumbnailUrl = (attachment) => {
  if (!attachment || !attachment.mimeType?.startsWith('image/')) return null
  return thumbnailManager.get(attachment.id)
}

onMounted(() => {
  if (store.editingState?.messageId !== props.messageId) {
    store.startEditing(props.messageId)
  }

  // Calculate initial height based on text content
  const text = store.editingState?.draftText || ''
  const lines = Math.max(text.split('\n').length, 1)
  const lineHeight = 21
  const padding = 20
  const initialHeight = lines * lineHeight + padding

  if (textInput.value) {
    textInput.value.style.height = `${initialHeight}px`
  }

  scheduleHeightAdjustment()

  nextTick(() => {
    requestAnimationFrame(() => {
      isReady.value = true
      emit('ready')
    })
  })
})

watch(
  () => store.editingState?.messageId,
  () => {
    scheduleHeightAdjustment()
  }
)

watch(
  text,
  () => {
    scheduleHeightAdjustment()
  },
  { immediate: true }
)

watch(
  attachments,
  (next) => {
    scheduleHeightAdjustment()
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
const handleSave = () => {
  store.saveEdit()
}

const handleCancel = () => {
  store.cancelEditing()
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
    text.value = newText

    nextTick(() => {
      textarea.selectionStart = start
      textarea.selectionEnd = start + indentedText.length
    })
  } else {
    const tab = '    '
    const newText =
      textarea.value.substring(0, start) + tab + textarea.value.substring(end)
    text.value = newText

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
    text.value = newText

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

    text.value = newText
    nextTick(() => {
      textarea.selectionStart = textarea.selectionEnd = newCursorPos
    })
  }
}

const handleFileChange = (event) => {
  const files = event.target.files
  if (files && files.length > 0) {
    const providerId = store.currentRequestConfig.providerId
    store.editorBucket?.addFiles(files, { providerId })
  }
  event.target.value = '' // Reset input
}

const removeAttachment = (fileId) => {
  store.editorBucket?.remove(fileId)
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
    store.editorBucket?.addFiles(files, { providerId })
  }
}

const isExpired = (attachment) => {
  if (!attachment.expirationTime) return false
  return new Date(attachment.expirationTime) < new Date()
}

// Clean up object URLs to prevent memory leaks
onUnmounted(() => {
  const textarea = textInput.value
  if (textarea) {
    textarea.style.height = ''
    textarea.style.overflowY = ''
  }
  thumbnailManager.clear()
})
</script>

<style scoped>
.edit-area-wrapper {
  padding: 8px;
  background-color: var(--bg-light);
  border-radius: var(--border-radius);
  border: 1px solid var(--primary-color);
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

.edit-area {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-color);
  border-radius: var(--border-radius);
  padding: 8px 12px;
  background-color: var(--bg-color);
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

.text-input {
  border: none;
  background: none;
  resize: none;
  font-size: 14px;
  line-height: 1.5;
  outline: none;
  white-space: pre;
  overflow-y: hidden;
  overflow-x: auto;
  color: var(--text-color);
}

.action-buttons {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  margin-top: 4px;
}

.main-actions {
  display: flex;
  gap: 8px;
  margin: 0 0 0 auto;
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

.primary-button,
.secondary-button {
  padding: 6px 12px;
  border-radius: var(--border-radius);
  border: 1px solid var(--border-color);
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  transition: var(--transition);
}

.primary-button {
  background-color: var(--primary-color);
  color: white;
  border-color: var(--primary-color);
}
.primary-button:hover:not(:disabled) {
  background-color: var(--primary-dark);
}
.primary-button:disabled {
  background-color: var(--bg-gray);
  color: var(--text-light);
  cursor: not-allowed;
}

.secondary-button {
  background-color: var(--bg-color);
  color: var(--text-color);
}
.secondary-button:hover {
  background-color: var(--bg-gray);
}
.preview-card.expired {
  opacity: 0.5;
  filter: grayscale(80%);
}
</style>
