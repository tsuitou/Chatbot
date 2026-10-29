import { defineStore } from 'pinia'
import { v4 as uuidv4 } from 'uuid'
import * as db from '../services/db'
import * as apiAdapter from '../services/apiAdapter'
import {
  registerSocketHandlers,
  startGeneration,
  cancelBackendGeneration,
} from '../services/socket'
import { showErrorToast, showWarningToast } from '../services/notification'
import { STREAM_IDLE_TIMEOUT_MS } from '../services/env'
import { applyResponseTransforms } from '../services/responseTransforms'
import {
  createModelMessage,
  createUserMessage,
  normalizeAttachments,
  planResend,
  planSend,
  prepareMessageForState,
  prepareRequestMessages,
  syncContentRuntimeFromMessage,
  setContentStreamingState,
  ensureContentRuntime,
} from '../services/chatFlow'
import { useChatsStore } from './chats'
import { useComposerStore } from './composer'
import { useModelsStore } from './models'
import { useChatConfigStore } from './chatConfig'
import { useDebugStore } from './debug'

const GenerationStatus = Object.freeze({
  IDLE: 'idle',
  STREAMING: 'streaming',
  ERROR: 'error',
})

const ConnectionStatus = Object.freeze({
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  DISCONNECTED: 'disconnected',
})

const CONNECTION_LOST_MESSAGE =
  'Connection to the server was lost. The response is incomplete.'
const NOT_CONNECTED_MESSAGE =
  'Not connected to the server. Please wait for it to reconnect.'

// Not reactive state: a timer handle has no business in devtools or the UI.
let streamWatchdog = null

function clearStreamWatchdog() {
  if (streamWatchdog) {
    clearTimeout(streamWatchdog)
    streamWatchdog = null
  }
}

// Chunks can arrive far faster than is worth re-rendering, so they are
// applied to the message in batches. Parsed chunks wait here (not reactive)
// until the next flush.
const STREAM_FLUSH_INTERVAL_MS = 50
let pendingChunks = []
let flushTimer = null

function discardPendingChunks() {
  pendingChunks = []
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
}

function recordDebugRequest(payload) {
  if (!import.meta.env.DEV) return
  try {
    const debugStore = useDebugStore()
    debugStore.recordRequest(payload)
  } catch (error) {
    console.error('Failed to record debug request:', error)
  }
}

/**
 * The request currently streaming into a model message.
 * @typedef {object} ActiveStream
 * @property {string} chatId
 * @property {string} messageId
 * @property {string} requestId
 * @property {string | null} [providerId]
 * @property {boolean} [watchIdle] Stop it if it stays silent too long.
 */

