import { defineStore } from 'pinia'
import { toRaw } from 'vue'
import { v4 as uuidv4 } from 'uuid'
import * as db from '../services/db'
import * as apiAdapter from '../services/apiAdapter'
import { getModelCapabilities, uploadFile } from '../services/api'
import { startGeneration, registerSocketHandlers } from '../services/socket'
import { showErrorToast } from '../services/notification'
import { exportChatAsHTML } from '../services/htmlExporter'
import {
  normalizeSettingsEntry,
  cloneSettings as cloneModelSettings,
} from '../services/modelConfig'
import { createAttachmentBucket } from '../services/attachments'
import { useChatConfigStore } from './chatConfig'
import { applyResponseTransforms } from '../services/responseTransforms'
import { useDebugStore } from './debug'
import { createDefaultToolSettings } from '../config/defaultTools'
import {
  createModelMessage,
  createUserMessage,
  hydrateMessages,
  cloneConfigSnapshot,
  normalizeAttachments,
  prepareRequestMessages,
  prepareMessageForState,
  isInvalidModelHistoryMessage,
  syncContentRuntimeFromMessage,
  setContentStreamingState,
  ensureContentRuntime,
} from '../services/chatFlow'

const DEFAULT_TITLE = 'New Chat'
const TITLE_MAX_LEN = 30
const EMPTY_CAPABILITIES = Object.freeze({
  features: {},
  parameters: {},
  tools: {},
  attachments: { enabled: false },
})

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

