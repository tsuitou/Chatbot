import { defineStore } from 'pinia'
import { toRaw } from 'vue'
import { v4 as uuidv4 } from 'uuid'
import * as db from '../services/db'
import * as apiAdapter from '../services/apiAdapter'
import { startGeneration } from '../services/socket'
import { showErrorToast } from '../services/notification'
import { exportChatAsHTML } from '../services/htmlExporter'
import {
  normalizeSettingsEntry,
  cloneSettings as cloneModelSettings,
} from '../services/modelConfig'
import { getDefaultProviderId } from '../services/providers'
import { createAttachmentBucket } from '../services/attachments'
import { useChatConfigStore } from './chatConfig'
import { applyResponseTransforms } from '../services/responseTransforms'
import { useDebugStore } from './debug'
import {
  createModelMessage,
  createUserMessage,
  hydrateMessages,
  cloneConfigSnapshot,
  normalizeAttachments,
  prepareRequestMessages,
  cloneRuntime,
  createInitialRuntime,
} from '../services/chatFlow'

const DEFAULT_TITLE = 'New Chat'
const TITLE_MAX_LEN = 30

const GenerationStatus = Object.freeze({
  IDLE: 'idle',
  STREAMING: 'streaming',
  ERROR: 'error',
})

function recordDebugRequest(payload) {
  if (!import.meta.env.DEV) return
  try {
    const debugStore = useDebugStore()
    debugStore.recordRequest(payload)
  } catch (error) {
    console.error('Failed to record debug request:', error)
  }
}

function readModelSettings(model, version, fallbackProviderId) {
  void version
  const all = JSON.parse(localStorage.getItem('modelSettings') || '{}')
  const raw = model && all[model] ? all[model] : null
  return normalizeSettingsEntry(raw, { fallbackProviderId })
}

function sortMessagesBySequence(messages) {
  messages.sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
}

function nextSequence(messages) {
  if (!messages.length) return 10
  const maxSequence = Math.max(...messages.map((m) => m.sequence ?? 0))
  return maxSequence + 10
}

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

function createDefaultContentRuntimeState() {
  return {
    isStreaming: false,
    hasText: false,
    hasAttachments: false,
    hasMetadata: false,
    isReady: false,
    updatedAt: null,
  }
}

function ensureContentRuntime(message) {
  if (!message) return createDefaultContentRuntimeState()
  message.runtime = message.runtime || createInitialRuntime()
  if (!message.runtime.content) {
    message.runtime.content = createDefaultContentRuntimeState()
  }
  return message.runtime.content
}

function syncContentRuntimeFromMessage(message) {
  const runtimeContent = ensureContentRuntime(message)
  const text = message?.content?.text ?? ''
  runtimeContent.hasText = text.trim().length > 0
  runtimeContent.hasAttachments = Array.isArray(message?.attachments)
    ? message.attachments.length > 0
    : false
  const metadata = message?.metadata ?? {}
  runtimeContent.hasMetadata = Object.keys(metadata).some((key) => {
    const value = metadata[key]
    if (value === null || value === undefined) return false
    if (typeof value === 'string') return value.trim().length > 0
    if (typeof value === 'object') return Object.keys(value).length > 0
    return true
  })
  const referenceTime = message?.updatedAt ?? Date.now()
  runtimeContent.updatedAt = referenceTime
  if (
    runtimeContent.hasText ||
    runtimeContent.hasAttachments ||
    runtimeContent.hasMetadata
  ) {
    runtimeContent.isReady = true
  }
  return runtimeContent
}

function setContentStreamingState(message, isStreaming) {
  const runtimeContent = ensureContentRuntime(message)
  runtimeContent.isStreaming = !!isStreaming
  runtimeContent.updatedAt = Date.now()
  return runtimeContent
}

function normalizeMessageForState(message) {
  return {
    ...message,
    attachments: normalizeAttachments(
      message.attachments ?? [],
      message.sender
    ),
    configSnapshot: cloneConfigSnapshot(message.configSnapshot),
    metadata: { ...(message.metadata ?? {}) },
    uiFlags: { ...(message.uiFlags ?? {}) },
    runtime: cloneRuntime(message.runtime),
  }
}

