import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'

// Exercise the socket lifecycle without starting a server or loading API keys.
const source = await readFile(new URL('../server.js', import.meta.url), 'utf8')
const helpers = source.slice(
  source.indexOf('function emitWithAck('),
  source.indexOf('const getConnectedClientCount')
)
const handlersSource = source.slice(
  source.indexOf("io.on('connection'"),
  source.indexOf('// --- Stdin commands')
)

function setup() {
  const handlers = {}
  const events = []
  const signals = new Map()
  const wait = ({ signal, requestId }) => {
    signals.set(requestId, signal)
    return new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), {
        once: true,
      })
    })
  }
  const provider = {
    supportsStreamAbort: true,
    supportsAbort: true,
    generate: wait,
    async *generateStream(req) {
      await wait(req)
    },
  }
  const socket = {
    id: 'socket',
    connected: true,
    on: (event, handler) => {
      handlers[event] = handler
    },
    emit: (event, data) => events.push({ event, data }),
  }
  runInNewContext(`${helpers}\n${handlersSource}`, {
    io: { on: (_, callback) => callback(socket) },
    console: { log() {}, error() {} },
    connectionInfo: {},
    updateConnectionInfo() {},
    numberOr: (value, fallback) => value ?? fallback,
    normalizeModelName: (model) => model,
    resolveProviderId: () => 'gemini',
    specialRegistry: { isSpecial: () => false },
    providerRegistry: { get: () => provider },
    AbortController,
    defaultSystemInstruction: '',
    systemInstructionMode: 'replace',
  })
  const start = (requestId, streaming = true) =>
    handlers.start_generation({
      chatId: 'chat',
      requestId,
      model: 'gemini-2.5-flash',
      messages: [],
      streaming,
    })
  return { handlers, events, signals, start, socket }
}

for (const streaming of [true, false]) {
  test(`Stop aborts a waiting ${streaming ? 'streaming' : 'non-streaming'} request`, async () => {
    const { handlers, signals, start, events } = setup()
    const pending = start('r', streaming)
    handlers.cancel_generation({ chatId: 'chat', requestId: 'unrelated' })
    assert.equal(signals.get('r').aborted, false)
    handlers.cancel_generation({ chatId: 'chat', requestId: 'r' })
    await pending
    assert.equal(signals.get('r').aborted, true)
    assert.equal(events.at(-1).data.reason, 'cancelled')
  })
}

test('a superseded request cannot clear or abort the newer generation', async () => {
  const { handlers, signals, start } = setup()
  const old = start('old')
  const next = start('next')
  await old
  await setImmediate()
  assert.equal(signals.get('old').aborted, true)
  assert.equal(signals.get('next').aborted, false)
  handlers.cancel_generation({ chatId: 'chat', requestId: 'next' })
  assert.equal(signals.get('next').aborted, true)
  await next
})

test('disconnect aborts a pending Flex wait', async () => {
  const { handlers, signals, start, socket } = setup()
  const pending = start('r')
  socket.connected = false
  handlers.disconnect()
  assert.equal(signals.get('r').aborted, true)
  await pending
})
