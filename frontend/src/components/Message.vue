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
        <div class="system-status-row">
          <div class="status-icon" :class="{ streaming: isStreaming }">
            <font-awesome-icon
              :icon="isStreaming ? 'circle-notch' : ['far', 'circle']"
              :spin="isStreaming"
            />
          </div>
          <div class="system-summary">
            <span
              v-for="(indicator, index) in group.system.indicators"
              :key="`indicator-${group.id}-${index}`"
              class="summary-item"
            >
              <font-awesome-icon :icon="indicator.icon" />
              <span>{{ indicator.text }}</span>
            </span>
          </div>
        </div>

        <div
          v-if="group.system.hasThoughts"
          class="thought-stream"
          :class="{ collapsed: group.system.isCollapsed }"
        >
          <div class="thought-stream-header">
            <button
              class="toggle-thoughts"
              :aria-expanded="!group.system.isCollapsed"
              @click="toggleThoughts"
            >
              <font-awesome-icon
                :icon="group.system.isCollapsed ? 'chevron-down' : 'chevron-up'"
              />
            </button>
            <font-awesome-icon icon="cogs" />
            <span>Thoughts</span>
          </div>
          <transition name="fade">
            <div
              v-if="!group.system.isCollapsed"
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

      <EditArea v-else-if="isEditing" :message-id="messageId" />

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
import { computed, ref, onUnmounted, watch } from 'vue'
import { useChatStore } from '../stores/chat'
import { useDisplayStore } from '../stores/display'
import CodeBlock from './CodeBlock.vue'
import EditArea from './EditArea.vue'
import 'katex/dist/katex.min.css'
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

const hasContentSegments = computed(
  () =>
    Array.isArray(props.group?.content?.segments) &&
    props.group.content.segments.length > 0
)

const hasPlainTextContent = computed(() => {
  const rawText = props.group?.message?.content?.text
  return typeof rawText === 'string' && rawText.trim().length > 0
})

const hasAttachments = computed(
  () =>
    Array.isArray(props.group?.content?.attachments) &&
    props.group.content.attachments.length > 0
)

const hasMetadata = computed(
  () =>
    Array.isArray(metadataSegments.value) && metadataSegments.value.length > 0
)

const runtimeContent = computed(
  () => props.group?.message?.runtime?.content || null
)

const runtimeHasRenderableContent = computed(() => {
  const runtime = runtimeContent.value
  if (!runtime) {
    return (
      hasContentSegments.value ||
      hasPlainTextContent.value ||
      hasAttachments.value ||
      hasMetadata.value
    )
  }
  if (runtime.hasText || runtime.hasAttachments || runtime.hasMetadata) {
    return true
  }
  return (
    hasContentSegments.value ||
    hasPlainTextContent.value ||
    hasAttachments.value ||
    hasMetadata.value
  )
})

const isContentReady = computed(() => {
  if (isUserMessage.value) return true
  const runtime = runtimeContent.value
  if (!runtime) return runtimeHasRenderableContent.value
  if (runtime.isStreaming) {
    return !!runtime.isReady
  }
  return runtime.isReady || runtimeHasRenderableContent.value
})

const shouldShowContentBubble = computed(() => {
  if (isEditing.value) return false
  if (isUserMessage.value) return true
  return isContentReady.value
})

const copyIcon = ref('copy')
const blobUrlCache = new Map()

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

.system-bubble {
  background-color: var(--bg-color);
  color: var(--text-color);
}

.system-status-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

.status-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 9999px;
  color: var(--primary-color);
  font-size: 16px;
}

.status-icon.streaming {
  color: var(--primary-color);
}

.system-summary {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--text-light);
}

.summary-item {
  display: flex;
  align-items: center;
  gap: 6px;
}

.summary-item svg {
  color: var(--text-light);
}

.toggle-thoughts {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-light);
  padding: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.toggle-thoughts:hover {
  color: var(--text-color);
}

.thought-stream {
  margin-top: 8px;
  padding: 8px 12px;
  background-color: var(--bg-gray);
  border-radius: var(--border-radius);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.thought-stream.collapsed {
  opacity: 0.9;
}

.thought-stream-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--text-light);
}

.thought-stream-content {
  font-size: 13px;
  color: var(--text-color);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.bubble-user {
  background-color: var(--user-message-bg);
  color: var(--text-color);
  white-space: pre-wrap;
}

.bubble-model {
  background-color: var(--bot-message-bg);
  color: var(--text-color);
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
  padding-top: 8px;
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
