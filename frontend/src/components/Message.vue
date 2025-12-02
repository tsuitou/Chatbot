<template>
  <div v-if="!isCancelled" class="message-wrapper">
    <div class="message-header">
      <div class="sender-info">
        <span class="sender-name">{{ senderLabel }}</span>
        <span v-if="messageTimestamp" class="message-timestamp">{{
          messageTimestamp
        }}</span>
      </div>
      <div v-if="!isEditing" class="message-actions">
        <button
          title="Edit"
          :disabled="actionsDisabled"
          @click="emit('edit', messageId)"
        >
          <font-awesome-icon icon="edit" />
        </button>
        <button
          title="Rerun"
          :disabled="actionsDisabled"
          @click="emit('resend', messageId)"
        >
          <font-awesome-icon icon="sync-alt" />
        </button>
        <button title="Copy" :disabled="actionsDisabled" @click="copyContent">
          <font-awesome-icon :icon="copyIcon" />
        </button>
        <button
          title="Delete"
          :disabled="actionsDisabled"
          @click="emit('delete', messageId)"
        >
          <font-awesome-icon icon="trash-alt" />
        </button>
      </div>
    </div>

    <div class="message-body">
      <div v-if="shouldShowSystem" class="message-bubble system-bubble">
        <div
          class="thought-stream"
          :class="{
            collapsed: group.system.isCollapsed,
            disabled: !group.system.hasThoughts,
          }"
        >
          <button
            class="thought-stream-header"
            type="button"
            :class="{ disabled: !group.system.hasThoughts }"
            :aria-expanded="
              group.system.hasThoughts ? !group.system.isCollapsed : undefined
            "
            :aria-disabled="!group.system.hasThoughts || undefined"
            @click="group.system.hasThoughts && toggleThoughts()"
          >
            <div class="status-icon" :class="{ streaming: isStreaming }">
              <span class="duration-text">{{ durationDisplay }}</span>
            </div>
            <div class="system-summary">
              <template v-if="group.system.indicators.length">
                <span
                  v-for="(indicator, index) in group.system.indicators"
                  :key="`indicator-${group.id}-${index}`"
                  class="summary-item"
                >
                  <font-awesome-icon
                    v-if="indicator.icon"
                    :icon="indicator.icon"
                  />
                  <span>{{ indicator.text }}</span>
                </span>
              </template>
              <span v-else class="summary-item summary-item--placeholder">
                <span>{{ defaultSystemSummary }}</span>
              </span>
            </div>
            <font-awesome-icon
              :icon="group.system.isCollapsed ? 'chevron-down' : 'chevron-up'"
              class="thought-chevron"
            />
          </button>
          <transition name="fade">
            <div
              v-if="group.system.hasThoughts && !group.system.isCollapsed"
              class="thought-stream-content"
            >
              <template
                v-for="(segment, index) in group.system.thoughtSegments"
                :key="`thought-${messageId}-${index}`"
              >
                <!-- eslint-disable-next-line vue/no-v-html -->
                <div
                  v-if="segment.type === 'plaintext'"
                  v-html="segment.htmlContent"
                ></div>
                <CodeBlock
                  v-else-if="segment.type === 'code'"
                  :content="segment.content"
                  :lang="segment.lang"
                />
              </template>
            </div>
          </transition>
        </div>
      </div>

      <div
        v-if="shouldShowContentBubble"
        class="message-bubble"
        :class="[{ 'is-streaming': isStreaming }, contentBubbleClass]"
      >
        <div v-if="!isUserMessage" class="prose">
          <template
            v-for="(segment, index) in group.content.segments"
            :key="`${messageId}-content-${index}`"
          >
            <!-- eslint-disable-next-line vue/no-v-html -->
            <div
              v-if="segment.type === 'plaintext'"
              v-html="segment.htmlContent"
            ></div>
            <CodeBlock
              v-else-if="segment.type === 'code'"
              :content="segment.content"
              :lang="segment.lang"
            />
            <div
              v-else-if="segment.type === 'prompt'"
              v-text="segment.htmlContent"
            ></div>
          </template>
        </div>
        <div
          v-else
          class="plain-user-text"
          v-text="group.message?.content?.text || ''"
        ></div>
        <!-- eslint-disable-next-line vue/no-v-html -->
        <div v-if="!isUserMessage && metadataSegments.length" class="metadata">
          <div
            v-for="(segment, index) in metadataSegments"
            :key="`${messageId}-meta-${index}`"
            class="metadata-item"
            v-html="segment"
          ></div>
        </div>
      </div>

      <EditArea
        v-if="isEditing"
        :message-id="messageId"
        @ready="editAreaReady = true"
      />

      <div
        v-if="group.content.attachments.length && !isEditing"
        class="attachment-list"
      >
        <a
          v-for="att in group.content.attachments"
          :key="att.id"
          :href="getAttachmentUrl(att)"
          :download="att.name"
          class="attachment-chip"
          :title="attachmentTitle(att)"
          :class="{ expired: isExpired(att) }"
          @click="handleAttachmentClick(att, $event)"
        >
          <font-awesome-icon icon="file-download" />
          <span>{{ att.name }}</span>
        </a>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, onUnmounted, watch, onMounted } from 'vue'
