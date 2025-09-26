import { defineStore } from 'pinia'
import { watch } from 'vue'
import { useChatStore } from './chat'
import { parseModelResponse } from '../services/parser'
import { getProviderById } from '../services/providers'

const PREVIEWABLE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'text/plain',
  'text/markdown',
  'text/html',
  'text/css',
  'text/javascript',
  'application/json',
])

function providerForMessage(message) {
  const providerId = message?.configSnapshot?.providerId
  return getProviderById(providerId)
}

function buildIndicators(message) {
  const provider = providerForMessage(message)
  if (provider.buildDisplayIndicators) {
    return provider.buildDisplayIndicators(message)
  }
  return []
}

function buildMetadataHtml(message) {
  const provider = providerForMessage(message)
  if (provider.buildMetadataHtml) {
    return provider.buildMetadataHtml(message)
  }
  return ''
}

export const useDisplayStore = defineStore('display', {
  state: () => ({
    messageGroups: [],
    isPreviewOpen: false,
    previewableFiles: [],
    activePreviewFileId: null,
    ui: {
      showSystemBubble: true,
      collapsedThoughts: {},
      activeSystemBubbles: {},
    },
  }),

  getters: {
    activePreviewFile(state) {
      if (!state.activePreviewFileId) return null
      return (
        state.previewableFiles.find(
          (f) => f.id === state.activePreviewFileId
        ) || null
      )
    },
  },

  actions: {
    initializeWatcher() {
      if (this._stopWatcher) {
        this._stopWatcher()
      }

      const chatStore = useChatStore()
      let lastChatId = chatStore.activeChat?.id || null

      this._stopWatcher = watch(
        [() => chatStore.activeChat?.id, () => chatStore.activeMessages],
        async () => {
          const chatId = chatStore.activeChat?.id || null
          const chatChanged = chatId !== lastChatId
          lastChatId = chatId
          await this._syncFromMessages(chatStore.activeMessages || [], {
            chatChanged,
          })
        },
        { deep: true, immediate: true }
      )
    },

    setSystemVisibility(visible) {
      this.ui.showSystemBubble = !!visible
    },

    toggleSystemVisibility() {
      this.ui.showSystemBubble = !this.ui.showSystemBubble
    },

    toggleThoughtCollapse(messageId) {
      if (!messageId) return
      const current = this.isThoughtCollapsed(messageId)
      const nextValue = !current
      const nextState = {
        ...this.ui.collapsedThoughts,
        [messageId]: nextValue,
      }
      if (nextValue) {
        const rest = { ...this.ui.collapsedThoughts }
        delete rest[messageId]
        this.ui.collapsedThoughts = rest
      } else {
        this.ui.collapsedThoughts = nextState
      }
      this.messageGroups = this.messageGroups.map((group) =>
        group.id === messageId
          ? {
              ...group,
              system: {
                ...group.system,
                isCollapsed: nextValue,
              },
            }
          : group
      )
    },

    isThoughtCollapsed(messageId) {
      const stored = this.ui.collapsedThoughts[messageId]
      return stored === undefined ? true : !!stored
    },

    async _syncFromMessages(messages, { chatChanged = false } = {}) {
      if (!this._contentCache) this._contentCache = new Map()
      if (!this._thoughtCache) this._thoughtCache = new Map()

      if (chatChanged) {
        this.ui.collapsedThoughts = {}
        this.ui.activeSystemBubbles = {}
        this.activePreviewFileId = null
        this.isPreviewOpen = false
        this._contentCache.clear()
        this._thoughtCache.clear()
      }

      if (!messages.length) {
        this.messageGroups = []
        this.previewableFiles = []
        this.ui.activeSystemBubbles = {}
        return
      }

      const previousGroups = chatChanged
        ? new Map()
        : new Map(this.messageGroups.map((group) => [group.id, group]))

      const hasFreshUserMessage = messages.some(
        (message) =>
          message.sender === 'user' && !previousGroups.has(message.id)
      )

      const validIds = new Set(messages.map((m) => m.id))
      const nextActiveSystemBubbles = hasFreshUserMessage
        ? {}
        : { ...this.ui.activeSystemBubbles }

      const groups = []
      const previewable = []

      for (const message of messages) {
        const messageId = message.id
        const wasKnown = previousGroups.has(messageId)
        const isModelMessage = message.sender === 'model'

        if (isModelMessage) {
          const shouldActivate =
            !chatChanged && (!wasKnown || message.status === 'streaming')
          if (shouldActivate) {
            nextActiveSystemBubbles[messageId] = true
          }
        }

        const group = await this._buildMessageGroup(message)

        group.system.shouldRender =
          isModelMessage && !!nextActiveSystemBubbles[messageId]

        groups.push(group)

        for (const att of group.content.attachments) {
          if (!PREVIEWABLE_MIMES.has(att.mimeType)) continue
          if (previewable.some((f) => f.id === att.id)) continue
          previewable.push(att)
        }
      }

      this.messageGroups = groups
      this.previewableFiles = previewable

      if (
        this.isPreviewOpen &&
        !this.previewableFiles.some(
          (file) => file.id === this.activePreviewFileId
        )
      ) {
        this.closePreview()
      }

      for (const key of this._contentCache.keys()) {
        if (!validIds.has(key)) {
          this._contentCache.delete(key)
        }
      }
      for (const key of this._thoughtCache.keys()) {
        if (!validIds.has(key)) {
          this._thoughtCache.delete(key)
        }
      }

      const nextCollapsed = {}
      for (const [key, value] of Object.entries(this.ui.collapsedThoughts)) {
        if (validIds.has(key)) {
          nextCollapsed[key] = value
        }
      }
      this.ui.collapsedThoughts = nextCollapsed

      const nextActiveSystem = {}
      for (const [key, value] of Object.entries(nextActiveSystemBubbles)) {
        if (value && validIds.has(key)) {
          nextActiveSystem[key] = true
        }
      }
      this.ui.activeSystemBubbles = nextActiveSystem
    },

    async _buildMessageGroup(message) {
      const contentSegments = await this._getContentSegments(message)
      const thoughtSegments = await this._getThoughtSegments(message)

      const thoughtsState = message.runtime?.system?.thoughts || {}
      const system = {
        key: `${message.id}:system`,
        messageId: message.id,
        status: message.status,
        indicators: buildIndicators(message),
        thoughtSegments,
        hasThoughts: thoughtSegments.length > 0,
        isStreamingThoughts: !!thoughtsState.isStreaming,
        updatedAt: thoughtsState.updatedAt || null,
        isCollapsed: this.isThoughtCollapsed(message.id),
        shouldRender: false,
      }

      const content = {
        key: `${message.id}:content`,
        messageId: message.id,
        sender: message.sender,
        status: message.status,
        segments: contentSegments,
        attachments: message.attachments || [],
        metadataHtml:
          message.status === 'completed' ? buildMetadataHtml(message) : '',
      }

      return {
        id: message.id,
        sender: message.sender,
        message,
        system,
        content,
      }
    },

    async _getContentSegments(message) {
      const text = message?.content?.text ?? ''
      const marker = `${message?.updatedAt || message?.createdAt || ''}:${text.length}`
      const cacheEntry = this._contentCache.get(message.id)
      if (
        cacheEntry &&
        cacheEntry.marker === marker &&
        cacheEntry.text === text
      ) {
        return cacheEntry.segments
      }

      const segments = text ? await parseModelResponse(text) : []
      this._contentCache.set(message.id, {
        marker,
        text,
        segments,
      })
      return segments
    },

    async _getThoughtSegments(message) {
      const thoughts = message.runtime?.system?.thoughts?.rawText ?? ''
      if (!thoughts) return []
      const marker = `${message.runtime?.system?.thoughts?.updatedAt || thoughts.length}`
      const cacheEntry = this._thoughtCache.get(message.id)
      if (
        cacheEntry &&
        cacheEntry.marker === marker &&
        cacheEntry.text === thoughts
      ) {
        return cacheEntry.segments
      }

      const segments = await parseModelResponse(thoughts)
      this._thoughtCache.set(message.id, {
        marker,
        text: thoughts,
        segments,
      })
      return segments
    },

    openPreview(fileId) {
      if (this.previewableFiles.some((f) => f.id === fileId)) {
        this.activePreviewFileId = fileId
        this.isPreviewOpen = true
      }
    },

    closePreview() {
      this.isPreviewOpen = false
      this.activePreviewFileId = null
    },

    setActivePreviewFile(fileId) {
      if (this.previewableFiles.some((f) => f.id === fileId)) {
        this.activePreviewFileId = fileId
      }
    },
  },
})
