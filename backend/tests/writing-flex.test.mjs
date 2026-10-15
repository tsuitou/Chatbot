import assert from 'node:assert/strict'
import test from 'node:test'
import { GeminiProvider } from '../providers/gemini.js'
import { OpenRouterProvider } from '../providers/openrouter.js'
import { eventFromParts } from '../providers/events.js'
import { FLEX_TIMEOUT_MS } from '../providers/generationOptions.js'

const text = '「夜の街」\nShe said "hello". \\道 🌙\n\n最後の行'
const call = { name: 'submit_writing', args: { content: text } }
const request = (provider, parameters = {}) => ({
  model: provider === 'gemini' ? 'gemini-2.5-flash' : 'google/gemini-2.5-flash',
  chatId: 'chat',
  requestId: 'request',
  parameters,
  messages: [
    { role: 'user', parts: [{ type: 'text', text: 'Write a story.' }] },
  ],
})
async function* stream(chunks) {
  yield* chunks
}
async function collect(iterator) {
  const events = []
  for await (const event of iterator) events.push(event)
  return events
}
const bodyText = (events) =>
  events.map((event) => event.deltaText || '').join('')
function gemini() {
  return new GeminiProvider('test-key', 'System')
}
function router() {
  const provider = new OpenRouterProvider('test-key', 'System')
  provider._getModelMetadata = async () => ({
    supported_parameters: ['tools', 'tool_choice'],
  })
  return provider
}
const geminiChunk = (parts, finishReason, tier) => ({
  candidates: [{ content: { parts }, finishReason }],
  ...(tier
    ? {
        usageMetadata: {
          serviceTier: tier,
          promptTokenCount: 10,
          candidatesTokenCount: 20,
        },
      }
    : {}),
})
const routerChunk = (delta, finish_reason = null) => ({
  choices: [{ delta, finish_reason }],
})

test('Gemini builds Flex and forced writing configuration without leaking app parameters', () => {
  const provider = gemini()
  const signal = new AbortController().signal
  const built = provider._buildRequest({
    ...request('gemini', { serviceTier: 'flex', writingFunctionCall: true }),
    signal,
    tools: { grounding: true, codeExecution: true },
  })
  assert.equal(built.config.serviceTier, 'flex')
  assert.equal(built.config.httpOptions.timeout, FLEX_TIMEOUT_MS)
  assert.equal(built.config.httpOptions.retryOptions.attempts, 3)
  assert.equal(built.config.abortSignal, signal)
  assert.equal(built.config.writingFunctionCall, undefined)
  assert.deepEqual(built.config.toolConfig, {
    functionCallingConfig: {
      mode: 'ANY',
      allowedFunctionNames: ['submit_writing'],
    },
  })
  assert.equal(built.config.tools.length, 1)
  assert.equal(
    built.config.tools[0].functionDeclarations[0].name,
    'submit_writing'
  )
})

test('Gemini streams reasoning, then publishes validated writing once without signatures or preamble', async () => {
  const provider = gemini()
  provider.genAI.models.generateContentStream = async () =>
    stream([
      geminiChunk([
        { text: 'thinking', thought: true, thoughtSignature: 'thought-sig' },
      ]),
      geminiChunk([
        { text: 'Here is your story:' },
        { functionCall: call, thoughtSignature: 'call-sig' },
      ]),
      geminiChunk([], 'STOP', 'flex'),
    ])
  const events = await collect(
    provider.generateStream(
      request('gemini', { serviceTier: 'flex', writingFunctionCall: true })
    )
  )
  assert.equal(bodyText(events), text)
  assert.equal(events[0].thoughtDelta, 'thinking')
  assert.equal(events.at(-1).metadata.writingFunctionCall, 'used')
  assert.equal(events.at(-1).metadata.serviceTier, 'flex')
  assert.ok(events.every((event) => !event.metadata?.thoughtSignatures))
})

test('Gemini non-stream writing is a single request and preserves token usage', async () => {
  const provider = gemini()
  let calls = 0
  provider.genAI.models.generateContent = async () => {
    calls++
    return geminiChunk(
      [{ functionCall: call, thoughtSignature: 'sig' }],
      'STOP',
      'flex'
    )
  }
  const result = await provider.generate(
    request('gemini', { writingFunctionCall: true })
  )
  assert.equal(calls, 1)
  assert.equal(result.deltaText, text)
  assert.equal(result.metadata.usage.prompt, 10)
  assert.equal(result.metadata.writingFunctionCall, 'used')
  assert.equal(result.metadata.thoughtSignatures, undefined)
})

