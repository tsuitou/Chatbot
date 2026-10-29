import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import * as db from '../../src/services/db'
import * as socket from '../../src/services/socket'
import { useChatsStore } from '../../src/stores/chats'
import { useComposerStore } from '../../src/stores/composer'
import { useSessionStore } from '../../src/stores/session'

// End-to-end through the real stores and IndexedDB (fake-indexeddb); only the
// network edges are mocked.
vi.mock('../../src/services/socket', () => ({
  registerSocketHandlers: vi.fn(),
  startGeneration: vi.fn(),
  cancelBackendGeneration: vi.fn(),
}))
vi.mock('../../src/services/api', () => ({
  getModelCapabilities: vi.fn(async () => ({
    features: {},
    parameters: {},
    tools: {},
    attachments: { enabled: true },
  })),
  uploadFile: vi.fn(),
}))
vi.mock('../../src/services/notification', () => ({
  showErrorToast: vi.fn(),
  showWarningToast: vi.fn(),
  showSuccessToast: vi.fn(),
}))

let chats
let composer
let session

beforeEach(async () => {
  setActivePinia(createPinia())
  vi.mocked(socket.startGeneration).mockClear()
  vi.mocked(socket.cancelBackendGeneration).mockClear()
  chats = useChatsStore()
  composer = useComposerStore()
  session = useSessionStore()
  await session.initialize()
  session.setConnectionStatus('connected')
  composer.setActiveModel('gemini-test', 'gemini')
})

const lastPayload = () => socket.startGeneration.mock.calls.at(-1)[0]
const payloadTexts = () =>
  lastPayload().messages.map((m) => `${m.role}:${m.parts[0].text}`)

async function send(text) {
  composer.setPrompt(text)
  await session.sendMessage()
}

async function reply(text) {
  const { chatId, requestId } = lastPayload()
  await session.handleStreamChunk({ chatId, requestId, deltaText: text })
  await session.handleStreamEnd({ chatId, requestId })
}

async function storedMessages() {
  const details = await db.getChatDetails(chats.activeChatId)
  return details.messages.map((m) => ({
    sender: m.sender,
    sequence: m.sequence,
    text: m.content?.text,
    status: m.status,
  }))
}

describe('send', () => {
  it('creates the chat, saves both messages and clears the composer', async () => {
    await send('hello')

    expect(chats.activeChat.title).toBe('hello')
    expect(composer.prompt).toBe('')
    expect(session.isGenerating).toBe(true)
    expect(payloadTexts()).toEqual(['user:hello'])

    await reply('hi there')
    expect(session.isGenerating).toBe(false)
    expect(await storedMessages()).toEqual([
      { sender: 'user', sequence: 10, text: 'hello', status: 'completed' },
      { sender: 'model', sequence: 20, text: 'hi there', status: 'completed' },
    ])
  })

  it('a follow-up carries the whole history', async () => {
    await send('one')
    await reply('r1')
    await send('two')
    expect(payloadTexts()).toEqual(['user:one', 'model:r1', 'user:two'])
    await reply('r2')
    expect((await storedMessages()).map((m) => m.sequence)).toEqual([
      10, 20, 30, 40,
    ])
  })
})

describe('resend', () => {
  beforeEach(async () => {
    await send('one')
    await reply('r1')
    await send('two')
    await reply('r2')
  })

  const idAt = (sequence) =>
    chats.activeMessages.find((m) => m.sequence === sequence).id

  it('rerunning a model message replaces it and everything after', async () => {
    await session.resendMessage(idAt(20))
    expect(payloadTexts()).toEqual(['user:one'])
    await reply('r1 again')
    expect(await storedMessages()).toEqual([
      { sender: 'user', sequence: 10, text: 'one', status: 'completed' },
      { sender: 'model', sequence: 20, text: 'r1 again', status: 'completed' },
    ])
  })

  it('rerunning a user message keeps it and replaces what follows', async () => {
    await session.resendMessage(idAt(30))
    expect(payloadTexts()).toEqual(['user:one', 'model:r1', 'user:two'])
    await reply('r2 again')
    expect((await storedMessages()).map((m) => m.text)).toEqual([
      'one',
      'r1',
      'two',
      'r2 again',
    ])
  })
})

describe('navigation', () => {
  it('opening another chat stops the generation and drops its empty reply', async () => {
    await send('first')
    await reply('done')
    const firstId = chats.activeChatId
    await session.newChat()
    await send('second')
    const secondId = chats.activeChatId
    expect(session.isGenerating).toBe(true)

    await session.openChat(firstId)

    expect(socket.cancelBackendGeneration).toHaveBeenCalledOnce()
    expect(session.isGenerating).toBe(false)
    expect(chats.activeChatId).toBe(firstId)
    const second = await db.getChatDetails(secondId)
    expect(second.messages.map((m) => m.sender)).toEqual(['user'])
  })

  it('a new chat clears the open chat and the composer', async () => {
    await send('hello')
    await reply('hi')
    composer.setPrompt('draft')
    await session.newChat()
    expect(chats.isChatOpen).toBe(false)
    expect(composer.prompt).toBe('')
  })

  it('duplicating opens the copy', async () => {
    await send('hello')
    await reply('hi')
    const original = chats.activeChatId
    await session.duplicateChat(original)
    expect(chats.activeChatId).not.toBe(original)
    expect(chats.activeMessages.map((m) => m.content.text)).toEqual([
      'hello',
      'hi',
    ])
  })

  it('deleting the open chat removes it and starts fresh', async () => {
    await send('bye')
    await reply('ok')
    const chatId = chats.activeChatId
    await session.deleteChat(chatId)
    expect(chats.isChatOpen).toBe(false)
    expect(chats.chatList.some((c) => c.id === chatId)).toBe(false)
    expect(await db.getChatDetails(chatId)).toBeNull()
  })
})
