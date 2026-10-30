import { describe, it, expect, vi, beforeEach } from 'vitest'

// A runtime whose generation is driven by the test: each chunk is released
// by calling next(), and the run ends when the test calls finish().
let job
const runtime = { prepareGeneration: vi.fn(() => job) }
vi.mock('../../../src/services/local/runtime', () => ({
  getRuntime: async () => runtime,
}))

const {
  registerSocketHandlers,
  connectSocket,
  startGeneration,
  cancelBackendGeneration,
} = await import('../../../src/services/local/generation')

const handlers = {
  onChunk: vi.fn(async () => true),
  onEnd: vi.fn(),
  onError: vi.fn(),
  onConnectionChange: vi.fn(),
}

const payload = { chatId: 'c', requestId: 'r', model: 'm', messages: [] }

function streamOf(chunks, { failWith } = {}) {
  return {
    abortable: true,
    async *run(signal) {
      for (const chunk of chunks) {
        signal?.throwIfAborted()
        await Promise.resolve()
        yield chunk
      }
      if (failWith) throw failWith
    },
  }
}

beforeEach(() => {
  Object.values(handlers).forEach((fn) => fn.mockClear())
  handlers.onChunk.mockImplementation(async () => true)
  registerSocketHandlers(handlers)
})

describe('local generation', () => {
  it('reports connected even when handlers register after connecting', () => {
    connectSocket()
    const late = vi.fn()
    registerSocketHandlers({ onConnectionChange: late })
    expect(late).toHaveBeenCalledWith('connected')
    registerSocketHandlers(handlers)
  })

  it('streams chunks and ends like the server does', async () => {
    job = streamOf([{ deltaText: 'a' }, { deltaText: 'b' }])
    startGeneration(payload)
    await vi.waitFor(() => expect(handlers.onEnd).toHaveBeenCalled())
    expect(handlers.onChunk.mock.calls.map(([c]) => c.deltaText)).toEqual([
      'a',
      'b',
    ])
    expect(handlers.onEnd).toHaveBeenCalledWith({
      ok: true,
      chatId: 'c',
      requestId: 'r',
    })
  })

  it('passes a plain copy of the payload to the runtime', async () => {
    job = streamOf([])
    const blob = new Blob(['x'])
    startGeneration({ ...payload, extra: undefined, blob })
    await vi.waitFor(() => expect(handlers.onEnd).toHaveBeenCalled())
    const received = runtime.prepareGeneration.mock.calls.at(-1)[0]
    expect(received).not.toHaveProperty('extra')
    expect(received.blob).toEqual({})
  })

  it('reports provider errors with status and metadata', async () => {
    const error = Object.assign(new Error('boom'), {
      status: 429,
      metadata: { tier: 'flex' },
    })
    job = streamOf([{ deltaText: 'a' }], { failWith: error })
    startGeneration(payload)
    await vi.waitFor(() => expect(handlers.onError).toHaveBeenCalled())
    expect(handlers.onError).toHaveBeenCalledWith({
      error: 'boom',
      message: 'boom',
      status: 429,
      chatId: 'c',
      requestId: 'r',
      metadata: { tier: 'flex' },
    })
    expect(handlers.onEnd).not.toHaveBeenCalled()
  })

  it('ends as aborted when the matching request is cancelled', async () => {
    job = streamOf([{ deltaText: 'a' }, { deltaText: 'b' }, { deltaText: 'c' }])
    handlers.onChunk.mockImplementationOnce(async () => {
      cancelBackendGeneration({ chatId: 'c', requestId: 'other' })
      cancelBackendGeneration({ chatId: 'c', requestId: 'r' })
      return true
    })
    startGeneration(payload)
    await vi.waitFor(() => expect(handlers.onEnd).toHaveBeenCalled())
    expect(handlers.onChunk).toHaveBeenCalledOnce()
    expect(handlers.onEnd).toHaveBeenCalledWith({
      ok: false,
      aborted: true,
      reason: 'cancelled',
      chatId: 'c',
      requestId: 'r',
    })
  })

  it('stops reading when a chunk is rejected, even if the provider ignores the signal', async () => {
    job = {
      ...streamOf([{ deltaText: 'a' }, { deltaText: 'b' }]),
      abortable: false,
    }
    job.run = async function* () {
      yield { deltaText: 'a' }
      yield { deltaText: 'b' }
    }
    handlers.onChunk.mockImplementation(async () => false)
    startGeneration(payload)
    await vi.waitFor(() => expect(handlers.onEnd).toHaveBeenCalled())
    expect(handlers.onChunk).toHaveBeenCalledOnce()
    expect(handlers.onEnd.mock.calls[0][0]).toMatchObject({
      aborted: true,
      reason: 'chunk_rejected',
    })
  })
})