test('normal Gemini text, built-in tools and final text signatures still work', async () => {
  const provider = gemini()
  const config = provider._buildRequest({
    ...request('gemini'),
    tools: { grounding: true },
  }).config
  assert.deepEqual(config.tools, [{ googleSearch: {} }])
  provider.genAI.models.generateContentStream = async () =>
    stream([
      geminiChunk([{ text: 'normal', thoughtSignature: 'text-sig' }], 'STOP'),
    ])
  const events = await collect(provider.generateStream(request('gemini')))
  assert.equal(bodyText(events), 'normal')
  assert.deepEqual(events[0].metadata.thoughtSignatures, [
    { signature: 'text-sig' },
  ])
  assert.equal(events[0].metadata.writingFunctionCall, undefined)
})

for (const [parts, reason, status] of [
  [[{ text: 'ordinary response' }], 'STOP', 'not_used'],
  [
    [{ functionCall: { name: 'submit_writing', args: { content: 123 } } }],
    'STOP',
    'invalid',
  ],
  [
    [{ functionCall: { name: 'unknown', args: { content: text } } }],
    'STOP',
    'invalid',
  ],
  [[{ functionCall: call }], 'MAX_TOKENS', 'incomplete'],
  [[{ functionCall: call }], undefined, 'incomplete'],
]) {
  test(`Gemini rejects ${status} writing (${reason}) without publishing text`, async () => {
    const provider = gemini()
    provider.genAI.models.generateContentStream = async () =>
      stream([geminiChunk(parts, reason)])
    const emitted = []
    await assert.rejects(
      async () => {
        for await (const event of provider.generateStream(
          request('gemini', { writingFunctionCall: true })
        ))
          emitted.push(event)
      },
      (error) => error.metadata?.writingFunctionCall === status
    )
    assert.equal(bodyText(emitted), '')
  })
}

test('function-call signatures are not treated as text signatures by shared events', () => {
  const result = eventFromParts({
    provider: 'gemini',
    parts: [{ functionCall: call, thoughtSignature: 'call-sig' }],
  })
  assert.equal(result.metadata?.thoughtSignatures, undefined)
})

test('OpenRouter reassembles JSON split at every character, including escape sequences', async () => {
  const provider = router()
  let sent
  let count = 0
  provider.client.chat.completions.create = async (body) => {
    sent = body
    count++
    return stream([
      routerChunk({
        reasoning: 'thinking',
        content: 'preamble',
        tool_calls: [
          {
            index: 0,
            id: 'call-0',
            function: { name: 'submit_writing', arguments: '' },
          },
        ],
      }),
      ...[...JSON.stringify({ content: text })].map((fragment) =>
        routerChunk({
          tool_calls: [{ index: 0, function: { arguments: fragment } }],
        })
      ),
      routerChunk({}, 'tool_calls'),
      {
        choices: [],
        service_tier: 'flex',
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      },
    ])
  }
  const events = await collect(
    provider.generateStream(
      request('openrouter', { writingFunctionCall: true })
    )
  )
  assert.equal(count, 1)
  assert.deepEqual(sent.tool_choice, {
    type: 'function',
    function: { name: 'submit_writing' },
  })
  assert.equal(sent.provider.require_parameters, true)
  assert.equal(sent.writingFunctionCall, undefined)
  assert.equal(bodyText(events), text)
  assert.equal(events.at(-1).metadata.writingFunctionCall, 'used')
  assert.equal(events.at(-1).metadata.serviceTier, 'flex')
  assert.ok(events.some((event) => event.metadata?.usage?.output === 20))
})

test('OpenRouter non-stream writing preserves reasoning and ignores ordinary content', async () => {
  const provider = router()
  provider.client.chat.completions.create = async () => ({
    service_tier: 'default',
    choices: [
      {
        finish_reason: 'tool_calls',
        message: {
          reasoning: 'thinking',
          content: 'preamble',
          tool_calls: [
            {
              function: {
                name: 'submit_writing',
                arguments: JSON.stringify({ content: text }),
              },
            },
          ],
        },
      },
    ],
  })
  const result = await provider.generate(
    request('openrouter', { writingFunctionCall: true })
  )
  assert.equal(result.deltaText, text)
  assert.equal(result.thoughtDelta, 'thinking')
  assert.equal(result.metadata.serviceTier, 'standard')
  assert.equal(result.metadata.writingFunctionCall, 'used')
})

