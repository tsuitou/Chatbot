import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { ref, computed, watch, nextTick, effectScope } from 'vue'
import {
  createEmptySettings,
  normalizeSettingsEntry,
  cloneSettings,
  serializeSettings,
} from '../src/services/modelConfig.js'
import { normalizeDynamicParameters } from '../src/services/modelCapabilities.js'
import { escapeHtml, safeAnchorHtml } from '../src/services/htmlSafety.js'
import { buildGeminiContents } from '../../backend/providers/geminiMapper.js'

const stripImports = (source) =>
  source.replace(/^import[\s\S]*?from ['"][^'"]+['"]\n/gm, '')
const adapterSource = stripImports(
  await readFile(
    new URL('../src/services/apiAdapter.js', import.meta.url),
    'utf8'
  )
)
const { createApiRequest } = runInNewContext(
  `${adapterSource.replaceAll('export ', '')}\n({ createApiRequest })`,
  { uuidv4: () => 'id' }
)
const metadataSource = stripImports(
  await readFile(
    new URL('../src/services/messageMetadata.js', import.meta.url),
    'utf8'
  )
)
const { buildMetadataLines, buildMetadataHtmlForExport } = runInNewContext(
  `${metadataSource.replaceAll('export ', '')}\n({ buildMetadataLines, buildMetadataHtmlForExport })`,
  { escapeHtml, safeAnchorHtml }
)
const plain = (value) => JSON.parse(JSON.stringify(value))

const flowSource = stripImports(
  await readFile(
    new URL('../src/services/chatFlow.js', import.meta.url),
    'utf8'
  )
)
const { prepareRequestMessages } = runInNewContext(
  `${flowSource.replace(/export \{[\s\S]*?\}\s*$/, '')}\n({ prepareRequestMessages })`
)

test('failed writing stays out of model history while completed writing is retained', () => {
  const historyMessages = [
    { id: 'user', sender: 'user' },
    {
      id: 'bad',
      sender: 'model',
      status: 'completed',
      metadata: { writingFunctionCall: 'invalid' },
    },
    {
      id: 'good',
      sender: 'model',
      status: 'completed',
      metadata: { writingFunctionCall: 'used' },
    },
  ]
  const messages = prepareRequestMessages({
    historyMessages,
    autoMessages: { pre: [], post: [] },
    anchorSequence: 10,
  })
  assert.deepEqual(plain(messages.map((message) => message.id)), [
    'user',
    'good',
  ])
})

test('model settings round-trip preserves independent Flex and writing choices', () => {
  for (const serviceTier of ['standard', 'flex']) {
    for (const writingFunctionCall of [false, true]) {
      const settings = {
        providerId: 'gemini',
        parameters: { serviceTier, writingFunctionCall },
      }
      const restored = normalizeSettingsEntry(
        JSON.parse(JSON.stringify(serializeSettings(settings)))
      )
      assert.deepEqual(restored.parameters, settings.parameters)
      const clone = cloneSettings(restored)
      clone.parameters.writingFunctionCall = !writingFunctionCall
      assert.equal(restored.parameters.writingFunctionCall, writingFunctionCall)
    }
  }
})

test('writing result is resent as ordinary text without its call signature, including after reload', async () => {
  const message = JSON.parse(
    JSON.stringify({
      sender: 'model',
      sequence: 1,
      content: { text: '作品\n"Quoted" \\ end' },
      configSnapshot: { parameters: { writingFunctionCall: true } },
      metadata: {
        writingFunctionCall: 'used',
        thoughtSignatures: [{ signature: 'call-signature' }],
      },
    })
  )
  const payload = await createApiRequest({
    model: 'gemini-2.5-flash',
    messages: [message],
    requestConfig: {
      parameters: { serviceTier: 'flex', writingFunctionCall: true },
    },
  })
  assert.deepEqual(plain(payload.parameters), {
    serviceTier: 'flex',
    writingFunctionCall: true,
  })
  assert.deepEqual(plain(payload.messages[0].parts), [
    { type: 'text', text: message.content.text },
  ])
  const contents = buildGeminiContents(payload.messages)
  assert.deepEqual(plain(contents[0]), {
    role: 'model',
    parts: [{ text: message.content.text }],
  })
})

test('normal text history still resends its signature', async () => {
  const payload = await createApiRequest({
    model: 'gemini-2.5-flash',
    messages: [
      {
        sender: 'model',
        content: { text: 'normal' },
        metadata: { thoughtSignatures: [{ signature: 'text-sig' }] },
      },
    ],
  })
  assert.equal(
    buildGeminiContents(payload.messages)[0].parts[0].thoughtSignature,
    'text-sig'
  )
})

