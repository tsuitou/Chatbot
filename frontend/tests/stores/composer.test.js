import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { getModelCapabilities } from '../../src/services/api'
import { useComposerStore } from '../../src/stores/composer'
import { useModelsStore } from '../../src/stores/models'

const GEMINI_CAPS = {
  tools: { googleSearch: { enabled: true } },
  attachments: { enabled: true },
}

vi.mock('../../src/services/api', () => ({
  getModelCapabilities: vi.fn(async (model, providerId) =>
    providerId === 'gemini' ? GEMINI_CAPS : { tools: {}, attachments: {} }
  ),
  uploadFile: vi.fn(),
}))
vi.mock('../../src/services/db', () => ({}))
vi.mock('../../src/services/notification', () => ({ showErrorToast: vi.fn() }))

beforeEach(() => {
  setActivePinia(createPinia())
  vi.mocked(getModelCapabilities).mockClear()
})

describe('provider resolution', () => {
  // The composer may not know the provider (e.g. a plain model list), but
  // the model's saved settings do; capabilities must be looked up for the
  // same provider the request will go to.
  it('falls back to the provider in the model settings everywhere', async () => {
    useModelsStore().setModelSettings({ m: { providerId: 'gemini' } })
    const composer = useComposerStore()
    await composer.selectModel('m', null)

    expect(composer.requestConfig.providerId).toBe('gemini')
    expect(getModelCapabilities).toHaveBeenCalledWith('m', 'gemini')
    expect(composer.capabilities).toEqual(GEMINI_CAPS)
    expect(composer.tools).toEqual({ googleSearch: false })

    // What sendMessage does before sending must hit the same cache entry.
    const { model, providerId } = composer.requestConfig
    await useModelsStore().ensureModelCapabilities(model, providerId)
    expect(getModelCapabilities).toHaveBeenCalledTimes(1)
  })

  it('an explicit provider wins over the settings', async () => {
    useModelsStore().setModelSettings({ m: { providerId: 'gemini' } })
    const composer = useComposerStore()
    await composer.selectModel('m', 'openrouter')
    expect(composer.requestConfig.providerId).toBe('openrouter')
    expect(getModelCapabilities).toHaveBeenCalledWith('m', 'openrouter')
  })
})
