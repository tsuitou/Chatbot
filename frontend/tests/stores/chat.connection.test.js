import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useChatsStore } from '../../src/stores/chats'
import { useSessionStore } from '../../src/stores/session'
import { useComposerStore } from '../../src/stores/composer'
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
  const chats = useChatsStore()
  const session = useSessionStore()
  chats.active = { meta: { id: 'a', title: 'Chat' }, messages: [] }
  chats.list = [{ id: 'a', title: 'Chat' }]
  session.setConnectionStatus('connected')
  chats.persistActiveMessage = async () => true
  return { chats, session, composer: useComposerStore() }
}

// Puts the store in the state it is in right after a request was emitted.
async function startStreaming(requestConfig = STREAMING_CONFIG) {
  const chats = useChatsStore()
  const modelMessage = {
    id: 'm',
    sender: 'model',
    requestId: 'r',
    status: 'streaming',
    createdAt: Date.now(),
    content: { text: '' },
  }
  chats.active.messages = [modelMessage]
  await useSessionStore()._executeGeneration({
    chatId: 'a',
    requestMessages: [],
    modelMessage,
    requestConfig,
  })
  expect(socket.startGeneration).toHaveBeenCalledOnce()
  return chats.active.messages[0]
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
    const { session } = setup()
    expect(session.isConnected).toBe(true)
    session.setConnectionStatus('disconnected')
    expect(session.connectionStatus).toBe('disconnected')
    session.setConnectionStatus('bogus')
    expect(session.connectionStatus).toBe('disconnected')
    expect(session.isConnected).toBe(false)
  })
})

describe('disconnect during generation', () => {
  it('keeps the partial response and marks it as an error', async () => {
    const { session } = setup()
    const message = await startStreaming()
    await session.handleStreamChunk(chunk('partial '))
    await session.handleStreamChunk(chunk('answer'))

    session.setConnectionStatus('disconnected')
    await session.handleDisconnect()

    expect(message.content.text).toBe('partial answer')
    expect(message.status).toBe('completed')
    expect(message.metadata.finishReason).toBe('error')
    expect(message.metadata.error).toMatch(/connection to the server was lost/i)
    expect(session.generationState.status).toBe('error')
    expect(session.isGenerating).toBe(false)
  })

  it('does nothing when no generation is running', async () => {
    const { session } = setup()
    await session.handleDisconnect()
    expect(session.generationState.status).toBe('idle')
    expect(events).toEqual([])
  })
})

describe('stalled stream', () => {
  it('stops the request after a silent period; each chunk resets the timer', async () => {
    const { session } = setup()
    const message = await startStreaming()

    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS - 1000)
    await session.handleStreamChunk(chunk('still alive'))
    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS - 1000)
    expect(socket.cancelBackendGeneration).not.toHaveBeenCalled()
    expect(session.isGenerating).toBe(true)

    await vi.advanceTimersByTimeAsync(1000)
    expect(socket.cancelBackendGeneration).toHaveBeenCalledWith({
      chatId: 'a',
      requestId: 'r',
    })
    expect(message.content.text).toBe('still alive')
    expect(message.metadata.error).toMatch(/no response from the server/i)
    expect(session.generationState.status).toBe('error')
  })

  it("ignores the backend's late aborted reply and chunks after the stall", async () => {
    const { chats, session } = setup()
    // Hold the error save open so the late events land while it is pending.
    let releaseSave
    const saving = new Promise((resolve) => {
      releaseSave = () => resolve(true)
    })
    chats.persistActiveMessage = () => saving
    const message = await startStreaming()
    await session.handleStreamChunk(chunk('kept'))
    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS)
    expect(session.isGenerating).toBe(true)

    expect(await session.handleStreamChunk(chunk(' late'))).toBe(false)
    const ending = session.handleStreamEnd({
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
    expect(session.generationState.status).toBe('error')
  })

  it.each([
    ['non-streaming requests', { ...STREAMING_CONFIG, streaming: false }],
    ['agent models', { ...STREAMING_CONFIG, providerId: 'virtual' }],
  ])('does not watch %s', async (_, requestConfig) => {
    const { session } = setup()
    await startStreaming(requestConfig)
    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS * 10)
    expect(socket.cancelBackendGeneration).not.toHaveBeenCalled()
    expect(session.isGenerating).toBe(true)
  })

  it('a normal completion clears the timer', async () => {
    const { session } = setup()
    await startStreaming()
    await session.handleStreamEnd({ chatId: 'a', requestId: 'r' })
    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS * 2)
    expect(socket.cancelBackendGeneration).not.toHaveBeenCalled()
    expect(session.generationState.status).toBe('idle')
  })
})

describe('sending while disconnected', () => {
  it('refuses to send', async () => {
    const { session, composer } = setup()
    session.setConnectionStatus('disconnected')
    composer.prompt = 'hello'
    await session.sendMessage()
    expect(socket.startGeneration).not.toHaveBeenCalled()
    expect(composer.prompt).toBe('hello')
    expect(events).toEqual([expect.stringMatching(/not connected/i)])
  })

  it('refuses to resend before pruning any messages', async () => {
    const { chats, session } = setup()
    chats.active.messages = [
      { id: 'u', sender: 'user', sequence: 10, status: 'completed' },
      { id: 'm', sender: 'model', sequence: 20, status: 'completed' },
    ]
    session.setConnectionStatus('disconnected')
    await session.resendMessage('m')
    expect(db.deleteMessages).not.toHaveBeenCalled()
    expect(chats.active.messages).toHaveLength(2)
    expect(events).toEqual([expect.stringMatching(/not connected/i)])
  })
})
