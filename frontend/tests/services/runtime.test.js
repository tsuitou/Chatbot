import { describe, it, expect } from 'vitest'
import { createRuntime } from '../../../backend/runtime.js'

const collect = async (iterable) => {
  const items = []
  for await (const item of iterable) items.push(item)
  return items
}

describe('shared runtime', () => {
  it('lists only the special models without keys', async () => {
    const runtime = createRuntime()
    expect(runtime.hasProvider()).toBe(false)
    expect(await runtime.listModelGroups()).toEqual([
      { provider: 'virtual', label: 'Special', models: ['dummy'] },
    ])
    expect(runtime.defaultModel()).toBe('')
  })

  it('runs the dummy model without a provider', async () => {
    const job = createRuntime().prepareGeneration({
      model: 'dummy',
      chatId: 'c',
      requestId: 'r',
    })
    expect(job).toMatchObject({ special: true, abortable: false })
    expect(await collect(job.run())).toEqual([
      {
        chatId: 'c',
        requestId: 'r',
        provider: 'virtual',
        deltaText: '',
        finishReason: 'stop',
      },
    ])
  })

  it('rejects requests for providers that are not configured', () => {
    const runtime = createRuntime()
    expect(() => runtime.prepareGeneration({})).toThrow('model is required')
    expect(() =>
      runtime.prepareGeneration({ model: 'gemini-x', messages: [] })
    ).toThrow('gemini provider is not configured')
  })

  it('registers OpenAI-compatible endpoints from the parsed config', async () => {
    const runtime = createRuntime({
      settings: { defaultModel: 'models/local-model' },
      openaiCompatConfig: [
        { baseUrl: 'http://127.0.0.1:9/v1', models: ['local-model'] },
        { label: 'skipped: no baseUrl' },
      ],
      capabilities: { 'openai-compat': { label: 'Compat', defaults: {} } },
    })
    expect(runtime.hasProvider()).toBe(true)
    expect(runtime.openaiCompatIds).toEqual(['openai-compat'])
    expect(runtime.defaultModel()).toBe('local-model')
    // The endpoint is unreachable, so the configured list is used.
    const groups = await runtime.listModelGroups()
    expect(groups.at(-1)).toEqual({
      provider: 'openai-compat',
      label: 'Compat',
      models: ['local-model'],
    })
    const job = runtime.prepareGeneration({
      model: 'local-model',
      provider: 'openai-compat',
      messages: [],
      streaming: true,
    })
    expect(job).toMatchObject({ providerId: 'openai-compat', abortable: true })
  })

  it('refuses uploads the model policy does not allow', async () => {
    const runtime = createRuntime({
      openaiCompatConfig: { baseUrl: 'http://127.0.0.1:9/v1' },
    })
    await expect(
      runtime.uploadFile(new Blob(['x']), { mimeType: 'text/plain' })
    ).rejects.toMatchObject({
      status: 400,
      message: 'Model is required for file upload.',
    })
    await expect(
      runtime.uploadFile(new Blob(['x']), {
        mimeType: 'text/plain',
        model: 'm',
        provider: 'openai-compat',
      })
    ).rejects.toMatchObject({ status: 400, provider: 'openai-compat' })
  })
})
