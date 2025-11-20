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
      const chatStore = useChatStore()
      chatStore.updateMessageUiFlags(
        messageId,
        nextValue
          ? { thoughtsCollapsed: undefined }
          : { thoughtsCollapsed: false }
      )
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
      if (!this._groupCache) this._groupCache = new Map()

      const chatStore = useChatStore()

      if (chatChanged) {
        this.ui.collapsedThoughts = {}
        this.ui.activeSystemBubbles = {}
        this.activePreviewFileId = null
        this.isPreviewOpen = false
        this._contentCache.clear()
        this._thoughtCache.clear()
        this._groupCache.clear()
      }

      if (!messages.length) {
        this.messageGroups = []
        this.previewableFiles = []
        this.ui.activeSystemBubbles = {}
        this.ui.collapsedThoughts = {}
        return
      }

      const previousCollapsed = { ...this.ui.collapsedThoughts }
      const previousActive = { ...this.ui.activeSystemBubbles }

      const validIds = new Set(messages.map((m) => m.id))
      const groups = []
      const previewable = []
      const nextActiveSystemBubbles = {}
      const nextCollapsedState = {}

      for (const message of messages) {
        const messageId = message.id
        const isModelMessage = message.sender === 'model'
        const uiFlags = message.uiFlags || {}

        // Determine collapsed state
        const hasPersistedCollapse = Object.prototype.hasOwnProperty.call(
          uiFlags,
          'thoughtsCollapsed'
        )
        let isCollapsed
        if (hasPersistedCollapse) {
          isCollapsed = uiFlags.thoughtsCollapsed !== false
        } else if (previousCollapsed[messageId] !== undefined) {
          isCollapsed = !!previousCollapsed[messageId]
        } else {
          isCollapsed = true
        }
        if (!isCollapsed) {
          nextCollapsedState[messageId] = false
        }

        // Determine active bubble state
        const hasPersistedActive = Object.prototype.hasOwnProperty.call(
          uiFlags,
          'systemBubbleActive'
        )
        let isActive = false
        // Check if we already know this message in the current view session
        // If we have a group cache for it, we can consider it "known" visually
        const wasKnown = this._groupCache.has(messageId)

        if (isModelMessage) {
          if (hasPersistedActive) {
            isActive = !!uiFlags.systemBubbleActive
          } else if (previousActive[messageId]) {
            isActive = true
          }
          // Auto-activate logic
          const shouldActivate =
            !chatChanged && (!wasKnown || message.status === 'streaming')
          if (shouldActivate && !isActive) {
            isActive = true
            chatStore.updateMessageUiFlags(messageId, {
              systemBubbleActive: true,
            })
          }
        }

        if (isActive) {
          nextActiveSystemBubbles[messageId] = true
        }

        // --- Group Reuse Logic ---
        const changeKey = this._generateChangeKey(message)
        let group
        const cached = this._groupCache.get(messageId)

        if (cached && cached.changeKey === changeKey) {
          group = cached.group
          // Update mutable properties that don't require rebuilding the group structure
          group.message = message // Update reference to latest message object
          group.system.isCollapsed = isCollapsed
          group.system.shouldRender = isModelMessage && isActive
        } else {
          group = await this._buildMessageGroup(message)
          group.system.isCollapsed = isCollapsed
          group.system.shouldRender = isModelMessage && isActive
          this._groupCache.set(messageId, { changeKey, group })
        }

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

      // Cleanup caches
      if (chatChanged) {
        this._groupCache.clear()
      } else {
        for (const key of this._groupCache.keys()) {
          if (!validIds.has(key)) {
            this._groupCache.delete(key)
          }
        }
      }
      // Content/Thought caches are used inside _buildMessageGroup, so we clean them up too
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

      this.ui.collapsedThoughts = nextCollapsedState
      this.ui.activeSystemBubbles = nextActiveSystemBubbles
    },

    _generateChangeKey(message) {
      // Generate a key that changes whenever the message display content needs re-evaluating.
      // We include properties that affect _buildMessageGroup output.
      const textLen = message.content?.text?.length ?? 0
      const thoughtLen = message.runtime?.system?.thoughts?.rawText?.length ?? 0
      const attachLen = message.attachments?.length ?? 0
      const indicatorCount = buildIndicators(message).length
      // We also need to consider UI flags that might change the group structure/content
      // Note: isCollapsed/shouldRender are injected AFTER group creation/retrieval,
      // so they don't strictly need to be in this key for the *inner* structure,
      // but if the provider logic depends on them, we might.
      // For now, we rely on the fact that isCollapsed/shouldRender are assigned purely in _syncFromMessages.
      
      return `${message.id}|${message.updatedAt}|${message.status}|${textLen}|${thoughtLen}|${attachLen}|${indicatorCount}`
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
        // These will be overridden in _syncFromMessages
        isCollapsed: true, 
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
        message, // Keep reference to raw message
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
