// @vitest-environment happy-dom
import { it, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import SettingsModal from '../../src/components/SettingsModal.vue'

const { db, store } = vi.hoisted(() => {
  const capabilities = {
    parameters: {
      serviceTier: {
        type: 'enum',
        label: 'Service Tier',
        default: 'standard',
        options: [
          { label: 'Standard', value: 'standard' },
          { label: 'Flex', value: 'flex' },
        ],
      },
      writingFunctionCall: {
        type: 'boolean',
        label: 'Writing Function Call',
        default: false,
        hint: 'Text appears when complete.',
      },
    },
    routing: {
      providerSelection: {
        options: [
          {
            id: 'google-ai-studio',
            label: 'Google AI Studio',
            serviceTier: 'standard',
          },
          {
            id: 'google-ai-studio/flex',
            label: 'Google AI Studio (Flex)',
            serviceTier: 'flex',
          },
        ],
      },
    },
  }
  const db = {
    persisted: {},
    getModelSettings: async () => db.persisted,
    putModelSettings: async (value) => {
      db.persisted = JSON.parse(JSON.stringify(value))
    },
  }
  const store = {
    availableModels: [
      { provider: 'gemini', models: ['gemini-2.5-flash'] },
      { provider: 'openrouter', models: ['google/gemini-2.5-flash'] },
    ],
    composerState: { model: 'gemini-2.5-flash', providerId: 'gemini' },
    ensureModelCapabilities: async () => capabilities,
    applied: null,
    setModelSettings: (value) => {
      store.applied = value
    },
  }
  return { db, store }
})

vi.mock('../../src/services/db', () => ({
  getModelSettings: () => db.getModelSettings(),
  putModelSettings: (value) => db.putModelSettings(value),
}))
vi.mock('../../src/stores/chat', () => ({ useChatStore: () => store }))
vi.mock('../../src/services/notification', () => ({
  showSuccessToast: () => {},
}))

it('saves model-specific choices, restores them, filters routing, and resets defaults', async () => {
  db.persisted = {
    'gemini-2.5-flash': {
      providerId: 'gemini',
      parameters: { serviceTier: 'flex', writingFunctionCall: true },
    },
    'google/gemini-2.5-flash': {
      providerId: 'openrouter',
      parameters: { serviceTier: 'standard', writingFunctionCall: false },
    },
  }
  const wrapper = mount(SettingsModal, {
    global: { stubs: { FontAwesomeIcon: true } },
  })
  const vm = wrapper.vm
  await flushPromises()

  expect(vm.currentSettings.parameters.serviceTier).toBe('flex')
  expect(vm.currentSettings.parameters.writingFunctionCall).toBe(true)
  expect(vm.dynamicParameters.map((param) => param.label)).toEqual([
    'Service Tier',
    'Writing Function Call',
  ])

  vm.currentSettings.parameters.writingFunctionCall = false
  vm.onModelChange({
    target: {
      value: 'google/gemini-2.5-flash',
      selectedOptions: [{ dataset: { providerId: 'openrouter' } }],
    },
  })
  await flushPromises()
  expect(vm.currentSettings.parameters.serviceTier).toBe('standard')

  vm.currentSettings.routing.providerChoice = 'google-ai-studio'
  vm.currentSettings.parameters.serviceTier = 'flex'
  vm.onParameterChange('serviceTier')
  expect(vm.currentSettings.routing.providerChoice).toBe('')
  expect(vm.providerRoutingOptions.map((option) => option.id)).toEqual([
    'google-ai-studio/flex',
  ])

  await vm.save()
  expect(store.applied['gemini-2.5-flash'].parameters.writingFunctionCall).toBe(
    false
  )
  expect(db.persisted['google/gemini-2.5-flash'].parameters.serviceTier).toBe(
    'flex'
  )

  vm.reset()
  await vm.save()
  expect(db.persisted['google/gemini-2.5-flash'].parameters).toBeUndefined()
  expect(db.persisted['gemini-2.5-flash'].parameters.serviceTier).toBe('flex')

  wrapper.unmount()
})