test('metadata shows only actual tier and writing outcome; settings alone do not claim success', () => {
  const message = {
    configSnapshot: {
      parameters: { serviceTier: 'flex', writingFunctionCall: true },
    },
  }
  assert.deepEqual(plain(buildMetadataLines(message)), ['Tier: Unknown'])
  message.metadata = { serviceTier: 'flex', writingFunctionCall: 'used' }
  assert.deepEqual(plain(buildMetadataLines(message)), [
    'Tier: Flex, Writing FC: Used',
  ])
  assert.equal(
    buildMetadataHtmlForExport(message),
    '<div class="metadata-item">Tier: Flex, Writing FC: Used</div>'
  )
  message.metadata = { serviceTier: 'standard', writingFunctionCall: 'invalid' }
  assert.deepEqual(plain(buildMetadataLines(message)), [
    'Tier: Standard, Writing FC: Invalid',
  ])
  assert.deepEqual(
    plain(buildMetadataLines({ metadata: { serviceTier: 'standard' } })),
    []
  )
})

test('metadata makes failed or interrupted function calls visible', () => {
  for (const [status, label] of [
    ['not_used', 'Not used'],
    ['invalid', 'Invalid'],
    ['incomplete', 'Incomplete'],
  ]) {
    assert.deepEqual(
      plain(buildMetadataLines({ metadata: { writingFunctionCall: status } })),
      [`Writing FC: ${label}`]
    )
  }
  assert.deepEqual(
    plain(
      buildMetadataLines({
        status: 'cancelled',
        metadata: { writingFunctionCall: 'pending' },
      })
    ),
    ['Writing FC: Incomplete']
  )
})

const modal = await readFile(
  new URL('../src/components/SettingsModal.vue', import.meta.url),
  'utf8'
)
const modalScript = stripImports(
  modal.match(/<script setup>([\s\S]*?)<\/script>/)[1]
)
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

test('Settings modal saves model-specific choices, restores them, filters routing, and resets defaults', async () => {
  let persisted = {
    'gemini-2.5-flash': {
      providerId: 'gemini',
      parameters: { serviceTier: 'flex', writingFunctionCall: true },
    },
    'google/gemini-2.5-flash': {
      providerId: 'openrouter',
      parameters: { serviceTier: 'standard', writingFunctionCall: false },
    },
  }
  let applied
  let mounted
  const scope = effectScope()
  const store = {
    availableModels: [
      { provider: 'gemini', models: ['gemini-2.5-flash'] },
      { provider: 'openrouter', models: ['google/gemini-2.5-flash'] },
    ],
    composerState: { model: 'gemini-2.5-flash', providerId: 'gemini' },
    ensureModelCapabilities: async () => capabilities,
    setModelSettings: (value) => {
      applied = value
    },
  }
  const api = scope.run(() =>
    runInNewContext(
      `${modalScript}\n({ currentSettings, dynamicParameters, providerRoutingOptions, onModelChange, onParameterChange, save, reset })`,
      {
        ref,
        computed,
        watch,
        defineEmits: () => () => {},
        useChatStore: () => store,
        onMounted: (callback) => {
          mounted = callback
        },
        onBeforeUnmount: () => {},
        window: { addEventListener() {}, removeEventListener() {} },
        db: {
          getModelSettings: async () => persisted,
          putModelSettings: async (value) => {
            persisted = plain(value)
          },
        },
        showSuccessToast() {},
        console,
        createEmptySettings,
        normalizeSettingsEntry,
        cloneSettings,
        serializeSettings,
        normalizeDynamicParameters,
      }
    )
  )
  try {
    await mounted()
    await nextTick()
    assert.equal(api.currentSettings.value.parameters.serviceTier, 'flex')
    assert.equal(api.currentSettings.value.parameters.writingFunctionCall, true)
    assert.deepEqual(
      api.dynamicParameters.value.map((param) => param.label),
      ['Service Tier', 'Writing Function Call']
    )
    api.currentSettings.value.parameters.writingFunctionCall = false
    api.onModelChange({
      target: {
        value: 'google/gemini-2.5-flash',
        selectedOptions: [{ dataset: { providerId: 'openrouter' } }],
      },
    })
    await nextTick()
    assert.equal(api.currentSettings.value.parameters.serviceTier, 'standard')
    api.currentSettings.value.routing.providerChoice = 'google-ai-studio'
    api.currentSettings.value.parameters.serviceTier = 'flex'
    api.onParameterChange('serviceTier')
    assert.equal(api.currentSettings.value.routing.providerChoice, '')
    assert.deepEqual(
      plain(api.providerRoutingOptions.value.map((option) => option.id)),
      ['google-ai-studio/flex']
    )
    await api.save()
    assert.equal(
      applied['gemini-2.5-flash'].parameters.writingFunctionCall,
      false
    )
    assert.equal(
      persisted['google/gemini-2.5-flash'].parameters.serviceTier,
      'flex'
    )
    api.reset()
    await api.save()
    assert.equal(persisted['google/gemini-2.5-flash'].parameters, undefined)
    assert.equal(persisted['gemini-2.5-flash'].parameters.serviceTier, 'flex')
  } finally {
    scope.stop()
  }
})