import { useChatStore } from '../stores/chat'
import { useDisplayStore } from '../stores/display'
import CodeBlock from './CodeBlock.vue'
import EditArea from './EditArea.vue'
const emit = defineEmits(['edit', 'resend', 'delete'])

const props = defineProps({
  group: {
    type: Object,
    required: true,
  },
})

const chatStore = useChatStore()
const displayStore = useDisplayStore()

const messageId = computed(() => props.group.id)
const isUserMessage = computed(() => props.group.sender === 'user')
const senderLabel = computed(() => (isUserMessage.value ? 'User' : 'Model'))
const messageTimestamp = computed(() => {
  const createdAt = props.group?.message?.createdAt
  if (!createdAt) return ''
  try {
    const locale =
      typeof navigator !== 'undefined' && navigator.language
        ? navigator.language
        : undefined
    return new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(createdAt))
  } catch (error) {
    console.error('Failed to format message timestamp:', error)
    return ''
  }
})
const actionsDisabled = computed(() => chatStore.isGenerating)
const isEditing = computed(
  () => chatStore.editingState?.messageId === messageId.value
)
const editAreaReady = ref(false)

watch(isEditing, (newVal) => {
  if (!newVal) {
    editAreaReady.value = false
  }
})
const isStreaming = computed(
  () =>
    props.group.system.status === 'streaming' ||
    props.group.system.isStreamingThoughts
)
const isCancelled = computed(() => props.group.message.status === 'cancelled')
const hasSystemContent = computed(() => {
  const system = props.group.system
  return (
    system.indicators.length > 0 ||
    system.hasThoughts ||
    props.group.system.status === 'streaming'
  )
})
const shouldShowSystem = computed(() => {
  if (!displayStore.ui.showSystemBubble) return false
  if (!props.group.system?.shouldRender) return false
  return hasSystemContent.value
})
const contentBubbleClass = computed(() =>
  isUserMessage.value ? 'bubble-user' : 'bubble-model'
)

const metadataSegments = computed(() => {
  const html = props.group?.content?.metadataHtml || ''
  return html
    .split('\n')
    .map((segment) => segment.trim())
    .filter(Boolean)
})

const shouldShowContentBubble = computed(() => {
  if (isEditing.value && editAreaReady.value) return false
  return props.group.content.shouldRender
})

const defaultSystemSummary = computed(() => {
  if (isStreaming.value) return 'Streaming response'
  const status = props.group.system?.status
  if (status === 'error') return 'Generation failed'
  if (status === 'cancelled') return 'Generation cancelled'
  return 'No additional parameters'
})

