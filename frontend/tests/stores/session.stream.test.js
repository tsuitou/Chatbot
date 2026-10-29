import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useChatsStore } from '../../src/stores/chats'
import { useSessionStore } from '../../src/stores/session'
import { useDisplayStore } from '../../src/stores/display'
import { parseModelResponseSync } from '../../src/services/parser'

vi.mock('../../src/services/parser', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    parseModelResponseSync: vi.fn(actual.parseModelResponseSync),
  }
})
vi.mock('../../src/services/db', () => ({ deleteMessages: vi.fn() }))
vi.mock('../../src/stores/chatConfig', () => ({
  useChatConfigStore: () => ({ getResponseTransforms: () => [] }),
}))
vi.mock('../../src/services/socket', () => ({
  registerSocketHandlers: vi.fn(),
  startGeneration: vi.fn(),
  cancelBackendGeneration: vi.fn(),
}))
vi.mock('../../src/services/notification', () => ({
  showErrorToast: vi.fn(),
  showWarningToast: vi.fn(),
}))

let chats
let session
let message

const chunk = (fields) => ({ chatId: 'a', requestId: 'r', ...fields })

beforeEach(() => {
  vi.useFakeTimers()
  setActivePinia(createPinia())
  chats = useChatsStore()
  session = useSessionStore()
  chats.persistActiveMessage = vi.fn(async () => true)
  chats.active = {
    meta: { id: 'a' },
    messages: [
      {
        id: 'm',
        sender: 'model',
        requestId: 'r',
        status: 'streaming',
        createdAt: 0,
        content: { text: '' },
        uiFlags: { systemBubbleActive: true },
      },
    ],
  }
  message = chats.active.messages[0]
  session._setGenerationState('streaming', {
    chatId: 'a',
    messageId: 'm',
    requestId: 'r',
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('chunk batching', () => {
  it('acknowledges at once and applies a burst of chunks in one update', async () => {
    const display = useDisplayStore()
    void display.messageGroups
    vi.mocked(parseModelResponseSync).mockClear()

    for (let i = 0; i < 100; i++) {
      expect(
        await session.handleStreamChunk(chunk({ deltaText: `${i} ` }))
      ).toBe(true)
    }
    expect(message.content.text).toBe('')

    await vi.advanceTimersByTimeAsync(50)
    expect(message.content.text).toBe(
      Array.from({ length: 100 }, (_, i) => `${i} `).join('')
    )
    void display.messageGroups
    expect(parseModelResponseSync).toHaveBeenCalledTimes(1)
  })

  it('keeps thoughts, metadata and signature order across a batch', async () => {
    await session.handleStreamChunk(
      chunk({
        thoughtDelta: 'think ',
        metadata: { thoughtSignatures: [{ signature: 's1' }] },
      })
    )
    await session.handleStreamChunk(
      chunk({
        thoughtDelta: 'more',
        deltaText: 'answer',
        metadata: {
          thoughtSignatures: [{ signature: 's2' }],
          usage: { outputTokens: 3 },
        },
      })
    )
    await vi.advanceTimersByTimeAsync(50)
    expect(message.runtime.system.thoughts.rawText).toBe('think more')
    expect(message.content.text).toBe('answer')
    expect(message.metadata.thoughtSignatures).toEqual([
      { signature: 's1' },
      { signature: 's2' },
    ])
    expect(message.metadata.usage).toEqual({ outputTokens: 3 })
  })

  it('the end of the stream flushes pending chunks before saving', async () => {
    await session.handleStreamChunk(chunk({ deltaText: 'tail' }))
    let savedText
    chats.persistActiveMessage = vi.fn(async (m) => {
      savedText = m.content.text
      return true
    })
    await session.handleStreamEnd({ chatId: 'a', requestId: 'r' })
    expect(savedText).toBe('tail')
    expect(message.status).toBe('completed')
  })

  it('an error flushes pending chunks so partial output is kept', async () => {
    await session.handleStreamChunk(chunk({ deltaText: 'partial' }))
    await session.handleStreamError({ chatId: 'a', requestId: 'r', error: 'x' })
    expect(message.content.text).toBe('partial')
    expect(message.metadata.finishReason).toBe('error')
  })

  it('cancelling discards pending chunks', async () => {
    await session.handleStreamChunk(chunk({ deltaText: 'late' }))
    await session.cancelGeneration()
    await vi.advanceTimersByTimeAsync(100)
    expect(message.content.text).toBe('')
    expect(chats.active.messages).toHaveLength(0)
  })

  it('rejects a malformed chunk in its ack', async () => {
    await expect(
      session.handleStreamChunk(
        chunk({ attachments: [{ data: '%%%', mimeType: 'image/png' }] })
      )
    ).rejects.toThrow()
  })
})

describe('switching requests', () => {
  it('chunks of a cancelled request never reach the next one', async () => {
    await session.handleStreamChunk(chunk({ deltaText: 'old' }))
    await session.cancelGeneration()
    chats.active.messages.push({
      id: 'm2',
      sender: 'model',
      requestId: 'r2',
      status: 'streaming',
      createdAt: 0,
      content: { text: '' },
    })
    session._setGenerationState('streaming', {
      chatId: 'a',
      messageId: 'm2',
      requestId: 'r2',
    })
    await session.handleStreamChunk(
      chunk({ requestId: 'r2', deltaText: 'new' })
    )
    await vi.advanceTimersByTimeAsync(50)
    expect(chats.active.messages.at(-1).content.text).toBe('new')
  })
})
