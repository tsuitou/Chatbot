import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useChatStore } from '../../src/stores/chat'
import * as socket from '../../src/services/socket'
import { STREAM_IDLE_TIMEOUT_MS } from '../../src/services/env'

const { events, db } = vi.hoisted(() => ({
  events: [],
  db: {
    deleteMessages: vi.fn(),
    updateMessage: vi.fn(),
    updateChatMetadata: vi.fn(),
  },
}))

vi.mock('../../src/services/db', () => db)
vi.mock('../../src/stores/chatConfig', () => ({
  useChatConfigStore: () => ({
    getResponseTransforms: () => [],
    getSystemPrompt: () => '',
  }),
}))
vi.mock('../../src/services/socket', () => ({
  registerSocketHandlers: vi.fn(),
  startGeneration: vi.fn(),
  cancelBackendGeneration: vi.fn(),
}))
vi.mock('../../src/services/notification', () => ({
  showErrorToast: (message) => events.push(message),
  showWarningToast: () => {},
  showSuccessToast: () => {},
}))
vi.mock('../../src/services/apiAdapter', async (importOriginal) => ({
  ...(await importOriginal()),
  createApiRequest: vi.fn(async () => ({})),
}))

const STREAMING_CONFIG = { model: 'm', providerId: 'gemini', streaming: true }

function setup() {
  const store = useChatStore()
  store.chatState.active = { meta: { id: 'a', title: 'Chat' }, messages: [] }
  store.chatState.list = [{ id: 'a', title: 'Chat' }]
  store.setConnectionStatus('connected')
  store._persistActiveMessage = async () => true
  return store
}

// Puts the store in the state it is in right after a request was emitted.
async function startStreaming(store, requestConfig = STREAMING_CONFIG) {
  const modelMessage = {
    id: 'm',
    sender: 'model',
    requestId: 'r',
    status: 'streaming',
    createdAt: Date.now(),
    content: { text: '' },
  }
  store.chatState.active.messages = [modelMessage]
  await store._executeGeneration({
    chatId: 'a',
    requestMessages: [],
    modelMessage,
    requestConfig,
  })
  expect(socket.startGeneration).toHaveBeenCalledOnce()
  return store.chatState.active.messages[0]
}

const chunk = (deltaText) => ({ chatId: 'a', requestId: 'r', deltaText })

beforeEach(() => {
  setActivePinia(createPinia())
  events.length = 0
  vi.mocked(socket.startGeneration).mockClear()
  vi.mocked(socket.cancelBackendGeneration).mockClear()
  for (const fn of Object.values(db)) fn.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('connection status', () => {
  it('tracks status changes and ignores unknown values', () => {
    const store = setup()
    expect(store.isConnected).toBe(true)
    store.setConnectionStatus('disconnected')
    expect(store.connectionStatus).toBe('disconnected')
    store.setConnectionStatus('bogus')
    expect(store.connectionStatus).toBe('disconnected')
    expect(store.isConnected).toBe(false)
  })
})

describe('disconnect during generation', () => {
  it('keeps the partial response and marks it as an error', async () => {
    const store = setup()
    const message = await startStreaming(store)
    await store.handleStreamChunk(chunk('partial '))
    await store.handleStreamChunk(chunk('answer'))

    store.setConnectionStatus('disconnected')
    await store.handleDisconnect()

    expect(message.content.text).toBe('partial answer')
    expect(message.status).toBe('completed')
    expect(message.metadata.finishReason).toBe('error')
    expect(message.metadata.error).toMatch(/connection to the server was lost/i)
    expect(store.generationState.status).toBe('error')
    expect(store.isGenerating).toBe(false)
  })

  it('does nothing when no generation is running', async () => {
    const store = setup()
    await store.handleDisconnect()
    expect(store.generationState.status).toBe('idle')
    expect(events).toEqual([])
  })
})

describe('stalled stream', () => {
  it('stops the request after a silent period; each chunk resets the timer', async () => {
    const store = setup()
    const message = await startStreaming(store)

    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS - 1000)
    await store.handleStreamChunk(chunk('still alive'))
    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS - 1000)
    expect(socket.cancelBackendGeneration).not.toHaveBeenCalled()
    expect(store.isGenerating).toBe(true)

    await vi.advanceTimersByTimeAsync(1000)
    expect(socket.cancelBackendGeneration).toHaveBeenCalledWith({
      chatId: 'a',
      requestId: 'r',
    })
    expect(message.content.text).toBe('still alive')
    expect(message.metadata.error).toMatch(/no response from the server/i)
    expect(store.generationState.status).toBe('error')
  })

  it("ignores the backend's late aborted reply and chunks after the stall", async () => {
    const store = setup()
    // Hold the error save open so the late events land while it is pending.
    let releaseSave
    const saving = new Promise((resolve) => {
      releaseSave = () => resolve(true)
    })
    store._persistActiveMessage = () => saving
    const message = await startStreaming(store)
    await store.handleStreamChunk(chunk('kept'))
    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS)
    expect(store.isGenerating).toBe(true)

    expect(await store.handleStreamChunk(chunk(' late'))).toBe(false)
    const ending = store.handleStreamEnd({
      chatId: 'a',
      requestId: 'r',
      aborted: true,
      reason: 'cancelled',
    })
    releaseSave()
    await ending
    await vi.advanceTimersByTimeAsync(0)

    expect(message.status).toBe('completed')
    expect(message.content.text).toBe('kept')
    expect(message.metadata.finishReason).toBe('error')
    expect(store.generationState.status).toBe('error')
  })

  it.each([
    ['non-streaming requests', { ...STREAMING_CONFIG, streaming: false }],
    ['agent models', { ...STREAMING_CONFIG, providerId: 'virtual' }],
  ])('does not watch %s', async (_, requestConfig) => {
    const store = setup()
    await startStreaming(store, requestConfig)
    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS * 10)
    expect(socket.cancelBackendGeneration).not.toHaveBeenCalled()
    expect(store.isGenerating).toBe(true)
  })

  it('a normal completion clears the timer', async () => {
    const store = setup()
    await startStreaming(store)
    await store.handleStreamEnd({ chatId: 'a', requestId: 'r' })
    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS * 2)
    expect(socket.cancelBackendGeneration).not.toHaveBeenCalled()
    expect(store.generationState.status).toBe('idle')
  })
})

describe('sending while disconnected', () => {
  it('refuses to send', async () => {
    const store = setup()
    store.setConnectionStatus('disconnected')
    store.composerState.prompt = 'hello'
    await store.sendMessage()
    expect(socket.startGeneration).not.toHaveBeenCalled()
    expect(store.composerState.prompt).toBe('hello')
    expect(events).toEqual([expect.stringMatching(/not connected/i)])
  })

  it('refuses to resend before pruning any messages', async () => {
    const store = setup()
    store.chatState.active.messages = [
      { id: 'u', sender: 'user', sequence: 10, status: 'completed' },
      { id: 'm', sender: 'model', sequence: 20, status: 'completed' },
    ]
    store.setConnectionStatus('disconnected')
    await store.resendMessage('m')
    expect(db.deleteMessages).not.toHaveBeenCalled()
    expect(store.chatState.active.messages).toHaveLength(2)
    expect(events).toEqual([expect.stringMatching(/not connected/i)])
  })
})