const copyIcon = ref('copy')
const blobUrlCache = new Map()

// Duration Timer Logic
const elapsedTime = ref(0)
let timerInterval = null

const formatDuration = (ms) => {
  if (typeof ms !== 'number' || isNaN(ms)) return '- s'
  const totalSeconds = ms / 1000
  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(1)}s`
  }
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = Math.floor(totalSeconds % 60)
  return `${minutes}m ${seconds}s`
}

const durationDisplay = computed(() => {
  if (isStreaming.value) {
    return formatDuration(elapsedTime.value)
  }
  const duration = props.group.message?.metadata?.duration
  if (duration !== undefined && duration !== null) {
    return formatDuration(duration)
  }
  return '- s'
})

const updateTimer = () => {
  const createdAt = props.group.message?.createdAt
  if (createdAt) {
    elapsedTime.value = Date.now() - createdAt
  }
}

const startTimer = () => {
  if (timerInterval) clearInterval(timerInterval)
  updateTimer()
  timerInterval = setInterval(updateTimer, 100)
}

const stopTimer = () => {
  if (timerInterval) {
    clearInterval(timerInterval)
    timerInterval = null
  }
}

watch(
  isStreaming,
  (streaming) => {
    if (streaming) {
      startTimer()
    } else {
      stopTimer()
    }
  },
  { immediate: true }
)

onMounted(() => {
  if (isStreaming.value) {
    startTimer()
  }
})

onUnmounted(() => {
  stopTimer()
  for (const [, url] of blobUrlCache.entries()) {
    URL.revokeObjectURL(url)
  }
  blobUrlCache.clear()
})

const releaseStaleAttachmentUrls = (attachments) => {

  const nextIds = new Set()
  for (const att of attachments || []) {
    if (att?.id && att.blob) {
      nextIds.add(att.id)
    }
  }

  for (const [id, url] of blobUrlCache.entries()) {
    if (!nextIds.has(id)) {
      URL.revokeObjectURL(url)
      blobUrlCache.delete(id)
    }
  }
}

watch(
  () => props.group.content.attachments,
  (next) => {
    releaseStaleAttachmentUrls(Array.isArray(next) ? next : [])
  },
  { deep: true, immediate: true }
)

const toggleThoughts = () => {
  displayStore.toggleThoughtCollapse(props.group.id)
}

const copyContent = () => {
  if (copyIcon.value === 'check') return
  const textToCopy = props.group.message?.content?.text ?? ''
  navigator.clipboard
    .writeText(textToCopy)
    .then(() => {
      copyIcon.value = 'check'
      setTimeout(() => {
        copyIcon.value = 'copy'
      }, 2000)
    })
    .catch((error) => {
      console.error('Failed to copy text:', error)
    })
}

const getAttachmentUrl = (attachment) => {
  if (!attachment) return null
  if (attachment.remoteUri) return attachment.remoteUri
  if (!attachment.id) return null

  if (!attachment.blob) {
    return blobUrlCache.get(attachment.id) || null
  }

  if (blobUrlCache.has(attachment.id)) {
    return blobUrlCache.get(attachment.id)
  }

  const url = URL.createObjectURL(attachment.blob)
  blobUrlCache.set(attachment.id, url)
  return url
}

const attachmentTitle = (attachment) =>
  isExpired(attachment)
    ? `${attachment.name} (Expired)`
    : `Download ${attachment.name}`

const handleAttachmentClick = (attachment, event) => {
  if (isExpired(attachment)) {
    event.preventDefault()
    return
  }
  const isPreviewable =
    (attachment.mimeType?.startsWith('image/') ||
      attachment.mimeType?.startsWith('text/')) &&
    attachment.blob
  if (isPreviewable) {
    event.preventDefault()
    displayStore.openPreview(attachment.id)
  }
}

const isExpired = (attachment) => {
  if (!attachment.expirationTime) return false
  return new Date(attachment.expirationTime) < new Date()
}

onUnmounted(() => {
  for (const [, url] of blobUrlCache.entries()) {
    URL.revokeObjectURL(url)
  }
  blobUrlCache.clear()
})
</script>

<style scoped>
.message-wrapper {
  display: flex;
  flex-direction: column;
}

.message-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0 4px;
}

.sender-info {
  display: flex;
  align-items: end;
  gap: 8px;
}

.sender-name {
  font-weight: 600;
  font-size: 14px;
  color: var(--text-color);
}

.message-timestamp {
  font-size: 10px;
  color: var(--text-light);
}

.message-actions {
  display: flex;
  gap: 8px;
  opacity: 0;
  visibility: hidden;
  transition: var(--transition);
}

.message-wrapper:hover .message-actions {
  opacity: 1;
  visibility: visible;
}

.message-actions button {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-light);
  font-size: 12px;
  padding: 0px 4px;
}

.message-actions button:hover {
  color: var(--text-color);
}

.message-actions button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.message-body {
  display: flex;
  flex-direction: column;
}

.message-alert {
  margin-bottom: 12px;
  padding: 12px;
  border-radius: var(--border-radius);
  font-size: 14px;
}

.message-alert.error {
  background-color: rgba(220, 38, 38, 0.1);
  border: 1px solid rgba(220, 38, 38, 0.4);
  color: #dc2626;
}

.prose {
  font-size: 14px;
  line-height: 1.5;
  color: var(--text-color);
}

.plain-user-text {
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 14px;
  line-height: 1.5;
  color: var(--text-color);
}

.status-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: auto;
  min-width: 24px;
  height: 24px;
  padding: 0 6px;
  border-radius: 12px;
  color: var(--text-light);
  font-size: 11px;
  font-family: monospace;
  background-color: var(--bg-gray);
  transition:
    color 0.2s,
    background-color 0.2s;
}

.status-icon.streaming {
  color: var(--text-light);
  background-color: transparent;
}

.duration-text {
  white-space: nowrap;
  font-weight: 500;
}

.thought-stream {
  margin-top: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.thought-stream-header {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  background: none;
  border: none;
  color: inherit;
  text-align: left;
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;
}

.thought-stream-header.disabled {
  cursor: default;
  pointer-events: none;
}

.thought-stream-header.disabled:hover {
  background: none;
}

.thought-stream-header:hover {
  background-color: var(--bg-gray-stronger);
}

.thought-stream-header:focus-visible {
  outline: 2px solid var(--primary-color);
  outline-offset: 2px;
}

.system-summary {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--text-light);
  flex: 1;
}

.summary-item {
  display: flex;
  align-items: center;
  gap: 6px;
}

.summary-item svg {
  color: var(--text-light);
}

.summary-item--placeholder span {
  font-style: italic;
}

.thought-chevron {
  font-size: 12px;
  color: var(--text-light);
  flex-shrink: 0;
}

.thought-stream-header.disabled .thought-chevron {
  display: none;
}

.thought-stream-content {
  font-size: 13px;
  color: var(--text-color);
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 12px 12px;
}

.metadata {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  line-height: 1.3;
  color: var(--text-light);
  align-self: flex-start;
  max-width: 100%;
}

.metadata-item {
  display: block;
}

.metadata-item a {
  color: inherit;
  text-decoration: underline;
}

.attachment-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.attachment-chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background-color: var(--bot-message-bg);
  color: var(--text-color);
  padding: 6px 12px;
  box-shadow: var(--shadow-sm);
  border: 1px solid var(--border-color);
  border-radius: 16px;
  font-size: 13px;
  text-decoration: none;
  transition: var(--transition);
}

.attachment-chip:hover {
  background-color: var(--bg-grey);
}

.attachment-chip.expired {
  opacity: 0.5;
  cursor: not-allowed;
  filter: grayscale(80%);
}

.fade-enter-active,
.fade-leave-active {
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
