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
        <div v-if="errorText" class="message-alert error" role="alert">
          {{ errorText }}
        </div>
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
          :class="{ expired: isExpired(att), unsupported: isUnsupported(att) }"
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
import { useChatsStore } from '../stores/chats'
import { useComposerStore } from '../stores/composer'
import { useSessionStore } from '../stores/session'
import { useDisplayStore } from '../stores/display'
import CodeBlock from './CodeBlock.vue'
import EditArea from './EditArea.vue'
import {
  defaultSystemSummary as summaryFor,
  errorText as errorTextFor,
  formatDuration,
  formatTimestamp,
  senderLabel as labelFor,
} from '../services/messageView'
const emit = defineEmits(['edit', 'resend', 'delete'])

const props = defineProps({
  group: {
    type: Object,
    required: true,
  },
})

const chatStore = useChatsStore()
const composer = useComposerStore()
const session = useSessionStore()
const displayStore = useDisplayStore()

const messageId = computed(() => props.group.id)
const isUserMessage = computed(() => props.group.sender === 'user')
const senderLabel = computed(() => labelFor(props.group.sender))
const errorText = computed(() => errorTextFor(props.group.message))
const messageTimestamp = computed(() =>
  formatTimestamp(props.group?.message?.createdAt)
)
const actionsDisabled = computed(() => session.isGenerating)
const isEditing = computed(
  () => chatStore.editing?.messageId === messageId.value
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

const defaultSystemSummary = computed(() =>
  summaryFor(props.group.system?.status, isStreaming.value)
)

const copyIcon = ref('copy')
const blobUrlCache = new Map()

// Duration Timer Logic
const elapsedTime = ref(0)
let timerInterval = null

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
    : isUnsupported(attachment)
      ? `${attachment.name} (Unsupported by current model)`
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

const unsupportedFileIds = computed(() => {
  // Access capabilities to register reactive dependency on active model
  void composer.capabilities
  const bucket = composer.attachmentBucket
  if (!bucket) return new Set()

  const ids = new Set()
  for (const file of props.group?.content?.attachments || []) {
    if (bucket.isUnsupported?.(file)) {
      ids.add(file.id)
    }
  }
  return ids
})

const isUnsupported = (attachment) => {
  return unsupportedFileIds.value.has(attachment.id)
}
</script>