for (const [args, reason, status] of [
  ['{"content":"unfinished', 'tool_calls', 'invalid'],
  ['{"content":""}', 'tool_calls', 'invalid'],
  [JSON.stringify({ content: text }), 'length', 'incomplete'],
  [JSON.stringify({ content: text }), null, 'incomplete'],
]) {
  test(`OpenRouter rejects ${status} arguments (${reason})`, async () => {
    const provider = router()
    provider.client.chat.completions.create = async () =>
      stream([
        routerChunk(
          {
            tool_calls: [
              {
                index: 0,
                function: { name: 'submit_writing', arguments: args },
              },
            ],
          },
          reason
        ),
      ])
    await assert.rejects(
      collect(
        provider.generateStream(
          request('openrouter', { writingFunctionCall: true })
        )
      ),
      (error) => error.metadata?.writingFunctionCall === status
    )
  })
}

test('OpenRouter transport failure retains incomplete status and actual tier', async () => {
  const provider = router()
  provider.client.chat.completions.create = async () =>
    (async function* () {
      yield {
        ...routerChunk({
          tool_calls: [
            { index: 0, function: { name: 'submit_writing', arguments: '{' } },
          ],
        }),
        service_tier: 'flex',
      }
      throw new Error('connection lost')
    })()
  await assert.rejects(
    collect(
      provider.generateStream(
        request('openrouter', { writingFunctionCall: true })
      )
    ),
    (error) =>
      error.metadata.writingFunctionCall === 'incomplete' &&
      error.metadata.serviceTier === 'flex'
  )
})

test('OpenRouter keeps multiple interleaved calls in index order', async () => {
  const provider = router()
  provider.client.chat.completions.create = async () =>
    stream([
      routerChunk({
        tool_calls: [
          {
            index: 1,
            function: { name: 'submit_writing', arguments: '{"content":' },
          },
          {
            index: 0,
            function: {
              name: 'submit_writing',
              arguments: '{"content":"First"}',
            },
          },
        ],
      }),
      routerChunk(
        { tool_calls: [{ index: 1, function: { arguments: '"Second"}' } }] },
        'tool_calls'
      ),
    ])
  const events = await collect(
    provider.generateStream(
      request('openrouter', { writingFunctionCall: true })
    )
  )
  assert.equal(bodyText(events), 'First\n\nSecond')
})

test('OpenRouter Flex restricts routing to actual Flex endpoint tags', async () => {
  const provider = router()
  provider._getModelProviderOptions = async () => [
    { id: 'google-ai-studio', serviceTier: 'standard' },
    { id: 'google-ai-studio/flex', serviceTier: 'flex' },
    { id: 'google-vertex/flex', serviceTier: 'flex' },
  ]
  const req = {
    ...request('openrouter', {
      serviceTier: 'flex',
      writingFunctionCall: true,
    }),
    routing: {
      provider: { only: ['google-ai-studio'], allow_fallbacks: false },
    },
  }
  const body = await provider._prepareRequest(req)
  assert.equal(body.service_tier, 'flex')
  assert.deepEqual(body.provider.only, ['google-ai-studio/flex'])
  assert.equal(body.provider.allow_fallbacks, false)
  assert.equal(body.provider.require_parameters, true)
  assert.equal(provider._requestOptions(req).timeout, FLEX_TIMEOUT_MS)
  assert.equal(provider._requestOptions(req).maxRetries, 2)
})

test('OpenRouter cannot silently switch from Flex to Standard', async () => {
  const provider = router()
  provider._getModelProviderOptions = async () => [
    { id: 'google-ai-studio', serviceTier: 'standard' },
  ]
  let called = false
  provider.client.chat.completions.create = async () => {
    called = true
  }
  await assert.rejects(
    provider.generate(request('openrouter', { serviceTier: 'flex' })),
    /No Flex endpoint/
  )
  assert.equal(called, false)
})

test('OpenRouter Flex respects ignored endpoints and fails on conflicting selection', async () => {
  const provider = router()
  provider._getModelProviderOptions = async () => [
    { id: 'google-ai-studio/flex', serviceTier: 'flex' },
  ]
  for (const routing of [
    { provider: { ignore: ['google-ai-studio'] } },
    { provider: { only: ['google-vertex'] } },
  ]) {
    await assert.rejects(
      provider._prepareRequest({
        ...request('openrouter', { serviceTier: 'flex' }),
        routing,
      }),
      /No Flex endpoint/
    )
  }
})

