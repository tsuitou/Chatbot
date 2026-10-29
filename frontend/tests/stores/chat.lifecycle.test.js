import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { toRaw } from 'vue'
import { useChatsStore } from '../../src/stores/chats'
import { useSessionStore } from '../../src/stores/session'
import { useComposerStore } from '../../src/stores/composer'
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
      prepareForNewChat: () => {},
      loadAutoMessages: () => {},
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
  const chats = useChatsStore()
  const session = useSessionStore()
  chats.active = { meta: { id: 'a', title: 'Old' }, messages: [] }
  chats.list = [
    { id: 'a', title: 'Old' },
    { id: 'b', title: 'Other' },
  ]
  session.newChat = async () => {
    events.push('new')
    chats.active = null
  }
  return { chats, session, composer: useComposerStore() }
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
    const { chats } = setup()
    await chats.saveChatSettings('a', ' Renamed ')
    expect(chats.list[0].title).toBe('Renamed')
    expect(chats.active.meta.title).toBe('Renamed')
    expect(chats.list[0].lastModified).toBe(123)
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
    const { chats } = setup()
    await chats.updateTitle('  Renamed  ')
    expect(db.updateChatMetadata.mock.calls).toEqual([
      ['a', { title: 'Renamed' }],
    ])
    expect(chats.list[0].title).toBe('Renamed')
    expect(chats.list[0].lastModified).toBe(456)
    expect(chats.active.meta.title).toBe('Renamed')
    expect(chats.active.meta.lastModified).toBe(456)
    expect('settings' in chats.active.meta).toBe(false)
  })

  it('bookmarking keeps the chat position in history', async () => {
    const { chats } = setup()
    chats.list[1].lastModified = 1
    await chats.toggleBookmark('b')
    expect(db.updateChatMetadata.mock.calls).toEqual([
      ['b', { isBookmarked: true }, { touch: false }],
    ])
    expect(chats.list[1].isBookmarked).toBe(true)
    expect(chats.list[1].lastModified).toBe(1)
  })

  it('display-only flags persist without touching the chat', () => {
    const persisted = []
    const { chats } = setup()
    chats.active.messages = [{ id: 'm' }]
    chats.persistActiveMessage = async (message, options) => {
      persisted.push({ flags: { ...message.uiFlags }, options })
    }
    chats.updateMessageUiFlags('m', { thoughtsCollapsed: false })
    expect(persisted).toEqual([
      { flags: { thoughtsCollapsed: false }, options: { touchChat: false } },
    ])
    expect(chats.list[0].lastModified).toBeUndefined()
  })
})

describe('generation lifecycle', () => {
  it('a failed generation still refreshes the chat list position', async () => {
    const { chats, session } = setup()
    chats.active.messages = [{ id: 'm', requestId: 'r', status: 'streaming' }]
    session.generationState = {
      status: 'streaming',
      stream: { chatId: 'a', requestId: 'r' },
    }
    chats.persistActiveMessage = async () => true
    await session.handleStreamError({ chatId: 'a', requestId: 'r', error: 'x' })
    expect(session.generationState.status).toBe('error')
    expect(typeof chats.list[0].lastModified).toBe('number')
  })

  it('an in-flight completion cannot reset a newer generation', async () => {
    const saving = deferred()
    const { chats, session } = setup()
    chats.active.messages = [
      {
        id: 'm',
        requestId: 'r',
        status: 'streaming',
        createdAt: 0,
        content: { text: 'done' },
      },
    ]
    session.generationState = {
      status: 'streaming',
      stream: { chatId: 'a', requestId: 'r' },
    }
    chats.persistActiveMessage = () => saving.promise
    const completing = session.handleStreamEnd({ chatId: 'a', requestId: 'r' })
    const nextStream = { chatId: 'b', requestId: 'next' }
    session._setGenerationState('streaming', nextStream)
    saving.resolve()
    await completing
    expect(toRaw(session.generationState.stream)).toBe(nextStream)
    expect(session.generationState.status).toBe('streaming')
  })

  it('late events after deletion do not modify a new chat', async () => {
    const { chats, session } = setup()
    chats.active = { meta: { id: 'b' }, messages: [] }
    session.generationState = {
      status: 'streaming',
      stream: { chatId: 'b', requestId: 'next' },
    }
    const oldEvent = { chatId: 'a', requestId: 'r' }
    expect(await session.handleStreamChunk(oldEvent)).toBe(false)
    await session.handleStreamEnd(oldEvent)
    await session.handleStreamError(oldEvent)
    expect(session.generationState.stream.requestId).toBe('next')
    expect(events).toEqual([])
  })

  it('unsupported attachments stay in history but are left out of the request', async () => {
    const sent = []
    apiAdapter.createApiRequest.mockImplementation(async ({ messages }) => {
      sent.push(messages)
      return {}
    })
    const { session, composer } = setup()
    const video = { id: 'v', mimeType: 'video/mp4' }
    const image = { id: 'i', mimeType: 'image/png' }
    const history = [
      { id: 'u', sender: 'user', attachments: [video, image] },
      { id: 'p', sender: 'user', attachments: [image] },
    ]
    composer.attachmentBucket = {
      isUnsupported: (att) => att.mimeType === 'video/mp4',
    }
    await session._executeGeneration({
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
    const { chats, session } = setup()
    session.generationState = {
      status: 'streaming',
      stream: { chatId: 'a', messageId: 'm', requestId: 'r' },
    }
    session.newChat = async () => {
      events.push('new')
      await navigation.promise
    }
    const deleting = session.deleteChat('a')
    await flush()
    expect(session.generationState.status).toBe('idle')
    expect(events).toEqual(['cancel', 'delete', 'clear', 'new'])
    expect(chats.list.some((chat) => chat.id === 'a')).toBe(false)
    expect(chats.deletingIds).toContain('a')
    navigation.resolve()
    await deleting
    expect(chats.deletingIds).toHaveLength(0)
  })

  it('deleting another chat leaves the current generation untouched', async () => {
    const { chats, session } = setup()
    const stream = { chatId: 'a', requestId: 'r' }
    session.generationState = { status: 'streaming', stream }
    await session.deleteChat('b')
    expect(toRaw(session.generationState.stream)).toBe(stream)
    expect(chats.active.meta.id).toBe('a')
    expect(events).toEqual(['clear'])
  })

  it('failed deletion retains the chat without restarting generation', async () => {
    db.deleteChat.mockRejectedValue(new Error('storage failure'))
    const { chats, session } = setup()
    session.generationState = {
      status: 'streaming',
      stream: { chatId: 'a', messageId: 'm' },
    }
    await session.deleteChat('a')
    expect(chats.active.meta.id).toBe('a')
    expect(chats.list).toHaveLength(2)
    expect(session.generationState.status).toBe('idle')
    expect(events).toEqual(['error'])
  })
})
