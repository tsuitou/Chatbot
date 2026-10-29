import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { toRaw } from 'vue'
import { useChatStore } from '../../src/stores/chat'
import * as apiAdapter from '../../src/services/apiAdapter'

// Store actions run against a fake persistence boundary; every side effect
// that matters is recorded in `events` so ordering can be asserted.
const { events, db, config } = vi.hoisted(() => {
  const events = []
  return {
    events,
    db: {
      updateChatMetadata: vi.fn(),
      deleteMessages: vi.fn(),
      deleteMessage: vi.fn(),
      deleteChat: vi.fn(),
      saveMessage: vi.fn(),
      updateMessage: vi.fn(),
      getMessageWithAttachments: vi.fn(),
      getChatList: vi.fn(),
      getModelSettings: vi.fn(),
      getChatDetails: vi.fn(),
      saveNewChat: vi.fn(),
      saveAutoMessages: vi.fn(),
      cloneChat: vi.fn(),
      exportArchive: vi.fn(),
    },
    config: {
      persistSettings: async () => events.push('settings'),
      persistAutoMessages: async () => events.push('auto'),
      clearChatSettings: () => events.push('clear'),
      getResponseTransforms: () => [],
      getSystemPrompt: () => '',
    },
  }
})

vi.mock('../../src/services/db', () => db)
vi.mock('../../src/stores/chatConfig', () => ({
  useChatConfigStore: () => config,
}))
vi.mock('../../src/services/socket', () => ({
  registerSocketHandlers: vi.fn(),
  startGeneration: vi.fn(),
  cancelBackendGeneration: vi.fn(),
}))
vi.mock('../../src/services/notification', () => ({
  showErrorToast: () => events.push('error'),
  showWarningToast: (message) => events.push(message),
  showSuccessToast: () => {},
}))
vi.mock('../../src/services/apiAdapter', async (importOriginal) => ({
  ...(await importOriginal()),
  createApiRequest: vi.fn(),
}))

function setup() {
  const store = useChatStore()
  store.chatState.active = { meta: { id: 'a', title: 'Old' }, messages: [] }
  store.chatState.list = [
    { id: 'a', title: 'Old' },
    { id: 'b', title: 'Other' },
  ]
  store.prepareNewChat = async () => {
    events.push('new')
    store.chatState.active = null
  }
  return store
}

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