function readModelSettingsFromState(all, model) {
  const raw = model && all[model] ? all[model] : null
  return normalizeSettingsEntry(raw)
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

function normalizeModelGroups(input) {
  if (!Array.isArray(input)) return []
  if (input.every((item) => typeof item === 'string')) {
    return [
      {
        provider: null,
        label: 'Models',
        models: [...input],
      },
    ]
  }
  return input
    .map((group) => ({
      provider: group?.provider || null,
      label: group?.label || group?.provider || 'Models',
      models: Array.isArray(group?.models) ? [...group.models] : [],
    }))
    .filter((group) => group.models.length > 0)
}

function flattenModelGroups(groups) {
  return (Array.isArray(groups) ? groups : []).flatMap((group) =>
    Array.isArray(group?.models) ? group.models : []
  )
}

function capabilityKey(providerId, model) {
  return `${providerId || ''}:${model || ''}`
}

function enabledTools(selectedTools = {}, toolDefinitions = {}) {
  const result = {}
  for (const [key, definition] of Object.entries(toolDefinitions || {})) {
    if (definition?.enabled && selectedTools[key]) {
      result[key] = true
    }
  }
  return result
}

export const useChatStore = defineStore('chat', {
  state: () => ({
    appState: {
      initialized: false,
      availableModels: [],
      defaultModel: null,
      modelSettingsByModel: {},
      modelCapabilitiesByKey: {},
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
      tools: createDefaultToolSettings(),
      providerId: null,
      attachmentBucket: createAttachmentBucket(),
    },
    editingState: null,
    uiSignals: {
      scrollToken: 0,
    },
  }),

  getters: {
    availableModels: (state) => state.appState.availableModels,
    allAvailableModels: (state) =>
      flattenModelGroups(state.appState.availableModels),
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
    currentModelCapabilities(state) {
      const model = state.composerState.model
      if (!model) return EMPTY_CAPABILITIES
      const providerId = state.composerState.providerId
      return (
        state.appState.modelCapabilitiesByKey[
          capabilityKey(providerId, model)
        ] || EMPTY_CAPABILITIES
      )
    },
    currentToolDefinitions() {
      return this.currentModelCapabilities.tools || {}
    },
    currentRequestConfig(state) {
      const model = state.composerState.model
      const streaming = state.composerState.streamingEnabled
      const normalized = readModelSettingsFromState(
        state.appState.modelSettingsByModel,
        model
      )
      const settings = cloneModelSettings(normalized)
      const providerId = state.composerState.providerId || settings.providerId
      const chatConfigStore = useChatConfigStore()
      const activeChatId = state.chatState.active?.meta?.id || null
      const systemInstruction = chatConfigStore.getSystemPrompt(activeChatId)
      const toolDefinitions = this.currentToolDefinitions
      const tools = enabledTools(state.composerState.tools, toolDefinitions)
      return {
        providerId,
        model,
        tools,
        attachments: this.currentModelCapabilities.attachments || {},
        parameters: { ...settings.parameters },
        systemInstruction,
        streaming,
      }
    },
  },

  actions: {
    _attachmentPolicyForCurrentModel() {
      const policy = this.currentModelCapabilities.attachments || {}
      if (policy.enabled !== true) {
        return {
          allowRemoteUpload: false,
          allowedMimes: new Set(),
          maxInlineFileSize: null,
        }
      }
      return {
        ...policy,
        allowRemoteUpload: policy.allowRemoteUpload === true,
        allowedMimes: policy.allowedMimes || null,
        maxInlineFileSize: policy.maxInlineFileSize || null,
      }
    },

    _createAttachmentBucket(options = {}) {
      return createAttachmentBucket({
        ...options,
        policy: () => this._attachmentPolicyForCurrentModel(),
        uploadFn: async (file, uploadOptions) => {
          const { model, providerId } = this.currentRequestConfig
          return uploadFile(file, {
            model,
            providerId,
            onProgress: uploadOptions?.onProgress,
          })
        },
      })
    },

    setAvailableModels(models) {
      this.appState.availableModels = normalizeModelGroups(models)
    },

    setDefaultModel(model, providerId = null) {
      this.appState.defaultModel = typeof model === 'string' ? model : null
      if (!this.composerState.model && this.appState.defaultModel) {
        this.composerState.model = this.appState.defaultModel
        this.composerState.providerId = providerId
      }
    },

    setActiveModel(model, providerId = null) {
      this.composerState.model = typeof model === 'string' ? model : null
      this.composerState.providerId = providerId
    },

    async selectModel(model, providerId = null) {
      this.setActiveModel(model, providerId)
      await this.ensureModelCapabilities(model, providerId)
      this._pruneToolsForCurrentModel()
      this.composerState.attachmentBucket.dropUnsupportedForCurrentPolicy?.()
    },

    setStreamingEnabled(enabled) {
      this.composerState.streamingEnabled = !!enabled
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

    async ensureModelCapabilities(
      model = this.composerState.model,
      providerId = this.composerState.providerId
    ) {
      if (!model) return EMPTY_CAPABILITIES
      const key = capabilityKey(providerId, model)
      const cached = this.appState.modelCapabilitiesByKey[key]
      if (cached) return cached
      const capabilities = await getModelCapabilities(model, providerId)
      this.appState.modelCapabilitiesByKey = {
        ...this.appState.modelCapabilitiesByKey,
        [key]: capabilities,
      }
      return capabilities
    },

    _pruneToolsForCurrentModel() {
      const toolDefinitions = this.currentToolDefinitions
      const defaults = createDefaultToolSettings()
      const next = {}
      for (const key of Object.keys(toolDefinitions)) {
        if (!toolDefinitions[key]?.enabled) continue
        next[key] =
          typeof this.composerState.tools[key] === 'boolean'
            ? this.composerState.tools[key]
            : !!defaults[key]
      }
      this.composerState.tools = next
    },

    bumpScrollSignal() {
      this.uiSignals.scrollToken =
        (this.uiSignals.scrollToken + 1) % Number.MAX_SAFE_INTEGER
    },

    setModelSettings(settingsByModel = {}) {
      this.appState.modelSettingsByModel = { ...settingsByModel }
    },

    async initializeApp() {
      registerSocketHandlers({
        onChunk: (chunk) => this.handleStreamChunk(chunk),
        onEnd: (result) => this.handleStreamEnd(result),
        onError: (error) => this.handleStreamError(error),
      })
      this.composerState.attachmentBucket = this._createAttachmentBucket()
      try {
        const [chatList, modelSettings] = await Promise.all([
          db.getChatList(),
          db.getModelSettings(),
        ])
        this.chatState.list = chatList
        this.setModelSettings(modelSettings)
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
      this.chatState.active.messages.push(prepareMessageForState(message))
      sortMessagesBySequence(this.chatState.active.messages)
    },

    _replaceMessage(message) {
      if (!this.chatState.active) return
      const idx = this.chatState.active.messages.findIndex(
        (m) => m.id === message.id
      )
      if (idx === -1) return
      this.chatState.active.messages[idx] = prepareMessageForState(message)
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

    async _persistActiveMessage(message, options = {}) {
      if (!this.chatState.active || !message) return false
      const isStreaming = message.status === 'streaming'
      setContentStreamingState(message, isStreaming)
      syncContentRuntimeFromMessage(message)
      message.updatedAt = Date.now()
      try {
        await db.updateMessage(this.chatState.active.meta.id, toRaw(message))

        // For edited messages, reload attachments from DB to ensure Blob consistency
        if (options.reloadAttachments) {
          const hydratedMessage = await this._loadMessageFromDb(
            this.chatState.active.meta.id,
            message.id
          )
          if (hydratedMessage) {
            this._replaceMessage(hydratedMessage)
            return true
          }
        }

        this._replaceMessage(message)
        return true
      } catch (error) {
        console.error('Failed to persist message state:', error)
        return false
      }
    },

    updateMessageUiFlags(messageId, partial = {}) {
      if (!this.chatState.active || !messageId) return
      if (!partial || typeof partial !== 'object') return
      const message = this._findMessageById(messageId)
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
      void this._persistActiveMessage(message)
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
        await this._reconcileInterruptedMessages()
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
      const normalized = readModelSettingsFromState(
        this.appState.modelSettingsByModel,
        model
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

    async handleStreamChunk(rawChunk) {
      if (!this.chatState.active || !this.isGenerating) return
      if (rawChunk.chatId !== this.chatState.active.meta.id) return
      const stream = this.generationState.stream
      if (!stream || stream.requestId !== rawChunk.requestId) return

      const message = this._findMessageByRequestId(stream.requestId)
      if (!message) return

      const parsed = apiAdapter.parseApiResponse(rawChunk) || {}

      const deltaText = parsed.deltaText ?? ''

      setContentStreamingState(message, true)

      if (deltaText) {
        message.content = {
          ...message.content,
          text: `${message.content?.text || ''}${deltaText}`,
        }
      }

      const newAttachments = parsed.newAttachments || []
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

      const thoughtDelta = parsed.thoughtDelta
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
      }

      // Merge thought signatures (append unique by signature+index)
      const mergeThoughtSignatures = (incoming = []) => {
        if (!Array.isArray(incoming) || !incoming.length) return
        const existing = Array.isArray(metadata.thoughtSignatures)
          ? [...metadata.thoughtSignatures]
          : []
        const seen = new Set(
          existing.map((item) => {
            const sig = item?.signature ?? item
            const idx = item?.partIndex ?? 0
            return `${idx}:${sig}`
          })
        )
        for (const item of incoming) {
          const sig = item?.signature ?? item
          if (!sig) continue
          const idx =
            typeof item?.partIndex === 'number' && item.partIndex >= 0
              ? item.partIndex
              : 0
          const key = `${idx}:${sig}`
          if (seen.has(key)) continue
          seen.add(key)
          existing.push({ signature: sig, partIndex: idx })
        }
        metadata.thoughtSignatures = existing
      }
      mergeThoughtSignatures(message.metadata?.thoughtSignatures)
      mergeThoughtSignatures(parsed.metadata?.thoughtSignatures)

      const usage = parsed.metadata?.usage
      if (usage) {
        metadata.usage = {
          ...(metadata.usage || {}),
          ...usage,
        }
      }

      if (parsed.finishReason) {
        metadata.finishReason = parsed.finishReason
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
          duration: Date.now() - message.createdAt,
        }
      } else {
        message.metadata = {
          ...message.metadata,
          duration: Date.now() - message.createdAt,
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
      const chatId = stream?.chatId || this.chatState.active.meta.id
      // Flip to IDLE first so any late chunks for this request are ignored.
      this._setGenerationState(GenerationStatus.IDLE)

      const messageId = stream?.messageId
      if (!messageId) return

      // The interrupted model message has no persisted content (partial deltas
      // live only in memory), so drop it entirely instead of leaving an empty
      // 'cancelled' record that would linger in the DB and pollute history.
      await this._cleanupMessages(chatId, [messageId], {
        warnPrefix: 'Failed to delete cancelled message',
      })
    },

    async _cleanupMessages(chatId, messageIds, { warnPrefix } = {}) {
      const ids = Array.isArray(messageIds) ? messageIds.filter(Boolean) : []
      if (!chatId || !ids.length) return false

      const isActiveChat = this.chatState.active?.meta?.id === chatId
      if (isActiveChat) {
        ids.forEach((id) => this._removeMessage(id))
      }

      try {
        await db.deleteMessages(chatId, ids)
      } catch (error) {
        console.warn(warnPrefix || 'Failed to clean messages:', ids, error)
        return false
      }

      if (isActiveChat) {
        this._touchActiveChat()
      }
      return true
    },

    async _cleanupInvalidModelMessages(chatId) {
      if (!chatId || this.chatState.active?.meta?.id !== chatId) return false

      const invalidIds = this.chatState.active.messages
        .filter(isInvalidModelHistoryMessage)
        .map((message) => message.id)

      if (!invalidIds.length) return false

      return this._cleanupMessages(chatId, invalidIds, {
        warnPrefix: 'Failed to clean interrupted messages',
      })
    },

    async _cleanupStaleModelMessage(chatId, messageId) {
      if (!chatId || !messageId) return false
      return this._cleanupMessages(chatId, [messageId], {
        warnPrefix: 'Failed to clean stale model message',
      })
    },

    _isActiveChat(chatId) {
      return !!chatId && this.chatState.active?.meta?.id === chatId
    },

    async _normalizeActiveHistory() {
      const chatId = this.chatState.active?.meta?.id
      if (!chatId) return
      await this._cleanupInvalidModelMessages(chatId)
    },

    async _normalizeActiveHistoryForChat(chatId) {
      if (!chatId || this.chatState.active?.meta?.id !== chatId) return false
      return this._cleanupInvalidModelMessages(chatId)
    },

    async _reconcileInterruptedMessages() {
      try {
        await this._normalizeActiveHistory()
      } catch (error) {
        console.warn('Failed to reconcile interrupted messages:', error)
      }
    },

    startEditing(messageId) {
      const message = this._findMessageById(messageId)
      if (!message) return

      const bucket = this._createAttachmentBucket()
      bucket.replaceAll(
        normalizeAttachments(message.attachments ?? [], message.sender)
      )
      bucket.dropUnsupportedForCurrentPolicy?.()

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

      await this.ensureModelCapabilities()
      this.editingState.attachmentBucket.dropUnsupportedForCurrentPolicy?.()
      const attachmentIssue =
        this.editingState.attachmentBucket.getBlockingIssue?.()
      if (attachmentIssue) {
        showErrorToast(attachmentIssue)
        return
      }

      const allAttachments = this.editingState.attachmentBucket.list()
      const attachments = allAttachments.filter(
        (item) => !this.editingState.attachmentBucket.isUnsupported?.(item)
      )

      const updated = {
        ...message,
        content: { text: this.editingState.draftText },
        attachments,
        updatedAt: Date.now(),
      }

      const persisted = await this._persistActiveMessage(updated, {
        reloadAttachments: true,
      })
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

    async deleteMessages(messageIds) {
      if (
        !this.chatState.active ||
        !Array.isArray(messageIds) ||
        !messageIds.length
      )
        return

      try {
        await db.deleteMessages(this.chatState.active.meta.id, messageIds)
        messageIds.forEach((id) => this._removeMessage(id))
        this._touchActiveChat()
      } catch (error) {
        console.error('Failed to delete messages:', error)
        showErrorToast('Failed to delete messages.')
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

    async _executeGeneration({
      chatId,
      requestMessages,
      modelMessage,
      requestConfig,
    }) {
      const requestId = modelMessage.requestId

      // Update UI state
      this._setGenerationState(GenerationStatus.STREAMING, {
        chatId,
        messageId: modelMessage.id,
        requestId,
        providerId: requestConfig.providerId,
      })
      this._touchActiveChat()
      this.bumpScrollSignal()

      try {
        const payload = await apiAdapter.createApiRequest({
          chatId,
          messages: requestMessages,
          model: requestConfig.model,
          requestConfig,
          streaming: requestConfig.streaming,
          requestId,
        })

        // Check if generation was cancelled or switched during preparation
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
          await this._cleanupStaleModelMessage(chatId, modelMessage.id)
          return
        }

        recordDebugRequest(payload)
        startGeneration(payload)
      } catch (error) {
        console.error('Failed to start generation:', error)
        showErrorToast('Failed to send message. Please try again.')

        // Cleanup model message on immediate failure
        this._setGenerationState(GenerationStatus.ERROR, null, error)
        await this._cleanupStaleModelMessage(chatId, modelMessage.id)
      }
    },

    async sendMessage() {
      const prompt = this.composerState.prompt || ''
      let requestConfig = this.currentRequestConfig

      this.cancelEditing()

      if (!requestConfig.model) {
        showErrorToast('Please select a model before sending.')
        return
      }

      await this.ensureModelCapabilities(
        requestConfig.model,
        requestConfig.providerId
      )
      requestConfig = this.currentRequestConfig
      this.composerState.attachmentBucket.dropUnsupportedForCurrentPolicy?.()
      const attachmentIssue =
        this.composerState.attachmentBucket.getBlockingIssue?.()
      if (attachmentIssue) {
        showErrorToast(attachmentIssue)
        return
      }

      const chatConfigStore = useChatConfigStore()
      const allAttachments = this.composerState.attachmentBucket.list()
      const attachments = allAttachments.filter(
        (item) => !this.composerState.attachmentBucket.isUnsupported?.(item)
      )
      const tempMessageIds = []
      let chatId = null

      try {
        chatId = await this.ensureActiveChat(prompt)
        if (!chatId) throw new Error('Active chat not available')
        await this._normalizeActiveHistoryForChat(chatId)
        if (!this._isActiveChat(chatId)) return

        const messages = this.activeMessages
        const userSequence = nextSequence(messages)
        const userMessage = createUserMessage({
          sequence: userSequence,
          text: prompt,
          attachments,
          configSnapshot: requestConfig,
        })
        // Pre-hydrate/normalize to ensure consistency before saving/appending
        prepareMessageForState(userMessage)

        await db.saveMessage(chatId, userMessage)
        tempMessageIds.push(userMessage.id)
        if (!this._isActiveChat(chatId)) {
          await this._cleanupMessages(chatId, tempMessageIds, {
            warnPrefix: 'Failed to clean abandoned setup messages',
          })
          return
        }
        this._appendMessage(userMessage)

        const modelSequence = nextSequence(this.activeMessages)
        const requestId = uuidv4()
        const modelMessage = createModelMessage({
          sequence: modelSequence,
          requestId,
          configSnapshot: requestConfig,
        })
        prepareMessageForState(modelMessage)

        await db.saveMessage(chatId, modelMessage)
        tempMessageIds.push(modelMessage.id)
        if (!this._isActiveChat(chatId)) {
          await this._cleanupMessages(chatId, tempMessageIds, {
            warnPrefix: 'Failed to clean abandoned setup messages',
          })
          return
        }
        this._appendMessage(modelMessage)

        // Clear composer
        this.composerState.prompt = ''
        this.composerState.attachmentBucket.clear()

        const historyMessages = this.activeMessages.filter(
          (m) => (m.sequence ?? 0) <= userSequence
        )
        const autoMessages = chatConfigStore.serializeAutoMessages(chatId)
        const requestMessages = prepareRequestMessages({
          historyMessages,
          autoMessages,
          anchorSequence: userSequence,
        })

        await this._executeGeneration({
          chatId,
          requestMessages,
          modelMessage,
          requestConfig,
        })
      } catch (error) {
        console.error('Failed to setup message:', error)
        showErrorToast('Failed to setup message. Please try again.')
        this._setGenerationState(GenerationStatus.ERROR, null, error)

        if (chatId && tempMessageIds.length) {
          await this._cleanupMessages(chatId, tempMessageIds, {
            warnPrefix: 'Failed to clean setup messages',
          })
        }
      }
    },

    async resendMessage(messageId) {
      if (!this.chatState.active) return

      if (this.isGenerating) {
        await this.cancelGeneration()
      }

      const chatId = this.chatState.active.meta.id
      await this._normalizeActiveHistoryForChat(chatId)
      if (!this._isActiveChat(chatId)) return

      const target = this._findMessageById(messageId)
      if (!target) return

      const chatConfigStore = useChatConfigStore()

      // Identify configuration for resend
      const fallbackConfig = cloneConfigSnapshot(target.configSnapshot) || {}
      const currentConfig = this.currentRequestConfig || {}
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
        streaming: !!(streamingPreference ?? true),
      }

      if (!requestConfig.model) {
        showErrorToast('Please select a model before resending.')
        return
      }

      const sortedMessages = [...this.activeMessages].sort(
        (a, b) => (a.sequence ?? 0) - (b.sequence ?? 0)
      )
      const targetIndex = sortedMessages.findIndex((m) => m.id === messageId)

      // Determine prune candidates
      const pruneCandidates =
        target.sender === 'model'
          ? sortedMessages.slice(targetIndex)
          : sortedMessages.slice(targetIndex + 1)
      const pruneIds = pruneCandidates.map((m) => m.id)

      try {
        // Batch delete from DB and State
        if (pruneIds.length) {
          await this._cleanupMessages(chatId, pruneIds, {
            warnPrefix: 'Failed to prune resend messages',
          })
        }
        if (!this._isActiveChat(chatId)) return

        // Re-sort and touch chat
        sortMessagesBySequence(this.activeMessages)
        this._touchActiveChat()

        // Re-evaluate history
        const baselineMessages = [...this.activeMessages].sort(
          (a, b) => (a.sequence ?? 0) - (b.sequence ?? 0)
        )

        let history = []
        const targetSequence = target.sequence ?? 0

        if (target.sender === 'model') {
          // If we pruned the model message itself, history is everything before it
          history = baselineMessages.filter(
            (m) => (m.sequence ?? 0) < targetSequence
          )
        } else {
          // If we pruned after the user message, that user message is the new anchor
          // We need to make sure the target user message is still in activeMessages (it should be)
          const refreshedTarget = this._findMessageById(messageId)
          if (!refreshedTarget) {
            // Should not happen if delete logic is correct
            this._setGenerationState(GenerationStatus.IDLE)
            return
          }
          history = baselineMessages.filter(
            (m) => (m.sequence ?? 0) <= (refreshedTarget.sequence ?? 0)
          )
        }

        // Prepare request context
        const anchorMessage = [...history]
          .reverse()
          .find((msg) => msg.sender === 'user')

        let requestMessages = [...history]
        const autoMessages = chatConfigStore.serializeAutoMessages(chatId)

        // Calculate anchor sequence for auto-messages
        let anchorSequence = targetSequence
        if (anchorMessage) {
          anchorSequence = anchorMessage.sequence ?? 0
        } else if (requestMessages.length > 0) {
          anchorSequence =
            requestMessages[requestMessages.length - 1].sequence ??
            targetSequence
        }

        requestMessages = prepareRequestMessages({
          historyMessages: requestMessages,
          autoMessages,
          anchorSequence,
        })

        const requestId = uuidv4()
        // If replacing a model message, reuse its sequence, otherwise next available
        const responseSequence =
          target.sender === 'model' && targetSequence != null
            ? targetSequence
            : nextSequence(this.activeMessages)

        const responseMessage = createModelMessage({
          sequence: responseSequence,
          requestId,
          configSnapshot: requestConfig,
        })
        prepareMessageForState(responseMessage)

        await db.saveMessage(chatId, responseMessage)
        if (!this._isActiveChat(chatId)) {
          await this._cleanupStaleModelMessage(chatId, responseMessage.id)
          return
        }
        this._appendMessage(responseMessage)

        await this._executeGeneration({
          chatId,
          requestMessages,
          modelMessage: responseMessage,
          requestConfig,
        })
      } catch (error) {
        console.error('Failed to resend message:', error)
        const message =
          error?.message ||
          error?.error ||
          'Failed to resend message. Please try again.'
        showErrorToast(message)
        this._setGenerationState(GenerationStatus.ERROR, null, error)
      }
    },
  },
})
