import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { setImmediate } from 'node:timers'

// Exercise store actions with an isolated persistence boundary and controllable
// promises, including callbacks that were already running when deletion began.
const source = (
  await readFile(new URL('../src/stores/chat.js', import.meta.url), 'utf8')
)
  .replace(/^import[\s\S]*?from ['"][^'"]+['"]\n/gm, '')
  .replace('export const useChatStore', 'const useChatStore')
  .replaceAll('import.meta.env.DEV', 'false')

function setup(db = {}, globals = {}) {
  const events = []
  const config = {
    persistSettings: async () => events.push('settings'),
    persistAutoMessages: async () => events.push('auto'),
    clearChatSettings: () => events.push('clear'),
    getResponseTransforms: () => [],
  }
  const definition = runInNewContext(`${source}\nuseChatStore`, {
    defineStore: (_, definition) => definition,
    db,
    useChatConfigStore: () => config,
    cancelBackendGeneration: () => {},
    showErrorToast: () => events.push('error'),
    console: { error() {}, warn() {} },
    ensureContentRuntime: (message) => (message.runtime ||= {}),
    ...globals,
  })
  const store = {
    chatState: {
      active: { meta: { id: 'a', title: 'Old' }, messages: [] },
      list: [
        { id: 'a', title: 'Old' },
        { id: 'b', title: 'Other' },
      ],
      deletingIds: [],
    },
    generationState: { status: 'idle', stream: null },
    ...definition.actions,
  }
  Object.defineProperty(store, 'isGenerating', {
    get: () => definition.getters.isGenerating.call(store, store),
  })
  store.prepareNewChat = async () => {
    events.push('new')
    store.chatState.active = null
  }
  return { store, events }
}

// Values built inside the vm context carry its prototypes.
const plain = (value) => JSON.parse(JSON.stringify(value))

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test('settings save synchronizes title and persisted modification time', async () => {
  const { store, events } = setup({
    updateChatMetadata: async (id, patch) => ({
      id,
      ...patch,
      lastModified: 123,
    }),
  })
  await store.saveChatSettings('a', ' Renamed ')
  assert.equal(store.chatState.list[0].title, 'Renamed')
  assert.equal(store.chatState.active.meta.title, 'Renamed')
  assert.equal(store.chatState.list[0].lastModified, 123)
  assert.deepEqual(events, ['settings', 'auto'])
})

test('inline title save trims and moves the chat with its persisted time', async () => {
  const calls = []
  const { store } = setup({
    updateChatMetadata: async (id, patch, options) => {
      calls.push(plain({ id, patch, options }))
      return { id, title: 'Old', ...patch, lastModified: 456, settings: {} }
    },
  })
  await store.updateTitle('  Renamed  ')
  assert.deepEqual(calls, [{ id: 'a', patch: { title: 'Renamed' } }])
  assert.equal(store.chatState.list[0].title, 'Renamed')
  assert.equal(store.chatState.list[0].lastModified, 456)
  assert.equal(store.chatState.active.meta.title, 'Renamed')
  assert.equal(store.chatState.active.meta.lastModified, 456)
  assert.equal('settings' in store.chatState.active.meta, false)
})

test('bookmarking keeps the chat position in history', async () => {
  const calls = []
  const { store } = setup({
    updateChatMetadata: async (id, patch, options) => {
      calls.push(plain({ id, patch, options }))
    },
  })
  store.chatState.list[1].lastModified = 1
  await store.toggleBookmark('b')
  assert.deepEqual(calls, [
    { id: 'b', patch: { isBookmarked: true }, options: { touch: false } },
  ])
  assert.equal(store.chatState.list[1].isBookmarked, true)
  assert.equal(store.chatState.list[1].lastModified, 1)
})

test('a failed generation still refreshes the chat list position', async () => {
  const { store } = setup()
  store.chatState.active.messages = [{ id: 'm', requestId: 'r' }]
  store.generationState = {
    status: 'streaming',
    stream: { chatId: 'a', requestId: 'r' },
  }
  store._persistActiveMessage = async () => true
  await store.handleStreamError({ chatId: 'a', requestId: 'r', error: 'x' })
  assert.equal(store.generationState.status, 'error')
  assert.equal(typeof store.chatState.list[0].lastModified, 'number')
})