export const useChatStore = defineStore('chat', {
  state: () => ({
    appState: {
      initialized: false,
      availableModels: [],
      defaultModel: null,
      modelSettingsVersion: 0,
    },
    chatState: {
      list: [],
      active: null, // { meta, messages }
    },
    generationState: {
      status: GenerationStatus.IDLE,
      stream: null,
      lastError: null,
    },
    composerState: {
      prompt: '',
      model: null,
      streamingEnabled: true,
      tools: {
        useUrlContext: true,
        useGrounding: false,
        useCodeExecution: false,
      },
      providerId: getDefaultProviderId(),
      attachmentBucket: createAttachmentBucket(),
    },
    editingState: null,
    uiSignals: {
      scrollToken: 0,
    },
  }),

  getters: {
    availableModels: (state) => state.appState.availableModels,
    defaultModel: (state) => state.appState.defaultModel,
    chatList: (state) => state.chatState.list,
    activeChat(state) {
      return state.chatState.active
        ? cloneChatMeta(state.chatState.active.meta)
        : null
    },
    activeMessages(state) {
      return state.chatState.active?.messages || []
    },
    isChatOpen(state) {
      return !!state.chatState.active
    },
    composerBucket(state) {
      return state.composerState.attachmentBucket
    },
    editorBucket(state) {
      return state.editingState?.attachmentBucket || null
    },
    promptText: (state) => state.composerState.prompt,
    scrollSignal: (state) => state.uiSignals.scrollToken,
    isGenerating(state) {
      return state.generationState.status === GenerationStatus.STREAMING
    },
    currentRequestConfig(state) {
      const model = state.composerState.model
      const streaming = state.composerState.streamingEnabled
      const fallbackProviderId =
        state.composerState.providerId || getDefaultProviderId()
      const normalized = readModelSettings(
        model,
        state.appState.modelSettingsVersion,
        fallbackProviderId
      )
      const settings = cloneModelSettings(normalized)
      const providerId = settings.providerId || fallbackProviderId
      const chatConfigStore = useChatConfigStore()
      const activeChatId = state.chatState.active?.meta?.id || null
      const systemInstruction = chatConfigStore.getSystemPrompt(activeChatId)
      return {
        providerId,
        model,
        tools: { ...state.composerState.tools },
        parameters: { ...settings.parameters },
        options: { ...settings.options },
        systemInstruction,
        streaming,
      }
    },
  },

  actions: {
    setAvailableModels(models) {
      this.appState.availableModels = Array.isArray(models) ? [...models] : []
    },

    setDefaultModel(model) {
      this.appState.defaultModel = typeof model === 'string' ? model : null
      if (!this.composerState.model && this.appState.defaultModel) {
        this.composerState.model = this.appState.defaultModel
      }
    },

    setActiveModel(model) {
      this.composerState.model = typeof model === 'string' ? model : null
    },

    setStreamingEnabled(enabled) {
      this.composerState.streamingEnabled = !!enabled
    },

    setProviderId(providerId) {
      this.composerState.providerId = providerId || getDefaultProviderId()
    },

    setPrompt(value) {
      this.composerState.prompt = value ?? ''
    },

    updateTool(name, value) {
      if (
        !Object.prototype.hasOwnProperty.call(this.composerState.tools, name)
      ) {
        return
      }
      this.composerState.tools = {
        ...this.composerState.tools,
        [name]: !!value,
      }
    },

    toggleTool(name) {
      if (
        !Object.prototype.hasOwnProperty.call(this.composerState.tools, name)
      ) {
        return
      }
      this.composerState.tools = {
        ...this.composerState.tools,
        [name]: !this.composerState.tools[name],
      }
    },

    bumpScrollSignal() {
      this.uiSignals.scrollToken =
        (this.uiSignals.scrollToken + 1) % Number.MAX_SAFE_INTEGER
    },

    refreshModelSettings() {
      this.appState.modelSettingsVersion += 1
    },

    async initializeApp() {
      try {
        this.chatState.list = await db.getChatList()
      } catch (error) {
        console.error('Failed to initialize app:', error)
        showErrorToast('Failed to load chat list. Please try again.')
      } finally {
        this.appState.initialized = true
      }
    },

    async refreshChatList() {
      this.chatState.list = await db.getChatList()
    },

    async ensureActiveChat(promptText = '') {
      if (this.chatState.active?.meta?.id) {
        return this.chatState.active.meta.id
      }

      const chatConfigStore = useChatConfigStore()
      const chatMeta = {
        id: uuidv4(),
        title: (promptText || '').slice(0, TITLE_MAX_LEN) || DEFAULT_TITLE,
        createdAt: Date.now(),
        lastModified: Date.now(),
        isBookmarked: false,
      }

      await db.saveNewChat(chatMeta)

      this.chatState.active = {
        meta: chatMeta,
        messages: [],
      }

      this._ensureChatListEntry(chatMeta)

      chatConfigStore.commitPending(chatMeta.id)
      await chatConfigStore.persistSettings(chatMeta.id)
      await db.saveAutoMessages(
        chatMeta.id,
        chatConfigStore.serializeAutoMessages(chatMeta.id)
      )

      return chatMeta.id
    },

    _ensureChatListEntry(chatMeta) {
      if (!chatMeta?.id) return
      const existing = this.chatState.list.find((c) => c.id === chatMeta.id)
      if (existing) {
        existing.title = chatMeta.title
        existing.lastModified = chatMeta.lastModified
        existing.isBookmarked = chatMeta.isBookmarked ?? false
      } else {
        this.chatState.list.unshift({
          id: chatMeta.id,
          title: chatMeta.title,
          lastModified: chatMeta.lastModified,
          isBookmarked: chatMeta.isBookmarked ?? false,
        })
      }
    },

    _touchActiveChat() {
      if (!this.chatState.active?.meta) return
      const ts = Date.now()
      const updated = {
        ...this.chatState.active.meta,
        lastModified: ts,
      }
      this.chatState.active.meta = updated
      this._ensureChatListEntry(updated)
    },

    _setActiveMessages(messages) {
      if (!this.chatState.active) return
      this.chatState.active.messages = hydrateMessages(messages)
      this.bumpScrollSignal()
    },

    _appendMessage(message) {
      if (!this.chatState.active) return
      this.chatState.active.messages.push(normalizeMessageForState(message))
      sortMessagesBySequence(this.chatState.active.messages)
    },

    _replaceMessage(message) {
      if (!this.chatState.active) return
      const idx = this.chatState.active.messages.findIndex(
        (m) => m.id === message.id
      )
      if (idx === -1) return
      this.chatState.active.messages[idx] = normalizeMessageForState(message)
      sortMessagesBySequence(this.chatState.active.messages)
    },

    _removeMessage(messageId) {
      if (!this.chatState.active) return
      const idx = this.chatState.active.messages.findIndex(
        (m) => m.id === messageId
      )
      if (idx !== -1) {
        this.chatState.active.messages.splice(idx, 1)
      }
    },

    _findMessageById(messageId) {
      if (!this.chatState.active) return null
      return (
        this.chatState.active.messages.find((m) => m.id === messageId) || null
      )
    },

    _findMessageByRequestId(requestId) {
      if (!requestId || !this.chatState.active) return null
      return (
        this.chatState.active.messages.find((m) => m.requestId === requestId) ||
        null
      )
    },

    async _persistActiveMessage(message) {
      if (!this.chatState.active || !message) return false
      const isStreaming = message.status === 'streaming'
      setContentStreamingState(message, isStreaming)
      syncContentRuntimeFromMessage(message)
      message.updatedAt = Date.now()
      try {
        await db.updateMessage(this.chatState.active.meta.id, toRaw(message))
        this._replaceMessage(message)
        return true
      } catch (error) {
        console.error('Failed to persist message state:', error)
        return false
      }
    },

    async loadChat(chatId) {
      if (!chatId) return
      this.cancelEditing()
      if (this.chatState.active?.meta?.id === chatId) {
        return
      }
      if (this.isGenerating) {
        await this.cancelGeneration()
      }

      try {
        const chatDetails = await db.getChatDetails(chatId)
        if (!chatDetails) throw new Error('Chat not found')
        const { messages, autoMessages, settings, ...chatMeta } = chatDetails
        this.chatState.active = {
          meta: cloneChatMeta(chatMeta),
          messages: hydrateMessages(messages),
        }
        const chatConfigStore = useChatConfigStore()
        chatConfigStore.prepareForExistingChat(chatMeta.id, settings)
        chatConfigStore.loadAutoMessages(chatMeta.id, autoMessages)
        this.bumpScrollSignal()
      } catch (error) {
        console.error(`Failed to load chat ${chatId}:`, error)
        showErrorToast('Failed to load chat. It might be corrupted or deleted.')
        this.chatState.active = null
        const chatConfigStore = useChatConfigStore()
        chatConfigStore.prepareForNewChat({
          systemPrompt: this._getDefaultSystemPrompt(),
        })
        chatConfigStore.loadAutoMessages(null, { pre: [], post: [] })
      }
    },

    async prepareNewChat() {
      if (this.isGenerating) {
        await this.cancelGeneration()
      }
      this.cancelEditing()
      this.chatState.active = null
      this.composerState.prompt = ''
      this.composerState.attachmentBucket.clear()
      const chatConfigStore = useChatConfigStore()
      chatConfigStore.prepareForNewChat({
        systemPrompt: this._getDefaultSystemPrompt(),
      })
      chatConfigStore.loadAutoMessages(null, { pre: [], post: [] })
    },

    _getDefaultSystemPrompt() {
      const model = this.composerState.model
      const fallbackProviderId =
        this.composerState.providerId || getDefaultProviderId()
      const normalized = readModelSettings(
        model,
        this.appState.modelSettingsVersion,
        fallbackProviderId
      )
      const settings = cloneModelSettings(normalized)
      return settings.systemPrompt || ''
    },

    _setGenerationState(status, stream = null, error = null) {
      this.generationState = {
        status,
        stream,
        lastError: error,
      }
    },

    async sendMessage() {
      const prompt = this.composerState.prompt || ''
      const requestConfig = this.currentRequestConfig

      this.cancelEditing()

      if (!requestConfig.model) {
        showErrorToast('Please select a model before sending.')
        return
      }

      const chatConfigStore = useChatConfigStore()
      const attachments = this.composerState.attachmentBucket.list()
      const tempMessageIds = []

      try {
        const chatId = await this.ensureActiveChat(prompt)
        if (!chatId) throw new Error('Active chat not available')

        const messages = this.activeMessages
        const userSequence = nextSequence(messages)
        const userMessage = createUserMessage({
          sequence: userSequence,
          text: prompt,
          attachments,
          configSnapshot: requestConfig,
        })
        setContentStreamingState(userMessage, false)
        syncContentRuntimeFromMessage(userMessage)
        await db.saveMessage(chatId, userMessage)
        tempMessageIds.push(userMessage.id)
        const storedUser = await db.getMessageWithAttachments(
          chatId,
          userMessage.id
        )
        this._appendMessage(storedUser ?? userMessage)

        const modelSequence = nextSequence(this.activeMessages)
        const requestId = uuidv4()
        const modelMessage = createModelMessage({
          sequence: modelSequence,
          requestId,
          configSnapshot: requestConfig,
        })
        setContentStreamingState(modelMessage, true)
        syncContentRuntimeFromMessage(modelMessage)
        await db.saveMessage(chatId, modelMessage)
        tempMessageIds.push(modelMessage.id)
        const storedModel = await db.getMessageWithAttachments(
          chatId,
          modelMessage.id
        )
        this._appendMessage(storedModel ?? modelMessage)
        this.bumpScrollSignal()

        this._setGenerationState(GenerationStatus.STREAMING, {
          messageId: modelMessage.id,
          requestId,
          providerId: requestConfig.providerId,
        })
        this.composerState.prompt = ''
        this.composerState.attachmentBucket.clear()
        this._touchActiveChat()
        this.bumpScrollSignal()

        const historyMessages = this.activeMessages.filter(
          (m) => (m.sequence ?? 0) <= userSequence
        )
        const autoMessages = chatConfigStore.serializeAutoMessages(chatId)
        const requestMessages = prepareRequestMessages({
          historyMessages,
          autoMessages,
          anchorSequence: userSequence,
        })

        const payload = await apiAdapter.createApiRequest({
          chatId,
          messages: requestMessages,
          model: requestConfig.model,
          requestConfig,
          streaming: requestConfig.streaming,
          requestId,
        })

        const activeChatId = this.chatState.active?.meta?.id
        const currentStream = this.generationState.stream
        const trackedMessage = this._findMessageById(modelMessage.id)
        const isSameRequest =
          currentStream?.requestId === requestId &&
          currentStream?.messageId === modelMessage.id

        if (
          activeChatId !== chatId ||
          this.generationState.status !== GenerationStatus.STREAMING ||
          !isSameRequest ||
          !trackedMessage ||
          trackedMessage.status !== 'streaming' ||
          trackedMessage.requestId !== requestId
        ) {
          return
        }

        recordDebugRequest(payload)
        startGeneration(payload)
      } catch (error) {
        console.error('Failed to send message:', error)
        showErrorToast('Failed to send message. Please try again.')
        this._setGenerationState(GenerationStatus.ERROR, null, error)

        if (this.chatState.active?.meta?.id && tempMessageIds.length) {
          for (const id of tempMessageIds) {
            try {
              await db.deleteMessage(this.chatState.active.meta.id, id)
            } catch (cleanupError) {
              console.warn('Cleanup failed for message', id, cleanupError)
            }
          }
        }
        tempMessageIds.forEach((id) => this._removeMessage(id))
      }
    },

    async handleStreamChunk(rawChunk) {
      if (!this.chatState.active || !this.isGenerating) return
      if (rawChunk.chatId !== this.chatState.active.meta.id) return
      const stream = this.generationState.stream
      if (!stream || stream.requestId !== rawChunk.requestId) return

      const message = this._findMessageByRequestId(stream.requestId)
      if (!message) return

      const providerId = stream.providerId || getDefaultProviderId()
      const parsed = apiAdapter.parseApiResponse(rawChunk, providerId) || {}

      const deltaText =
        parsed.deltaText ??
        rawChunk.deltaText ??
        rawChunk.delta?.text ??
        rawChunk.text ??
        ''

      setContentStreamingState(message, true)

      if (deltaText) {
        message.content = {
          ...message.content,
          text: `${message.content?.text || ''}${deltaText}`,
        }
      }

      const newAttachments = [
        ...(parsed.newAttachments || []),
        ...(rawChunk.delta?.attachments || []),
        ...(rawChunk.attachments || []),
      ]
      if (newAttachments.length) {
        const existing = normalizeAttachments(
          message.attachments || [],
          message.sender
        )
        message.attachments = normalizeAttachments(
          [...existing, ...newAttachments],
          message.sender
        )
      }

      const thoughtDelta =
        parsed.thoughtDelta ?? rawChunk.delta?.thoughts ?? rawChunk.thoughts
      if (thoughtDelta) {
        message.runtime = message.runtime || {}
        message.runtime.system = message.runtime.system || {}
        message.runtime.system.thoughts = {
          rawText: `${message.runtime.system.thoughts?.rawText || ''}${thoughtDelta}`,
          updatedAt: Date.now(),
          isStreaming: true,
        }
      }

      const metadata = { ...(message.metadata || {}) }

      if (parsed.metadata) {
        Object.assign(metadata, parsed.metadata)
      } else if (rawChunk.metadata) {
        Object.assign(metadata, rawChunk.metadata)
      }

      if (!metadata.usage) {
        const usage =
          parsed.metadata?.usage ||
          rawChunk.metadata?.usage ||
          rawChunk.usage ||
          rawChunk.delta?.usage
        if (usage) {
          metadata.usage = usage
        }
      }

      if (parsed.finishReason || rawChunk.finishReason) {
        metadata.finishReason = parsed.finishReason || rawChunk.finishReason
      }

      if (Object.keys(metadata).length) {
        message.metadata = metadata
      }

      syncContentRuntimeFromMessage(message)

      message.updatedAt = Date.now()
    },

    async handleStreamEnd(result) {
      if (!this.chatState.active) return
      if (result.chatId !== this.chatState.active.meta.id) return
      const stream = this.generationState.stream
      if (!stream || stream.requestId !== result.requestId) return
      const message = this._findMessageByRequestId(result.requestId)
      if (!message) return

      message.status = 'completed'
      if (message.runtime?.system?.thoughts) {
        message.runtime.system.thoughts.isStreaming = false
        message.runtime.system.thoughts.updatedAt = Date.now()
      }
      ensureContentRuntime(message).isReady = true
      if (result.finishReason) {
        message.metadata = {
          ...message.metadata,
          finishReason: result.finishReason,
        }
      }

      const chatConfigStore = useChatConfigStore()
      const transforms = chatConfigStore.getResponseTransforms(
        this.chatState.active.meta.id
      )
      if (
        message.content?.text !== undefined &&
        Array.isArray(transforms) &&
        transforms.length
      ) {
        const patched = applyResponseTransforms(
          message.content.text,
          transforms
        )
        message.content = { ...message.content, text: patched }
      }

      await this._persistActiveMessage(message)
      this._setGenerationState(GenerationStatus.IDLE)
      this._touchActiveChat()
    },

    async handleStreamError(rawError) {
      if (!this.chatState.active) return
      if (rawError.chatId !== this.chatState.active.meta.id) return
      const stream = this.generationState.stream
      if (!stream || stream.requestId !== rawError.requestId) return
      const message = this._findMessageByRequestId(rawError.requestId)
      if (!message) return

      message.status = 'completed'
      message.metadata = {
        ...message.metadata,
        finishReason: 'error',
        error: rawError?.error || rawError?.message || 'Unknown error',
      }
      if (message.runtime?.system?.thoughts) {
        message.runtime.system.thoughts.isStreaming = false
        message.runtime.system.thoughts.updatedAt = Date.now()
      }
      ensureContentRuntime(message).isReady = true

      await this._persistActiveMessage(message)
      this._setGenerationState(GenerationStatus.ERROR, null, rawError)

      showErrorToast(
        rawError?.error || rawError?.message || 'An unexpected error occurred.'
      )
    },

    async cancelGeneration() {
      if (!this.isGenerating || !this.chatState.active) return

      const stream = this.generationState.stream
      if (!stream?.messageId) {
        this._setGenerationState(GenerationStatus.IDLE)
        return
      }

      const message = this._findMessageById(stream.messageId)
      if (!message) {
        this._setGenerationState(GenerationStatus.IDLE)
        return
      }

      message.status = 'cancelled'
      message.content = { text: '' }
      message.attachments = []
      message.metadata = {}
      message.requestId = null
      if (message.runtime?.system?.thoughts) {
        message.runtime.system.thoughts = {
          rawText: '',
          updatedAt: Date.now(),
          isStreaming: false,
        }
      }
      ensureContentRuntime(message).isReady = true

      await this._persistActiveMessage(message)
      this._setGenerationState(GenerationStatus.IDLE)
    },

    startEditing(messageId) {
      const message = this._findMessageById(messageId)
      if (!message) return

      const bucket = createAttachmentBucket()
      bucket.replaceAll(
        normalizeAttachments(message.attachments ?? [], message.sender)
      )

      this.editingState = {
        messageId,
        draftText: message.content?.text ?? '',
        attachmentBucket: bucket,
      }
    },

    cancelEditing() {
      this.editingState = null
    },

    setEditingDraft(value) {
      if (!this.editingState) return
      this.editingState.draftText = value ?? ''
    },

    async saveEdit() {
      if (!this.editingState || !this.chatState.active) return
      const message = this._findMessageById(this.editingState.messageId)
      if (!message) {
        this.cancelEditing()
        return
      }

      const updated = {
        ...message,
        content: { text: this.editingState.draftText },
        attachments: normalizeAttachments(
          this.editingState.attachmentBucket.list(),
          message.sender
        ),
        updatedAt: Date.now(),
      }

      const persisted = await this._persistActiveMessage(updated)
      if (persisted) {
        this._touchActiveChat()
      } else {
        showErrorToast('Failed to save changes.')
      }
      this.cancelEditing()
    },

    async deleteMessage(messageId) {
      if (!this.chatState.active) return
      const message = this._findMessageById(messageId)
      if (!message) return

      try {
        await db.deleteMessage(this.chatState.active.meta.id, messageId)
        this._removeMessage(messageId)
        this._touchActiveChat()
      } catch (error) {
        console.error('Failed to delete message:', error)
        showErrorToast('Failed to delete message.')
      }
    },

    async updateTitle(newTitle) {
      if (
        !this.chatState.active ||
        this.chatState.active.meta.title === newTitle
      )
        return

      const oldTitle = this.chatState.active.meta.title
      this.chatState.active.meta.title = newTitle
      const item = this.chatState.list.find(
        (c) => c.id === this.chatState.active.meta.id
      )
      if (item) item.title = newTitle

      try {
        await db.updateChatMetadata(this.chatState.active.meta.id, {
          title: newTitle,
        })
      } catch (error) {
        console.error('Failed to update title:', error)
        showErrorToast('Failed to update chat title.')
        this.chatState.active.meta.title = oldTitle
        if (item) item.title = oldTitle
      }
    },

    async toggleBookmark(chatId) {
      const chat = this.chatState.list.find((c) => c.id === chatId)
      if (!chat) return

      const oldBookmarkState = chat.isBookmarked
      const newBookmarkState = !oldBookmarkState
      chat.isBookmarked = newBookmarkState
      if (this.chatState.active?.meta?.id === chatId) {
        this.chatState.active.meta.isBookmarked = newBookmarkState
      }

      try {
        await db.updateChatMetadata(chatId, { isBookmarked: newBookmarkState })
      } catch (error) {
        console.error('Failed to toggle bookmark:', error)
        showErrorToast('Failed to update bookmark.')
        chat.isBookmarked = oldBookmarkState
        if (this.chatState.active?.meta?.id === chatId) {
          this.chatState.active.meta.isBookmarked = oldBookmarkState
        }
      }
    },

    async deleteChat(chatId) {
      const chatIndex = this.chatState.list.findIndex((c) => c.id === chatId)
      if (chatIndex === -1) return

      const deletedChat = this.chatState.list[chatIndex]
      this.chatState.list.splice(chatIndex, 1)

      try {
        await db.deleteChat(chatId)
        if (this.chatState.active?.meta?.id === chatId) {
          this.prepareNewChat()
        }
      } catch (error) {
        console.error('Failed to delete chat:', error)
        showErrorToast('Failed to delete chat.')
        this.chatState.list.splice(chatIndex, 0, deletedChat)
      }
    },

    async duplicateChat(chatId) {
      try {
        const { newChatId } = await db.cloneChat(chatId)
        await this.refreshChatList()
        await this.loadChat(newChatId)
      } catch (error) {
        console.error('Failed to duplicate chat:', error)
        showErrorToast('Failed to duplicate chat.')
      }
    },

    async downloadChatAsHTML() {
      if (!this.chatState.active) return
      try {
        const htmlContent = await exportChatAsHTML(
          this.chatState.active.meta,
          this.activeMessages
        )
        const blob = new Blob([htmlContent], { type: 'text/html' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `${(this.chatState.active.meta.title || 'chat').replace(/\s/g, '_')}.html`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
      } catch (error) {
        console.error('Failed to download chat as HTML:', error)
        showErrorToast('Failed to download chat as HTML.')
      }
    },

    async resendMessage(messageId) {
      if (!this.chatState.active) return
      const target = this._findMessageById(messageId)
      if (!target) return

      if (this.isGenerating) {
        await this.cancelGeneration()
      }

      const chatId = this.chatState.active.meta.id
      const chatConfigStore = useChatConfigStore()
      const sortedMessages = [...this.activeMessages].sort(
        (a, b) => (a.sequence ?? 0) - (b.sequence ?? 0)
      )
      const targetIndex = sortedMessages.findIndex((m) => m.id === messageId)
      if (targetIndex === -1) return

      const fallbackConfig = cloneConfigSnapshot(target.configSnapshot) || {}
      const currentConfig = cloneConfigSnapshot(this.currentRequestConfig) || {}
      const mergedTools = {
        ...(fallbackConfig.tools || {}),
        ...(currentConfig.tools || {}),
      }
      const streamingPreference =
        currentConfig.streaming ??
        fallbackConfig.streaming ??
        this.composerState.streamingEnabled

      const requestConfig = {
        ...fallbackConfig,
        ...currentConfig,
        tools: mergedTools,
        streaming: streamingPreference ?? true,
      }

      requestConfig.streaming = !!requestConfig.streaming

      if (!requestConfig.model) {
        showErrorToast('Please select a model before resending.')
        return
      }

      const targetSequence = target.sequence ?? 0
      const pruneCandidates =
        target.sender === 'model'
          ? sortedMessages.slice(targetIndex)
          : sortedMessages.slice(targetIndex + 1)

      let responseMessage = null
      try {
        const failedPrunes = []
        for (const candidate of pruneCandidates) {
          try {
            await db.deleteMessage(chatId, candidate.id)
            this._removeMessage(candidate.id)
          } catch (error) {
            console.error('Failed to prune message:', candidate.id, error)
            failedPrunes.push(candidate.id)
          }
        }

        if (failedPrunes.length) {
          showErrorToast('Failed to prune existing messages. Please try again.')
          return
        }

        sortMessagesBySequence(this.activeMessages)
        this._touchActiveChat()

        const baselineMessages = [...this.activeMessages].sort(
          (a, b) => (a.sequence ?? 0) - (b.sequence ?? 0)
        )

        let history = []
        if (target.sender === 'model') {
          history = baselineMessages.filter(
            (m) => (m.sequence ?? 0) < targetSequence
          )
        } else {
          const refreshedTarget = this._findMessageById(messageId)
          if (!refreshedTarget) {
            this._setGenerationState(GenerationStatus.IDLE)
            return
          }
          history = baselineMessages.filter(
            (m) => (m.sequence ?? 0) <= (refreshedTarget.sequence ?? 0)
          )
        }

        const anchorMessage = [...history]
          .reverse()
          .find((msg) => msg.sender === 'user')
        let requestMessages = [...history]
        const autoMessages = chatConfigStore.serializeAutoMessages(chatId)
        if (anchorMessage) {
          requestMessages = prepareRequestMessages({
            historyMessages: requestMessages,
            autoMessages,
            anchorSequence: anchorMessage.sequence ?? 0,
          })
        } else {
          const fallbackSequence =
            requestMessages.length > 0
              ? (requestMessages[requestMessages.length - 1].sequence ??
                targetSequence)
              : targetSequence
          requestMessages = prepareRequestMessages({
            historyMessages: requestMessages,
            autoMessages,
            anchorSequence: fallbackSequence,
          })
        }

        const requestId = uuidv4()
        const responseSequence =
          target.sender === 'model' && targetSequence != null
            ? targetSequence
            : nextSequence(this.activeMessages)
        responseMessage = createModelMessage({
          sequence: responseSequence,
          requestId,
          configSnapshot: requestConfig,
        })

        setContentStreamingState(responseMessage, true)
        syncContentRuntimeFromMessage(responseMessage)

        await db.saveMessage(chatId, responseMessage)
        const storedResponse = await db.getMessageWithAttachments(
          chatId,
          responseMessage.id
        )
        this._appendMessage(storedResponse ?? responseMessage)
        this.bumpScrollSignal()

        this._setGenerationState(GenerationStatus.STREAMING, {
          messageId: responseMessage.id,
          requestId,
          providerId: requestConfig.providerId || getDefaultProviderId(),
        })

        const payload = await apiAdapter.createApiRequest({
          chatId,
          messages: requestMessages,
          model: requestConfig.model,
          requestConfig,
          streaming: requestConfig.streaming ?? true,
          requestId,
        })

        const activeChatId = this.chatState.active?.meta?.id
        const currentStream = this.generationState.stream
        const trackedMessage = this._findMessageById(responseMessage.id)
        const isSameRequest =
          currentStream?.requestId === requestId &&
          currentStream?.messageId === responseMessage.id

        if (
          activeChatId !== chatId ||
          this.generationState.status !== GenerationStatus.STREAMING ||
          !isSameRequest ||
          !trackedMessage ||
          trackedMessage.status !== 'streaming' ||
          trackedMessage.requestId !== requestId
        ) {
          return
        }

        this._touchActiveChat()
        recordDebugRequest(payload)
        startGeneration(payload)
      } catch (error) {
        console.error('Failed to resend message:', error)
        const message =
          error?.message || error?.error || 'Failed to resend message. Please try again.'
        showErrorToast(message)
        if (responseMessage?.id) {
          this._removeMessage(responseMessage.id)
          try {
            await db.deleteMessage(chatId, responseMessage.id)
          } catch (cleanupError) {
            console.warn(
              'Cleanup failed for resend response message',
              responseMessage.id,
              cleanupError
            )
          }
        }
        this._setGenerationState(GenerationStatus.ERROR, null, error)
      }
    },
  },
})
