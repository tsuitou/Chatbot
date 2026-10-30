import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { createServer } from 'node:http'

// Runs the browser build's path end to end against a mock OpenAI-compatible
// server: stored config -> shared runtime -> real OpenAI SDK -> handlers.
let server
let port
const received = []

const storedConfig = { keys: {}, settings: {}, files: {} }
vi.mock('../../../src/services/local/config', async (importOriginal) => ({
  ...(await importOriginal()),
  loadConfig: async () => storedConfig,
}))
vi.mock('../../../src/services/notification', () => ({
  showWarningToast: vi.fn(),
}))

beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    if (req.url === '/v1/models') {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model' }] }))
      return
    }
    let body = ''
    req.on('data', (data) => (body += data))
    req.on('end', () => {
      received.push(JSON.parse(body))
      res.setHeader('Content-Type', 'text/event-stream')
      const base = {
        id: 'x',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'mock-model',
      }
      const send = (chunk) =>
        res.write(`data: ${JSON.stringify({ ...base, ...chunk })}\n\n`)
      send({ choices: [{ index: 0, delta: { reasoning_content: 'hmm' } }] })
      send({ choices: [{ index: 0, delta: { content: 'Hello ' } }] })
      send({
        choices: [
          { index: 0, delta: { content: 'there' }, finish_reason: 'stop' },
        ],
      })
      send({
        choices: [],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      })
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = server.address().port
  storedConfig.settings.defaultModel = 'mock-model'
  storedConfig.files.systemInstruction = { text: 'Be brief.', baseHash: '' }
  storedConfig.files.openaiEndpoints = {
    text: JSON.stringify([
      { label: 'Mock', baseUrl: `http://127.0.0.1:${port}/v1` },
    ]),
    baseHash: '',
  }
})

afterAll(() => server?.close())

describe('browser build against an OpenAI-compatible endpoint', () => {
  it('lists the endpoint models and the configured default', async () => {
    const catalog = await import('../../../src/services/local/catalog')
    const groups = await catalog.getModels()
    expect(groups.at(-1)).toEqual({
      provider: 'openai-compat',
      label: 'Mock',
      models: ['mock-model'],
    })
    expect(await catalog.getDefaultModel()).toBe('mock-model')
    const capabilities = await catalog.getModelCapabilities(
      'mock-model',
      'openai-compat'
    )
    expect(capabilities).toMatchObject({
      provider: 'openai-compat',
      label: 'Mock',
    })
  })

  it('streams a response through the socket-compatible handlers', async () => {
    const generation = await import('../../../src/services/local/generation')
    const chunks = []
    const onEnd = vi.fn()
    const onError = vi.fn()
    generation.registerSocketHandlers({
      onChunk: async (chunk) => {
        chunks.push(chunk)
        return true
      },
      onEnd,
      onError,
    })
    generation.startGeneration({
      chatId: 'c',
      requestId: 'r',
      model: 'mock-model',
      provider: 'openai-compat',
      streaming: true,
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
      parameters: {},
      tools: {},
      systemInstruction: '',
    })
    await vi.waitFor(() => expect(onEnd).toHaveBeenCalled(), { timeout: 5000 })
    expect(onError).not.toHaveBeenCalled()
    expect(onEnd).toHaveBeenCalledWith({
      ok: true,
      chatId: 'c',
      requestId: 'r',
    })
    expect(chunks.map((c) => c.deltaText || '').join('')).toBe('Hello there')
    expect(chunks.map((c) => c.thoughtDelta || '').join('')).toBe('hmm')
    expect(chunks.at(-1).metadata.usage).toMatchObject({
      prompt: 3,
      output: 2,
      total: 5,
    })
    expect(received.at(-1)).toMatchObject({
      model: 'mock-model',
      stream: true,
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      ],
    })
  })
})