test('OpenRouter endpoint discovery retains tier tags and caches successful results', async (t) => {
  const provider = router()
  let fetches = 0
  t.mock.method(globalThis, 'fetch', async (url) => {
    fetches++
    assert.equal(
      url,
      'https://openrouter.ai/api/v1/models/google/gemini-2.5-flash/endpoints'
    )
    return {
      ok: true,
      json: async () => ({
        data: {
          endpoints: [
            {
              provider_name: 'Google AI Studio',
              tag: 'google-ai-studio',
              pricing: { prompt: '0.3' },
            },
            {
              provider_name: 'Google AI Studio',
              tag: 'google-ai-studio/flex',
              pricing: { prompt: '0.15' },
            },
          ],
        },
      }),
    }
  })
  const options = await provider._getModelProviderOptions(
    'google/gemini-2.5-flash',
    null
  )
  assert.equal(options.length, 2)
  assert.equal(options[1].id, 'google-ai-studio/flex')
  assert.equal(options[1].serviceTier, 'flex')
  await provider._getModelProviderOptions('google/gemini-2.5-flash', null)
  assert.equal(fetches, 1)
})

test('capabilities expose English controls only for supported model families', async () => {
  const direct = gemini()
  direct._resolveOutputTokenLimit = async () => 65536
  const cap = await direct.getModelCapabilities('gemini-2.5-flash')
  assert.equal(cap.parameters.serviceTier.default, 'standard')
  assert.equal(cap.parameters.writingFunctionCall.default, false)
  assert.equal(
    cap.parameters.writingFunctionCall.label,
    'Writing Function Call'
  )
  assert.equal(
    (await direct.getModelCapabilities('gemini-3-pro-image')).parameters
      .writingFunctionCall,
    undefined
  )
  const provider = router()
  provider._getModelProviderOptions = async () => []
  assert.equal(
    (await provider.getModelCapabilities('google/gemini-2.5-flash')).parameters
      .serviceTier.label,
    'Service Tier'
  )
  assert.equal(
    (await provider.getModelCapabilities('anthropic/claude-sonnet')).parameters
      .writingFunctionCall,
    undefined
  )
  provider._getModelMetadata = async () => ({
    supported_parameters: ['temperature'],
  })
  assert.equal(
    (await provider.getModelCapabilities('google/gemini-2.5-flash')).parameters
      .writingFunctionCall,
    undefined
  )
  await assert.rejects(
    provider._prepareRequest(
      request('openrouter', { writingFunctionCall: true })
    ),
    /not supported/
  )
})

test('invalid settings and unsupported models fail before requesting inference', () => {
  assert.throws(
    () =>
      gemini()._buildRequest(request('gemini', { serviceTier: 'priority' })),
    /Standard or Flex/
  )
  assert.throws(
    () =>
      gemini()._buildRequest(
        request('gemini', { writingFunctionCall: 'true' })
      ),
    /enabled or disabled/
  )
  assert.throws(
    () =>
      router()._buildRequest({
        ...request('openrouter', { writingFunctionCall: true }),
        model: 'anthropic/claude-sonnet',
      }),
    /not supported/
  )
})

test('Gemini SDK serializes Flex and the writing declaration through the HTTP boundary', async (t) => {
  let payload
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    payload = JSON.parse(options.body)
    return new Response(
      JSON.stringify(geminiChunk([{ functionCall: call }], 'STOP', 'flex')),
      {
        headers: { 'Content-Type': 'application/json' },
      }
    )
  })
  const result = await gemini().generate(
    request('gemini', { serviceTier: 'flex', writingFunctionCall: true })
  )
  assert.equal(payload.serviceTier, 'flex')
  assert.equal(payload.toolConfig.functionCallingConfig.mode, 'ANY')
  assert.equal(payload.tools[0].functionDeclarations[0].name, 'submit_writing')
  assert.equal(result.deltaText, text)
  assert.equal(result.metadata.serviceTier, 'flex')
})

test('OpenRouter SDK serializes Flex and forced writing through the HTTP boundary', async (t) => {
  let payload
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    payload = JSON.parse(options.body)
    return new Response(
      JSON.stringify({
        service_tier: 'flex',
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              tool_calls: [
                {
                  function: {
                    name: 'submit_writing',
                    arguments: JSON.stringify({ content: text }),
                  },
                },
              ],
            },
          },
        ],
      }),
      { headers: { 'Content-Type': 'application/json' } }
    )
  })
  const provider = router()
  provider._getModelProviderOptions = async () => [
    { id: 'google-ai-studio/flex', serviceTier: 'flex' },
  ]
  const result = await provider.generate(
    request('openrouter', { serviceTier: 'flex', writingFunctionCall: true })
  )
  assert.equal(payload.service_tier, 'flex')
  assert.deepEqual(payload.provider.only, ['google-ai-studio/flex'])
  assert.equal(payload.tool_choice.function.name, 'submit_writing')
  assert.equal(result.deltaText, text)
})