beforeEach(() => {
  setActivePinia(createPinia())
  events.length = 0
  for (const fn of Object.values(db)) fn.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('chat metadata', () => {
  it('settings save synchronizes title and persisted modification time', async () => {
    db.updateChatMetadata.mockImplementation(async (id, patch) => ({
      id,
      ...patch,
      lastModified: 123,
    }))
    const store = setup()
    await store.saveChatSettings('a', ' Renamed ')
    expect(store.chatState.list[0].title).toBe('Renamed')
    expect(store.chatState.active.meta.title).toBe('Renamed')
    expect(store.chatState.list[0].lastModified).toBe(123)
    expect(events).toEqual(['settings', 'auto'])
  })

  it('inline title save trims and moves the chat with its persisted time', async () => {
    db.updateChatMetadata.mockImplementation(async (id, patch) => ({
      id,
      title: 'Old',
      ...patch,
      lastModified: 456,
      settings: {},
    }))
    const store = setup()
    await store.updateTitle('  Renamed  ')
    expect(db.updateChatMetadata.mock.calls).toEqual([
      ['a', { title: 'Renamed' }],
    ])
    expect(store.chatState.list[0].title).toBe('Renamed')
    expect(store.chatState.list[0].lastModified).toBe(456)
    expect(store.chatState.active.meta.title).toBe('Renamed')
    expect(store.chatState.active.meta.lastModified).toBe(456)
    expect('settings' in store.chatState.active.meta).toBe(false)
  })

  it('bookmarking keeps the chat position in history', async () => {
    const store = setup()
    store.chatState.list[1].lastModified = 1
    await store.toggleBookmark('b')
    expect(db.updateChatMetadata.mock.calls).toEqual([
      ['b', { isBookmarked: true }, { touch: false }],
    ])
    expect(store.chatState.list[1].isBookmarked).toBe(true)
    expect(store.chatState.list[1].lastModified).toBe(1)
  })

  it('display-only flags persist without touching the chat', () => {
    const persisted = []
    const store = setup()
    store.chatState.active.messages = [{ id: 'm' }]
    store._persistActiveMessage = async (message, options) => {
      persisted.push({ flags: { ...message.uiFlags }, options })
    }
    store.updateMessageUiFlags('m', { thoughtsCollapsed: false })
    expect(persisted).toEqual([
      { flags: { thoughtsCollapsed: false }, options: { touchChat: false } },
    ])
    expect(store.chatState.list[0].lastModified).toBeUndefined()
  })
})

describe('generation lifecycle', () => {
  it('a failed generation still refreshes the chat list position', async () => {
    const store = setup()
    store.chatState.active.messages = [{ id: 'm', requestId: 'r' }]
    store.generationState = {
      status: 'streaming',
      stream: { chatId: 'a', requestId: 'r' },
    }
    store._persistActiveMessage = async () => true
    await store.handleStreamError({ chatId: 'a', requestId: 'r', error: 'x' })
    expect(store.generationState.status).toBe('error')
    expect(typeof store.chatState.list[0].lastModified).toBe('number')
  })

  it('an in-flight completion cannot reset a newer generation', async () => {
    const saving = deferred()
    const store = setup()
    store.chatState.active.messages = [
      { id: 'm', requestId: 'r', createdAt: 0, content: { text: 'done' } },
    ]
    store.generationState = {
      status: 'streaming',
      stream: { chatId: 'a', requestId: 'r' },
    }
    store._persistActiveMessage = () => saving.promise
    const completing = store.handleStreamEnd({ chatId: 'a', requestId: 'r' })
    const nextStream = { chatId: 'b', requestId: 'next' }
    store._setGenerationState('streaming', nextStream)
    saving.resolve()
    await completing
    expect(toRaw(store.generationState.stream)).toBe(nextStream)
    expect(store.generationState.status).toBe('streaming')
  })

  it('late events after deletion do not modify a new chat', async () => {
    const store = setup()
    store.chatState.active = { meta: { id: 'b' }, messages: [] }
    store.generationState = {
      status: 'streaming',
      stream: { chatId: 'b', requestId: 'next' },
    }
    const oldEvent = { chatId: 'a', requestId: 'r' }
    expect(await store.handleStreamChunk(oldEvent)).toBe(false)
    await store.handleStreamEnd(oldEvent)
    await store.handleStreamError(oldEvent)
    expect(store.generationState.stream.requestId).toBe('next')
    expect(events).toEqual([])
  })

  it('unsupported attachments stay in history but are left out of the request', async () => {
    const sent = []
    apiAdapter.createApiRequest.mockImplementation(async ({ messages }) => {
      sent.push(messages)
      return {}
    })
    const store = setup()
    const video = { id: 'v', mimeType: 'video/mp4' }
    const image = { id: 'i', mimeType: 'image/png' }
    const history = [
      { id: 'u', sender: 'user', attachments: [video, image] },
      { id: 'p', sender: 'user', attachments: [image] },
    ]
    store.composerState.attachmentBucket = {
      isUnsupported: (att) => att.mimeType === 'video/mp4',
    }
    await store._executeGeneration({
      chatId: 'a',
      requestMessages: history,
      modelMessage: { id: 'm', requestId: 'r' },
      requestConfig: { model: 'claude' },
    })
    expect(
      sent[0].map((message) => message.attachments.map((att) => att.id))
    ).toEqual([['i'], ['i']])
    expect(history[0].attachments).toHaveLength(2)
    expect(events).toEqual([
      '1 attachment(s) not sent: unsupported by the current model.',
    ])
  })
})

describe('chat deletion', () => {
  it('cancels generation before deleting and waits for navigation', async () => {
    const navigation = deferred()
    db.deleteMessages.mockImplementation(async () => events.push('cancel'))
    db.deleteChat.mockImplementation(async () => events.push('delete'))
    const store = setup()
    store.generationState = {
      status: 'streaming',
      stream: { chatId: 'a', messageId: 'm', requestId: 'r' },
    }
    store.prepareNewChat = async () => {
      events.push('new')
      await navigation.promise
    }
    const deleting = store.deleteChat('a')
    await flush()
    expect(store.generationState.status).toBe('idle')
    expect(events).toEqual(['cancel', 'delete', 'clear', 'new'])
    expect(store.chatState.list.some((chat) => chat.id === 'a')).toBe(false)
    expect(store.chatState.deletingIds).toContain('a')
    navigation.resolve()
    await deleting
    expect(store.chatState.deletingIds).toHaveLength(0)
  })

  it('deleting another chat leaves the current generation untouched', async () => {
    const store = setup()
    const stream = { chatId: 'a', requestId: 'r' }
    store.generationState = { status: 'streaming', stream }
    await store.deleteChat('b')
    expect(toRaw(store.generationState.stream)).toBe(stream)
    expect(store.chatState.active.meta.id).toBe('a')
    expect(events).toEqual(['clear'])
  })

  it('failed deletion retains the chat without restarting generation', async () => {
    db.deleteChat.mockRejectedValue(new Error('storage failure'))
    const store = setup()
    store.generationState = {
      status: 'streaming',
      stream: { chatId: 'a', messageId: 'm' },
    }
    await store.deleteChat('a')
    expect(store.chatState.active.meta.id).toBe('a')
    expect(store.chatState.list).toHaveLength(2)
    expect(store.generationState.status).toBe('idle')
    expect(events).toEqual(['error'])
  })
})