test('display-only flags persist without touching the chat', async () => {
  const persisted = []
  const { store } = setup()
  store.chatState.active.messages = [{ id: 'm' }]
  store._persistActiveMessage = async (message, options) => {
    persisted.push(plain({ flags: message.uiFlags, options }))
  }
  store.updateMessageUiFlags('m', { thoughtsCollapsed: false })
  assert.deepEqual(persisted, [
    { flags: { thoughtsCollapsed: false }, options: { touchChat: false } },
  ])
  assert.equal(store.chatState.list[0].lastModified, undefined)
})

test('deletion cancels generation before deleting and waits for navigation', async () => {
  const navigation = deferred()
  const { store, events } = setup({
    deleteMessages: async () => events.push('cancel'),
    deleteChat: async () => events.push('delete'),
  })
  store.generationState = {
    status: 'streaming',
    stream: { chatId: 'a', messageId: 'm', requestId: 'r' },
  }
  store.prepareNewChat = async () => {
    events.push('new')
    await navigation.promise
  }
  const deleting = store.deleteChat('a')
  await new Promise(setImmediate)
  assert.equal(store.generationState.status, 'idle')
  assert.deepEqual(events, ['cancel', 'delete', 'clear', 'new'])
  assert.equal(
    store.chatState.list.some((chat) => chat.id === 'a'),
    false
  )
  assert.equal(store.chatState.deletingIds.includes('a'), true)
  navigation.resolve()
  await deleting
  assert.equal(store.chatState.deletingIds.length, 0)
})

test('deleting another chat leaves the current generation untouched', async () => {
  const { store, events } = setup({ deleteChat: async () => {} })
  const stream = { chatId: 'a', requestId: 'r' }
  store.generationState = { status: 'streaming', stream }
  await store.deleteChat('b')
  assert.equal(store.generationState.stream, stream)
  assert.equal(store.chatState.active.meta.id, 'a')
  assert.deepEqual(events, ['clear'])
})

test('failed deletion retains the chat without restarting generation', async () => {
  const { store, events } = setup({
    deleteMessages: async () => {},
    deleteChat: async () => {
      throw new Error('storage failure')
    },
  })
  store.generationState = {
    status: 'streaming',
    stream: { chatId: 'a', messageId: 'm' },
  }
  await store.deleteChat('a')
  assert.equal(store.chatState.active.meta.id, 'a')
  assert.equal(store.chatState.list.length, 2)
  assert.equal(store.generationState.status, 'idle')
  assert.deepEqual(events, ['error'])
})

test('an in-flight completion cannot reset a newer generation', async () => {
  const saving = deferred()
  const { store } = setup()
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
  assert.equal(store.generationState.stream, nextStream)
  assert.equal(store.generationState.status, 'streaming')
})

test('late events after deletion do not modify a new chat', async () => {
  const { store, events } = setup()
  store.chatState.active = { meta: { id: 'b' }, messages: [] }
  store.generationState = {
    status: 'streaming',
    stream: { chatId: 'b', requestId: 'next' },
  }
  const oldEvent = { chatId: 'a', requestId: 'r' }
  assert.equal(await store.handleStreamChunk(oldEvent), false)
  await store.handleStreamEnd(oldEvent)
  await store.handleStreamError(oldEvent)
  assert.equal(store.generationState.stream.requestId, 'next')
  assert.deepEqual(events, [])
})

test('unsupported attachments stay in history but are left out of the request', async () => {
  const sent = []
  const { store, events } = setup(
    { deleteMessages: async () => {} },
    {
      apiAdapter: {
        createApiRequest: async ({ messages }) => {
          sent.push(plain(messages))
          return {}
        },
      },
      showWarningToast: (message) => events.push(message),
    }
  )
  const video = { id: 'v', mimeType: 'video/mp4' }
  const image = { id: 'i', mimeType: 'image/png' }
  const history = [
    { id: 'u', sender: 'user', attachments: [video, image] },
    { id: 'p', sender: 'user', attachments: [image] },
  ]
  store.uiSignals = { scrollToken: 0 }
  store.composerState = {
    attachmentBucket: { isUnsupported: (att) => att.mimeType === 'video/mp4' },
  }
  await store._executeGeneration({
    chatId: 'a',
    requestMessages: history,
    modelMessage: { id: 'm', requestId: 'r' },
    requestConfig: { model: 'claude' },
  })
  assert.deepEqual(
    sent[0].map((message) => message.attachments.map((att) => att.id)),
    [['i'], ['i']]
  )
  assert.equal(history[0].attachments.length, 2)
  assert.deepEqual(events, [
    '1 attachment(s) not sent: unsupported by the current model.',
  ])
})