// Orchestrates user intents that span stores: sending and streaming
// responses, and navigation that has to stop a running generation first.
export const useSessionStore = defineStore('session', {
  state: () => ({
    generationState: {
      /** @type {'idle' | 'streaming' | 'error'} */
      status: GenerationStatus.IDLE,
      /** @type {ActiveStream | null} */
      stream: null,
      /** @type {unknown} */
      lastError: null,
    },
    connectionState: {
      /** @type {import('../services/socket').ConnectionStatus} */
      status: ConnectionStatus.CONNECTING,
    },
  }),

  getters: {
    isGenerating(state) {
      return state.generationState.status === GenerationStatus.STREAMING
    },
    isConnected(state) {
      return state.connectionState.status === ConnectionStatus.CONNECTED
    },
    connectionStatus: (state) => state.connectionState.status,
  },

  actions: {
    async initialize() {
      registerSocketHandlers({
        onChunk: (chunk) => this.handleStreamChunk(chunk),
        onEnd: (result) => this.handleStreamEnd(result),
        onError: (error) => this.handleStreamError(error),
        onDisconnect: () => this.handleDisconnect(),
        onConnectionChange: (status) => this.setConnectionStatus(status),
      })
      useComposerStore().init()
      try {
        await Promise.all([
          useChatsStore().refreshChatList(),
          useModelsStore().loadModelSettings(),
        ])
      } catch (error) {
        console.error('Failed to initialize app:', error)
        showErrorToast('Failed to load chat list. Please try again.')
      }
    },

    buildRequestConfig() {
      return {
        ...useComposerStore().requestConfig,
        systemInstruction: useChatConfigStore().getSystemPrompt(
          useChatsStore().activeChatId
        ),
      }
    },

    // --- Navigation ---

    async openChat(chatId) {
      const chats = useChatsStore()
      if (!chatId || chats.isDeleting(chatId)) return
      chats.cancelEditing()
      if (chats.activeChatId === chatId) return
      if (this.isGenerating) {
        await this.cancelGeneration()
      }
      await chats.loadChat(chatId)
    },

    async newChat() {
      if (this.isGenerating) {
        await this.cancelGeneration()
      }
      const chats = useChatsStore()
      chats.cancelEditing()
      chats.closeChat()
      useComposerStore().clear()
    },

    async deleteChat(chatId) {
      const chats = useChatsStore()
      if (chats.isDeleting(chatId)) return
      if (!chats.list.some((chat) => chat.id === chatId)) return
      chats.deletingIds.push(chatId)

      try {
        if (this.generationState.stream?.chatId === chatId) {
          await this.cancelGeneration()
        }
        await chats.removeChat(chatId)
        if (chats.activeChatId === chatId) {
          await this.newChat()
        }
      } catch (error) {
        console.error('Failed to delete chat:', error)
        showErrorToast('Failed to delete chat.')
      } finally {
        chats.deletingIds = chats.deletingIds.filter((id) => id !== chatId)
      }
    },

    async duplicateChat(chatId) {
      const newChatId = await useChatsStore().cloneChat(chatId)
      await this.openChat(newChatId)
    },

    // --- Stream events ---

    _setGenerationState(status, stream = null, error = null) {
      clearStreamWatchdog()
      // End/error handlers flush before getting here; anything left belongs
      // to a cancelled or superseded request.
      discardPendingChunks()
      this.generationState = {
        status,
        stream,
        lastError: error,
      }
    },

    /**
     * Buffers a streamed chunk for the active request.
     * @param {import('../types').StreamChunk} rawChunk
     * @returns {Promise<boolean>} false if the chunk does not belong here.
     */
    async handleStreamChunk(rawChunk) {
      const chats = useChatsStore()
      if (!chats.active || !this.isGenerating) return false
      if (rawChunk.chatId !== chats.activeChatId) return false
      const stream = this.generationState.stream
      if (!stream || stream.requestId !== rawChunk.requestId) return false

      const message = chats.findMessageByRequestId(stream.requestId)
      if (!message || message.status !== 'streaming') return false

      this._armStreamWatchdog()

      // Parse now so a malformed chunk is still rejected in its ack.
      pendingChunks.push({
        requestId: stream.requestId,
        parsed: apiAdapter.parseApiResponse(rawChunk) || {},
      })
      if (!flushTimer) {
        flushTimer = setTimeout(() => {
          flushTimer = null
          this._flushStream()
        }, STREAM_FLUSH_INTERVAL_MS)
      }
      return true
    },

    // Applies buffered chunks to the streaming message in one go.
    _flushStream() {
      if (flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      if (!pendingChunks.length) return
      const chunks = pendingChunks
      pendingChunks = []
      const stream = this.generationState.stream
      const message =
        this.isGenerating && stream
          ? useChatsStore().findMessageByRequestId(stream.requestId)
          : null
      if (!message || message.status !== 'streaming') return
      for (const { requestId, parsed } of chunks) {
        if (requestId === stream.requestId) this._applyChunk(message, parsed)
      }
    },

    _applyChunk(message, parsed) {
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

      // Merge thought signatures. Object.assign above replaced the list with
      // this chunk's entries, so rebuild from the accumulated list and append
      // the chunk's new ones after it — arrival order must survive because
      // only the newest signature is valid to send back on the text part.
      {
        const existing = Array.isArray(message.metadata?.thoughtSignatures)
          ? [...message.metadata.thoughtSignatures]
          : []
        const seen = new Set(
          existing.map((item) => String(item?.signature ?? item))
        )
        for (const item of Array.isArray(parsed.metadata?.thoughtSignatures)
          ? parsed.metadata.thoughtSignatures
          : []) {
          const sig = item?.signature ?? item
          if (!sig || seen.has(String(sig))) continue
          seen.add(String(sig))
          existing.push({ signature: String(sig) })
        }
        if (existing.length) metadata.thoughtSignatures = existing
        else delete metadata.thoughtSignatures
      }

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
      const chats = useChatsStore()
      if (!chats.active) return
      if (result.chatId !== chats.activeChatId) return
      const stream = this.generationState.stream
      if (!stream || stream.requestId !== result.requestId) return
      const message = chats.findMessageByRequestId(result.requestId)
      // Already finalized (e.g. by a disconnect or stall) — ignore late events.
      if (!message || message.status !== 'streaming') return
      this._flushStream()

      if (result.aborted) {
        message.status = 'cancelled'
        message.metadata = {
          ...message.metadata,
          finishReason: result.reason || 'aborted',
          duration: Date.now() - message.createdAt,
        }
        if (message.runtime?.system?.thoughts) {
          message.runtime.system.thoughts.isStreaming = false
          message.runtime.system.thoughts.updatedAt = Date.now()
        }
        ensureContentRuntime(message).isReady = true
        await chats.persistActiveMessage(message)
        if (this.generationState.stream !== stream) return
        this._setGenerationState(GenerationStatus.IDLE)
        chats.touchActiveChat()
        return
      }

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

      const transforms = useChatConfigStore().getResponseTransforms(
        chats.activeChatId
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

      await chats.persistActiveMessage(message)
      if (this.generationState.stream !== stream) return
      this._setGenerationState(GenerationStatus.IDLE)
      chats.touchActiveChat()
    },

    async handleStreamError(rawError) {
      const chats = useChatsStore()
      if (!chats.active) return
      if (rawError.chatId !== chats.activeChatId) return
      const stream = this.generationState.stream
      if (!stream || stream.requestId !== rawError.requestId) return
      const message = chats.findMessageByRequestId(rawError.requestId)
      if (!message || message.status !== 'streaming') return
      this._flushStream()

      message.status = 'completed'
      message.metadata = {
        ...message.metadata,
        ...(message.configSnapshot?.parameters?.writingFunctionCall === true
          ? { writingFunctionCall: 'incomplete' }
          : {}),
        ...rawError?.metadata,
        finishReason: 'error',
        error: rawError?.error || rawError?.message || 'Unknown error',
      }
      if (message.runtime?.system?.thoughts) {
        message.runtime.system.thoughts.isStreaming = false
        message.runtime.system.thoughts.updatedAt = Date.now()
      }
      ensureContentRuntime(message).isReady = true

      await chats.persistActiveMessage(message)
      if (this.generationState.stream !== stream) return
      this._setGenerationState(GenerationStatus.ERROR, null, rawError)
      chats.touchActiveChat()

      showErrorToast(
        rawError?.error || rawError?.message || 'An unexpected error occurred.'
      )
    },

    // --- Connection ---

    setConnectionStatus(status) {
      if (Object.values(ConnectionStatus).includes(status)) {
        this.connectionState.status = status
      }
    },

    // Partial output is kept (marked as an error) rather than dropped as on a
    // user cancel: losing the connection is not something the user chose.
    async handleDisconnect() {
      const stream = this.generationState.stream
      if (!this.isGenerating || !stream) return
      await this.handleStreamError({
        chatId: stream.chatId,
        requestId: stream.requestId,
        error: CONNECTION_LOST_MESSAGE,
      })
    },

    _armStreamWatchdog() {
      clearStreamWatchdog()
      const stream = this.generationState.stream
      if (!this.isGenerating || !stream?.watchIdle) return
      const { requestId } = stream
      streamWatchdog = setTimeout(() => {
        streamWatchdog = null
        void this._handleStreamStall(requestId)
      }, STREAM_IDLE_TIMEOUT_MS)
    },

    async _handleStreamStall(requestId) {
      const stream = this.generationState.stream
      if (!this.isGenerating || stream?.requestId !== requestId) return
      const { chatId } = stream
      const seconds = Math.round(STREAM_IDLE_TIMEOUT_MS / 1000)
      // Finalize first so the backend's "aborted" reply to the cancel below
      // finds the message already settled and is ignored.
      const finishing = this.handleStreamError({
        chatId,
        requestId,
        error: `No response from the server for ${seconds} seconds. Generation was stopped.`,
      })
      cancelBackendGeneration({ chatId, requestId })
      await finishing
    },

    // --- Generation ---

    async cancelGeneration() {
      const chats = useChatsStore()
      if (!this.isGenerating || !chats.active) return

      const stream = this.generationState.stream
      const chatId = stream?.chatId || chats.activeChatId
      // Flip to IDLE first so any late chunks for this request are ignored.
      this._setGenerationState(GenerationStatus.IDLE)

      cancelBackendGeneration({ chatId, requestId: stream?.requestId })

      const messageId = stream?.messageId
      if (!messageId) return

      // The interrupted model message has no persisted content (partial deltas
      // live only in memory), so drop it entirely instead of leaving an empty
      // 'cancelled' record that would linger in the DB and pollute history.
      await chats.cleanupMessages(chatId, [messageId], {
        warnPrefix: 'Failed to delete cancelled message',
      })
    },

    // Saves an empty streaming model message to receive the response. Returns
    // null (after removing everything in cleanupIds) if the chat was left.
    async _createResponseMessage({
      chatId,
      sequence,
      requestConfig,
      cleanupIds = [],
      warnPrefix,
    }) {
      const chats = useChatsStore()
      const modelMessage = createModelMessage({
        sequence,
        requestId: uuidv4(),
        configSnapshot: requestConfig,
      })
      prepareMessageForState(modelMessage)

      await db.saveMessage(chatId, modelMessage)
      cleanupIds.push(modelMessage.id)
      if (!chats.isActiveChat(chatId)) {
        await chats.cleanupMessages(chatId, cleanupIds, { warnPrefix })
        return null
      }
      chats.appendMessage(modelMessage)
      return modelMessage
    },

    async _startRequest({
      chatId,
      historyMessages,
      anchorSequence,
      modelMessage,
      requestConfig,
    }) {
      const requestMessages = prepareRequestMessages({
        historyMessages,
        autoMessages: useChatConfigStore().serializeAutoMessages(chatId),
        anchorSequence,
      })
      await this._executeGeneration({
        chatId,
        requestMessages,
        modelMessage,
        requestConfig,
      })
    },

    async _executeGeneration({
      chatId,
      requestMessages,
      modelMessage,
      requestConfig,
    }) {
      const chats = useChatsStore()
      const requestId = modelMessage.requestId

      // Update UI state
      this._setGenerationState(GenerationStatus.STREAMING, {
        chatId,
        messageId: modelMessage.id,
        requestId,
        providerId: requestConfig.providerId,
        // Non-streaming replies and agent models legitimately stay silent for
        // a long time, so only watch regular streaming requests for stalls.
        watchIdle:
          requestConfig.streaming !== false &&
          requestConfig.providerId !== 'virtual',
      })
      chats.touchActiveChat()
      chats.bumpScrollSignal()

      const { messages: sendableMessages, skipped } =
        useComposerStore().withoutUnsupportedAttachments(requestMessages)
      if (skipped) {
        showWarningToast(
          `${skipped} attachment(s) not sent: unsupported by the current model.`
        )
      }

      try {
        const payload = await apiAdapter.createApiRequest({
          chatId,
          messages: sendableMessages,
          model: requestConfig.model,
          requestConfig,
          streaming: requestConfig.streaming,
          requestId,
        })

        // Check if generation was cancelled or switched during preparation
        const currentStream = this.generationState.stream
        const trackedMessage = chats.findMessageById(modelMessage.id)
        const isSameRequest =
          currentStream?.requestId === requestId &&
          currentStream?.messageId === modelMessage.id

        if (
          chats.isDeleting(chatId) ||
          chats.activeChatId !== chatId ||
          this.generationState.status !== GenerationStatus.STREAMING ||
          !isSameRequest ||
          !trackedMessage ||
          trackedMessage.status !== 'streaming' ||
          trackedMessage.requestId !== requestId
        ) {
          await chats.cleanupMessages(chatId, [modelMessage.id], {
            warnPrefix: 'Failed to clean stale model message',
          })
          return
        }

        recordDebugRequest(payload)
        startGeneration(payload)
        this._armStreamWatchdog()
      } catch (error) {
        if (this.generationState.stream?.requestId !== requestId) return
        console.error('Failed to start generation:', error)
        showErrorToast('Failed to send message. Please try again.')

        // Cleanup model message on immediate failure
        this._setGenerationState(GenerationStatus.ERROR, null, error)
        await chats.cleanupMessages(chatId, [modelMessage.id], {
          warnPrefix: 'Failed to clean stale model message',
        })
      }
    },

    async sendMessage() {
      const chats = useChatsStore()
      const composer = useComposerStore()
      if (chats.isDeleting(chats.activeChatId)) return
      if (!this.isConnected) {
        showErrorToast(NOT_CONNECTED_MESSAGE)
        return
      }
      const prompt = composer.prompt || ''
      let requestConfig = this.buildRequestConfig()

      chats.cancelEditing()

      if (!requestConfig.model) {
        showErrorToast('Please select a model before sending.')
        return
      }

      await useModelsStore().ensureModelCapabilities(
        requestConfig.model,
        requestConfig.providerId
      )
      requestConfig = this.buildRequestConfig()
      const bucket = composer.attachmentBucket
      bucket.dropUnsupportedForCurrentPolicy?.()
      const attachmentIssue = bucket.getBlockingIssue?.()
      if (attachmentIssue) {
        showErrorToast(attachmentIssue)
        return
      }

      const attachments = bucket.list()
      const savedIds = []
      let chatId = null

      try {
        chatId = await chats.ensureActiveChat(prompt)
        if (!chatId) throw new Error('Active chat not available')
        await chats.removeInterruptedMessages(chatId)
        if (!chats.isActiveChat(chatId)) return

        const plan = planSend(chats.activeMessages)
        const userMessage = createUserMessage({
          sequence: plan.userSequence,
          text: prompt,
          attachments,
          configSnapshot: requestConfig,
        })
        // Pre-hydrate/normalize to ensure consistency before saving/appending
        prepareMessageForState(userMessage)

        await db.saveMessage(chatId, userMessage)
        savedIds.push(userMessage.id)
        if (!chats.isActiveChat(chatId)) {
          await chats.cleanupMessages(chatId, savedIds, {
            warnPrefix: 'Failed to clean abandoned setup messages',
          })
          return
        }
        chats.appendMessage(userMessage)
        const historyMessages = [...chats.activeMessages]

        const modelMessage = await this._createResponseMessage({
          chatId,
          sequence: plan.responseSequence,
          requestConfig,
          cleanupIds: savedIds,
          warnPrefix: 'Failed to clean abandoned setup messages',
        })
        if (!modelMessage) return

        composer.clear()

        await this._startRequest({
          chatId,
          historyMessages,
          anchorSequence: plan.anchorSequence,
          modelMessage,
          requestConfig,
        })
      } catch (error) {
        if (chatId && !chats.isActiveChat(chatId)) return
        console.error('Failed to setup message:', error)
        showErrorToast('Failed to setup message. Please try again.')
        this._setGenerationState(GenerationStatus.ERROR, null, error)

        if (chatId && savedIds.length) {
          await chats.cleanupMessages(chatId, savedIds, {
            warnPrefix: 'Failed to clean setup messages',
          })
        }
      }
    },

    async resendMessage(messageId) {
      const chats = useChatsStore()
      if (!chats.active) return
      // Resending prunes later messages first, so refuse before touching them.
      if (!this.isConnected) {
        showErrorToast(NOT_CONNECTED_MESSAGE)
        return
      }

      if (this.isGenerating) {
        await this.cancelGeneration()
      }

      const chatId = chats.activeChatId
      await chats.removeInterruptedMessages(chatId)
      if (!chats.isActiveChat(chatId)) return
      if (!chats.findMessageById(messageId)) return

      let requestConfig = this.buildRequestConfig()
      if (!requestConfig.model) {
        showErrorToast('Please select a model before resending.')
        return
      }

      await useModelsStore().ensureModelCapabilities(
        requestConfig.model,
        requestConfig.providerId
      )
      if (!chats.isActiveChat(chatId)) return
      useComposerStore().pruneToolsForCurrentModel()
      requestConfig = this.buildRequestConfig()

      const plan = planResend(chats.activeMessages, messageId)
      if (!plan) return

      try {
        if (plan.pruneIds.length) {
          await chats.cleanupMessages(chatId, plan.pruneIds, {
            warnPrefix: 'Failed to prune resend messages',
          })
        }
        if (!chats.isActiveChat(chatId)) return
        chats.touchActiveChat()

        const modelMessage = await this._createResponseMessage({
          chatId,
          sequence: plan.responseSequence,
          requestConfig,
          warnPrefix: 'Failed to clean stale model message',
        })
        if (!modelMessage) return

        await this._startRequest({
          chatId,
          historyMessages: plan.historyMessages,
          anchorSequence: plan.anchorSequence,
          modelMessage,
          requestConfig,
        })
      } catch (error) {
        if (!chats.isActiveChat(chatId)) return
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
