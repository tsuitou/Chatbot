// @vitest-environment happy-dom
import { it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import ConfigurationPanel from '../../src/components/ConfigurationPanel.vue'
import { defaultFileText, hashText } from '../../src/services/local/config'

const { state } = vi.hoisted(() => ({ state: { stored: null, saved: [] } }))
vi.mock('../../src/services/local/config', async (importOriginal) => ({
  ...(await importOriginal()),
  loadConfig: async () => structuredClone(state.stored),
  saveConfig: async (config) => state.saved.push(config),
}))
vi.mock('../../src/stores/session', () => ({
  useSessionStore: () => ({ isGenerating: false }),
}))
vi.mock('../../src/services/notification', () => ({ showErrorToast: vi.fn() }))

const mountPanel = async () => {
  const wrapper = mount(ConfigurationPanel)
  await flushPromises()
  return wrapper
}
const textarea = (wrapper, name) =>
  wrapper.find(`textarea[aria-label="${name}"]`)
const save = async (wrapper) => {
  await wrapper.find('form').trigger('submit')
  await flushPromises()
}

beforeEach(() => {
  state.stored = { keys: {}, settings: {}, files: {} }
  state.saved = []
  vi.spyOn(window.location, 'reload').mockImplementation(() => {})
})

it('saves only what differs from the defaults, then reloads', async () => {
  const wrapper = await mountPanel()
  expect(textarea(wrapper, 'system_instruction.txt').element.value).toBe(
    defaultFileText('systemInstruction')
  )
  await wrapper.find('#api-key-gemini').setValue('  key-1 ')
  await wrapper.find('#setting-openrouterModels').setValue('a/b')
  await textarea(wrapper, 'openai-endpoints.json').setValue(
    '[{"baseUrl":"https://x/v1"}]'
  )
  await save(wrapper)

  expect(state.saved).toEqual([
    {
      keys: { gemini: 'key-1' },
      settings: { openrouterModels: 'a/b' },
      files: {
        openaiEndpoints: {
          text: '[{"baseUrl":"https://x/v1"}]',
          baseHash: hashText(defaultFileText('openaiEndpoints')),
        },
      },
    },
  ])
  expect(window.location.reload).toHaveBeenCalled()
})

it('blocks saving invalid endpoint JSON', async () => {
  const wrapper = await mountPanel()
  await textarea(wrapper, 'openai-endpoints.json').setValue('{')
  expect(wrapper.find('.error').text()).toMatch(/Invalid JSON/)
  await save(wrapper)
  expect(state.saved).toEqual([])
})

it('flags an outdated custom file and returns to the default only on reset', async () => {
  state.stored.files.systemInstruction = { text: 'mine', baseHash: 'old' }
  const wrapper = await mountPanel()
  expect(wrapper.find('.notice').exists()).toBe(true)
  expect(wrapper.findAll('.badge').map((b) => b.text())).toEqual([
    'Custom',
    'Default',
  ])

  // Saving untouched keeps the custom text and the default it was based on.
  await save(wrapper)
  expect(state.saved[0].files.systemInstruction).toEqual({
    text: 'mine',
    baseHash: 'old',
  })

  const reset = wrapper
    .findAll('button')
    .filter((b) => b.text() === 'Reset to Default')[0]
  await reset.trigger('click')
  expect(wrapper.findAll('.badge')[0].text()).toBe('Default')
  await save(wrapper)
  expect(state.saved[1].files).toEqual({})
})
