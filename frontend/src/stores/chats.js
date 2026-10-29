import { defineStore } from 'pinia'
import { toRaw } from 'vue'
import { v4 as uuidv4 } from 'uuid'
import * as db from '../services/db'
import { showErrorToast } from '../services/notification'
import { exportChatAsHTML } from '../services/htmlExporter'
import {
  hydrateMessages,
  normalizeAttachments,
  prepareMessageForState,
  isInvalidModelHistoryMessage,
  syncContentRuntimeFromMessage,
  setContentStreamingState,
} from '../services/chatFlow'
import { useChatConfigStore } from './chatConfig'
import { useComposerStore } from './composer'
import { useModelsStore } from './models'

const DEFAULT_TITLE = 'New Chat'
const TITLE_MAX_LEN = 30

function cloneChatMeta(meta) {
  if (!meta) return null
  return {
    id: meta.id,
    title: meta.title,
    createdAt: meta.createdAt,
    lastModified: meta.lastModified,
    isBookmarked: meta.isBookmarked ?? false,
  }
}

function sortMessagesBySequence(messages) {
  messages.sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
}

function sanitizeDownloadBaseName(title) {
  return (
    String(title || 'chat')
      .trim()
      .replace(/[<>:"/\\|?*]/g, '_')
      .split('')
      .filter((character) => character.charCodeAt(0) > 31)
      .join('')
      .replace(/\s+/g, '_')
      .slice(0, 100) || 'chat'
  )
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  try {
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
  } finally {
    a.remove()
    URL.revokeObjectURL(url)
  }
}

// The chat list, the open chat and its messages, and their persistence.
// Anything that must also stop a running generation lives in the session
// store, which calls into this one.
export const useChatsStore = defineStore('chats', {
  state: () => ({
    list: [],
    active: null, // { meta, messages }
    deletingIds: [],
    editing: null, // { messageId, draftText, attachmentBucket }
    scrollToken: 0,
  }),

  getters: {
    chatList: (state) => state.list,
    activeChat: (state) =>
      state.active ? cloneChatMeta(state.active.meta) : null,
    activeChatId: (state) => state.active?.meta?.id || null,
    activeMessages: (state) => state.active?.messages || [],
    isChatOpen: (state) => !!state.active,
    editorBucket: (state) => state.editing?.attachmentBucket || null,
    scrollSignal: (state) => state.scrollToken,
  },

  actions: {
    bumpScrollSignal() {
      this.scrollToken = (this.scrollToken + 1) % Number.MAX_SAFE_INTEGER
    },

    async refreshChatList() {
      this.list = await db.getChatList()
    },

    isDeleting(chatId) {
      return !!chatId && this.deletingIds.includes(chatId)
    },

    isActiveChat(chatId) {
      return (
        !!chatId && !this.isDeleting(chatId) && this.activeChatId === chatId
      )
    },

    _defaultSystemPrompt() {
      return (
        useModelsStore().settingsFor(useComposerStore().model).systemPrompt ||
        ''
      )
    },

    // Opens a chat without touching any running generation; callers that
    // navigate must stop it first (see the session store).
    async loadChat(chatId) {
      try {
        const chatDetails = await db.getChatDetails(chatId)
        if (this.isDeleting(chatId)) return
        if (!chatDetails) throw new Error('Chat not found')
        const { messages, autoMessages, settings, ...chatMeta } = chatDetails
        this.active = {
          meta: cloneChatMeta(chatMeta),
          messages: hydrateMessages(messages),
        }
        await this.reconcileInterruptedMessages()
        const chatConfigStore = useChatConfigStore()
        chatConfigStore.prepareForExistingChat(chatMeta.id, settings)
        chatConfigStore.loadAutoMessages(chatMeta.id, autoMessages)
        this.bumpScrollSignal()
      } catch (error) {
        console.error(`Failed to load chat ${chatId}:`, error)
        showErrorToast('Failed to load chat. It might be corrupted or deleted.')
        this.closeChat()
      }
    },

    // Leaves the open chat; the next message starts a new one.
    closeChat() {
      this.active = null
      const chatConfigStore = useChatConfigStore()
      chatConfigStore.prepareForNewChat({
        systemPrompt: this._defaultSystemPrompt(),
      })
      chatConfigStore.loadAutoMessages(null, { pre: [], post: [] })
    },

    async ensureActiveChat(promptText = '') {
      if (this.activeChatId) return this.activeChatId

      const chatConfigStore = useChatConfigStore()
      const chatMeta = {
        id: uuidv4(),
        title: (promptText || '').slice(0, TITLE_MAX_LEN) || DEFAULT_TITLE,
        createdAt: Date.now(),
        lastModified: Date.now(),
        isBookmarked: false,
      }

      await db.saveNewChat(chatMeta)

      this.active = {
        meta: chatMeta,
        messages: [],
      }

      this.ensureChatListEntry(chatMeta)

      chatConfigStore.commitPending(chatMeta.id)
      await chatConfigStore.persistSettings(chatMeta.id)
      await db.saveAutoMessages(
        chatMeta.id,
        chatConfigStore.serializeAutoMessages(chatMeta.id)
      )

      return chatMeta.id
    },

    ensureChatListEntry(chatMeta) {
      if (!chatMeta?.id) return
      const existing = this.list.find((c) => c.id === chatMeta.id)
      if (existing) {
        existing.title = chatMeta.title
        existing.lastModified = chatMeta.lastModified
        existing.isBookmarked = chatMeta.isBookmarked ?? false
      } else {
        this.list.unshift({
          id: chatMeta.id,
          title: chatMeta.title,
          lastModified: chatMeta.lastModified,
          isBookmarked: chatMeta.isBookmarked ?? false,
        })
      }
    },

    touchActiveChat() {
      if (!this.active?.meta) return
      const updated = {
        ...this.active.meta,
        lastModified: Date.now(),
      }
      this.active.meta = updated
      this.ensureChatListEntry(updated)
    },

    _applyChatMeta(meta) {
      this.ensureChatListEntry(meta)
      if (this.isActiveChat(meta?.id)) {
        this.active.meta = cloneChatMeta({
          ...this.active.meta,
          ...meta,
        })
      }
    },

    appendMessage(message) {
      if (!this.active) return
      this.active.messages.push(prepareMessageForState(message))
      sortMessagesBySequence(this.active.messages)
    },

    replaceMessage(message) {
      if (!this.active) return
      const idx = this.active.messages.findIndex((m) => m.id === message.id)
      if (idx === -1) return
      this.active.messages[idx] = prepareMessageForState(message)
      sortMessagesBySequence(this.active.messages)
    },

    removeMessage(messageId) {
      if (!this.active) return
      const idx = this.active.messages.findIndex((m) => m.id === messageId)
      if (idx !== -1) {
        this.active.messages.splice(idx, 1)
      }
    },

    findMessageById(messageId) {
      if (!this.active) return null
      return this.active.messages.find((m) => m.id === messageId) || null
    },

    findMessageByRequestId(requestId) {
      if (!requestId || !this.active) return null
      return this.active.messages.find((m) => m.requestId === requestId) || null
    },

    async _loadMessageFromDb(chatId, messageId) {
      try {
        const raw = await db.getMessageWithAttachments(chatId, messageId)
        if (!raw) return null
        const [hydrated] = hydrateMessages([raw])
        return hydrated || null
      } catch (error) {
        console.warn(
          'Failed to load message with attachments from IndexedDB:',
          messageId,
          error
        )
        return null
      }
    },

    async persistActiveMessage(message, options = {}) {
      if (!this.active || !message) return false
      const chatId = this.active.meta.id
      const isStreaming = message.status === 'streaming'
      setContentStreamingState(message, isStreaming)
      syncContentRuntimeFromMessage(message)
      message.updatedAt = Date.now()
      try {
        await db.updateMessage(chatId, toRaw(message), {
          touchChat: options.touchChat ?? true,
        })
        if (!this.isActiveChat(chatId)) return false

        // For edited messages, reload attachments from DB to ensure Blob consistency
        if (options.reloadAttachments) {
          const hydratedMessage = await this._loadMessageFromDb(
            chatId,
            message.id
          )
          if (!this.isActiveChat(chatId)) return false
          if (hydratedMessage) {
            this.replaceMessage(hydratedMessage)
            return true
          }
        }

        this.replaceMessage(message)
        return true
      } catch (error) {
        console.error('Failed to persist message state:', error)
        return false
      }
    },

    updateMessageUiFlags(messageId, partial = {}) {
      if (!this.active || !messageId) return
      if (!partial || typeof partial !== 'object') return
      const message = this.findMessageById(messageId)
      if (!message) return
      const current = { ...(message.uiFlags || {}) }
      let changed = false
      for (const [key, value] of Object.entries(partial)) {
        if (value === undefined) {
          if (Object.prototype.hasOwnProperty.call(current, key)) {
            delete current[key]
            changed = true
          }
          continue
        }
        if (current[key] !== value) {
          current[key] = value
          changed = true
        }
      }
      if (!changed) return
      message.uiFlags = current
      // Display-only state; don't let it reorder the chat list.
      void this.persistActiveMessage(message, { touchChat: false })
    },

    async cleanupMessages(chatId, messageIds, { warnPrefix } = {}) {
      const ids = Array.isArray(messageIds) ? messageIds.filter(Boolean) : []
      if (!chatId || !ids.length) return false

      if (this.activeChatId === chatId) {
        ids.forEach((id) => this.removeMessage(id))
      }

      try {
        await db.deleteMessages(chatId, ids)
      } catch (error) {
        console.warn(warnPrefix || 'Failed to clean messages:', ids, error)
        return false
      }

      if (this.isActiveChat(chatId)) {
        this.touchActiveChat()
      }
      return true
    },

    // Drops model messages left unfinished by an interrupted generation.
    async removeInterruptedMessages(chatId) {
      if (!chatId || this.activeChatId !== chatId) return false

      const invalidIds = this.active.messages
        .filter(isInvalidModelHistoryMessage)
        .map((message) => message.id)

      if (!invalidIds.length) return false

      return this.cleanupMessages(chatId, invalidIds, {
        warnPrefix: 'Failed to clean interrupted messages',
      })
    },

    async reconcileInterruptedMessages() {
      try {
        await this.removeInterruptedMessages(this.activeChatId)
      } catch (error) {
        console.warn('Failed to reconcile interrupted messages:', error)
      }
    },

    startEditing(messageId) {
      const message = this.findMessageById(messageId)
      if (!message) return

      const bucket = useComposerStore().createAttachmentBucket()
      bucket.replaceAll(
        normalizeAttachments(message.attachments ?? [], message.sender)
      )
      bucket.dropUnsupportedForCurrentPolicy?.()

      this.editing = {
        messageId,
        draftText: message.content?.text ?? '',
        attachmentBucket: bucket,
      }
    },

    cancelEditing() {
      this.editing = null
    },

    setEditingDraft(value) {
      if (!this.editing) return
      this.editing.draftText = value ?? ''
    },

    async saveEdit() {
      if (!this.editing || !this.active) return
      const message = this.findMessageById(this.editing.messageId)
      if (!message) {
        this.cancelEditing()
        return
      }

      const composer = useComposerStore()
      await useModelsStore().ensureModelCapabilities(
        composer.model,
        composer.providerId
      )
      this.editing.attachmentBucket.dropUnsupportedForCurrentPolicy?.()
      const attachmentIssue = this.editing.attachmentBucket.getBlockingIssue?.()
      if (attachmentIssue) {
        showErrorToast(attachmentIssue)
        return
      }

      // Keep unsupported attachments; they are only left out when sending.
      const attachments = this.editing.attachmentBucket.list()

      const updated = {
        ...message,
        content: { text: this.editing.draftText },
        attachments,
        updatedAt: Date.now(),
      }

      const persisted = await this.persistActiveMessage(updated, {
        reloadAttachments: true,
      })
      if (persisted) {
        this.touchActiveChat()
      } else {
        showErrorToast('Failed to save changes.')
      }
      this.cancelEditing()
    },

    async deleteMessage(messageId) {
      if (!this.active) return
      const message = this.findMessageById(messageId)
      if (!message) return

      try {
        await db.deleteMessage(this.active.meta.id, messageId)
        this.removeMessage(messageId)
        this.touchActiveChat()
      } catch (error) {
        console.error('Failed to delete message:', error)
        showErrorToast('Failed to delete message.')
      }
    },

    async updateTitle(newTitle) {
      const chatId = this.activeChatId
      const title = newTitle?.trim()
      if (!chatId || !title || this.active.meta.title === title) return

      const oldTitle = this.active.meta.title
      this.active.meta.title = title
      const item = this.list.find((c) => c.id === chatId)
      if (item) item.title = title

      try {
        const meta = await db.updateChatMetadata(chatId, { title })
        if (this.isDeleting(chatId)) return
        this._applyChatMeta(meta)
      } catch (error) {
        console.error('Failed to update title:', error)
        showErrorToast('Failed to update chat title.')
        if (this.isActiveChat(chatId)) {
          this.active.meta.title = oldTitle
        }
        if (item) item.title = oldTitle
      }
    },

    async toggleBookmark(chatId) {
      const chat = this.list.find((c) => c.id === chatId)
      if (!chat) return

      const oldBookmarkState = chat.isBookmarked
      const newBookmarkState = !oldBookmarkState
      chat.isBookmarked = newBookmarkState
      if (this.activeChatId === chatId) {
        this.active.meta.isBookmarked = newBookmarkState
      }

      try {
        // Bookmarking isn't an edit, so keep the chat's position in history.
        await db.updateChatMetadata(
          chatId,
          { isBookmarked: newBookmarkState },
          { touch: false }
        )
      } catch (error) {
        console.error('Failed to toggle bookmark:', error)
        showErrorToast('Failed to update bookmark.')
        chat.isBookmarked = oldBookmarkState
        if (this.activeChatId === chatId) {
          this.active.meta.isBookmarked = oldBookmarkState
        }
      }
    },

    // Deletes the stored chat and forgets it; navigating away from it is the
    // caller's job.
    async removeChat(chatId) {
      await db.deleteChat(chatId)
      this.list = this.list.filter((chat) => chat.id !== chatId)
      useChatConfigStore().clearChatSettings(chatId)
    },

    async saveChatSettings(chatId, title) {
      if (!chatId || this.isDeleting(chatId)) return
      const config = useChatConfigStore()
      await config.persistSettings(chatId)
      await config.persistAutoMessages(chatId)
      const trimmedTitle = title?.trim()
      const meta = await db.updateChatMetadata(
        chatId,
        trimmedTitle ? { title: trimmedTitle } : {}
      )
      if (this.isDeleting(chatId)) return
      this._applyChatMeta(meta)
    },

    async cloneChat(chatId) {
      const { newChatId } = await db.cloneChat(chatId)
      await this.refreshChatList()
      return newChatId
    },

    async downloadChatAsHTML(chatId) {
      const active = this.active
      if (!active || active.meta.id !== chatId) {
        throw new Error('Chat is no longer active')
      }
      const chat = cloneChatMeta(active.meta)
      const messages = [...active.messages]
      const htmlContent = await exportChatAsHTML(chat, messages)
      const blob = new Blob([htmlContent], { type: 'text/html' })
      downloadBlob(blob, `${sanitizeDownloadBaseName(chat.title)}.html`)
    },

    async downloadChatAsZIP(chatId, title) {
      const blob = await db.exportArchive({
        kind: 'selected',
        chatIds: [chatId],
      })
      downloadBlob(blob, `${sanitizeDownloadBaseName(title)}.zip`)
    },
  },
})
