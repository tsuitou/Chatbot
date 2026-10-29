// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { it, expect, vi } from 'vitest'
import { shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import * as db from '../../src/services/db'
import App from '../../src/App.vue'
import { useChatConfigStore } from '../../src/stores/chatConfig'
import { useComposerStore } from '../../src/stores/composer'

vi.mock('../../src/services/socket', () => ({
  connectSocket: vi.fn(),
  registerSocketHandlers: vi.fn(),
  startGeneration: vi.fn(),
  cancelBackendGeneration: vi.fn(),
}))
vi.mock('../../src/services/api', () => ({
  getModels: vi.fn(async () => [
    { provider: 'virtual', models: ['agent'] },
    { provider: 'gemini', models: ['gemini-a', 'gemini-b'] },
  ]),
  getDefaultModel: vi.fn(async () => 'gemini-b'),
  getModelCapabilities: vi.fn(async () => ({ attachments: { enabled: true } })),
  uploadFile: vi.fn(),
}))
vi.mock('../../src/services/notification', () => ({
  showErrorToast: vi.fn(),
  showWarningToast: vi.fn(),
  showSuccessToast: vi.fn(),
}))

it('starts with the default model and its default system prompt', async () => {
  await db.putModelSettings({
    'gemini-b': { providerId: 'gemini', systemPrompt: 'Be brief.' },
  })
  const pinia = createPinia()
  setActivePinia(pinia)

  const wrapper = shallowMount(App, { global: { plugins: [pinia] } })
  const composer = useComposerStore()
  // Startup is several IndexedDB round trips; wait until it has settled.
  await vi.waitFor(() => expect(composer.model).toBe('gemini-b'))
  await new Promise((resolve) => setTimeout(resolve, 50))

  expect(composer.providerId).toBe('gemini')
  expect(useChatConfigStore().getSystemPrompt(null)).toBe('Be brief.')
  wrapper.unmount()
})
