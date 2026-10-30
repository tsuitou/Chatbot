// Provider setup and request handling shared by the Node server and the
// browser-only (PWA) build. Nothing here may touch Node APIs: configuration is
// read by the caller (files and env on the server, IndexedDB in the browser)
// and passed in as plain values.
import { GeminiProvider } from './providers/gemini.js'
import { ClaudeProvider } from './providers/claude.js'
import { OpenRouterProvider } from './providers/openrouter.js'
import {
  OpenAICompatProvider,
  normalizeOpenAICompatEndpoints,
} from './providers/openaiCompat.js'
import { createProviderRegistry } from './providers/registry.js'
import { createSpecialRegistry } from './specialModels.js'
import { normalizeSystemInstructionMode } from './systemInstruction.js'

export const normalizeModelName = (name) => (name || '').replace(/^models\//, '')

export const parseFilterKeywords = (raw) =>
  (raw || '')
    .split(',')
    .map((keyword) => keyword.trim().toLowerCase())
    .filter(Boolean)

export function runtimeError(status, message, extra = {}) {
  const error = new Error(message)
  Object.assign(error, { status }, extra)
  return error
}

function isMimeAllowedByPolicy(mimeType, allowedMimes) {
  if (!allowedMimes) return true
  const list = Array.isArray(allowedMimes) ? allowedMimes : []
  if (list.includes(mimeType)) return true
  return list.some(
    (pattern) =>
      typeof pattern === 'string' &&
      pattern.endsWith('/*') &&
      mimeType.startsWith(pattern.slice(0, -1))
  )
}

/**
 * @param {object} options
 * @param {{ gemini?: string, claude?: string, openrouter?: string }} [options.keys]
 * @param {object} [options.settings] geminiModelFilter, claudeModelFilter,
 *   defaultModel, systemInstructionMode, openrouterModels (raw strings, as in
 *   the server's .env).
 * @param {Record<string, object>} [options.capabilities] Parsed capability
 *   JSON keyed by provider: gemini, claude, openrouter, openai-compat.
 * @param {unknown} [options.openaiCompatConfig] Parsed endpoint config.
 * @param {string} [options.defaultSystemInstruction]
 * @param {object} [options.clientOptions] Extra options for the Anthropic and
 *   OpenAI SDK clients (the browser build opts into direct browser access).
 */
export function createRuntime({
  keys = {},
  settings = {},
  capabilities = {},
  openaiCompatConfig = null,
  defaultSystemInstruction,
  clientOptions = {},
} = {}) {
  const systemInstructionMode = normalizeSystemInstructionMode(
    settings.systemInstructionMode
  )
  const common = { systemInstructionMode, clientOptions }

  const geminiProvider = keys.gemini
    ? new GeminiProvider(keys.gemini, defaultSystemInstruction, {
        ...common,
        capabilities: capabilities.gemini,
      })
    : null
  const claudeProvider = keys.claude
    ? new ClaudeProvider(keys.claude, defaultSystemInstruction, {
        ...common,
        capabilities: capabilities.claude,
      })
    : null
  const openrouterProvider = keys.openrouter
    ? new OpenRouterProvider(keys.openrouter, defaultSystemInstruction, {
        ...common,
        capabilities: capabilities.openrouter,
        models: settings.openrouterModels,
      })
    : null
  const openaiCompatEntries = normalizeOpenAICompatEndpoints(
    openaiCompatConfig
  ).map((endpoint, index) => {
    const id =
      endpoint.id ||
      (index === 0 ? 'openai-compat' : `openai-compat-${index + 1}`)
    return {
      id,
      provider: new OpenAICompatProvider(endpoint, defaultSystemInstruction, {
        ...common,
        capabilities: capabilities['openai-compat'],
        providerId: id,
      }),
      modelPrefixes: [],
    }
  })

  const allProviders = [
    geminiProvider,
    claudeProvider,
    openrouterProvider,
    ...openaiCompatEntries.map((entry) => entry.provider),
  ].filter(Boolean)

  const providerRegistry = createProviderRegistry([
    { id: 'gemini', provider: geminiProvider },
    { id: 'claude', provider: claudeProvider, modelPrefixes: ['claude-'] },
    { id: 'openrouter', provider: openrouterProvider, modelPrefixes: [] },
    ...openaiCompatEntries,
  ])
  const specialRegistry = createSpecialRegistry({ providerKeys: keys })

  // Per-provider model list filters. Providers with curated lists (openrouter
  // allowlist, openai-compat config) are never filtered.
  const providerModelFilters = {
    gemini: parseFilterKeywords(settings.geminiModelFilter),
    claude: parseFilterKeywords(settings.claudeModelFilter),
  }
  const filterModelNames = (providerId, names = []) => {
    const list = Array.isArray(names) ? names : []
    const keywords = providerModelFilters[providerId] || []
    if (!keywords.length) return list
    return list.filter((name) => {
      const normalized = String(name || '').toLowerCase()
      return keywords.some((keyword) => normalized.includes(keyword))
    })
  }

  const resolveProviderId = (modelName, hint) =>
    providerRegistry.resolveProviderId(modelName, hint) || 'gemini'

  return {
    openaiCompatIds: openaiCompatEntries.map((entry) => entry.id),

    hasProvider() {
      return allProviders.length > 0
    },

    setDefaultSystemInstruction(systemInstruction, mode) {
      const normalized = normalizeSystemInstructionMode(mode)
      for (const provider of allProviders) {
        provider.setDefaultSystemInstruction(systemInstruction, normalized)
      }
    },

    async listModelGroups() {
      const groups = [
        {
          provider: 'virtual',
          label: specialRegistry.label,
          models: specialRegistry.list(),
        },
      ]
      for (const group of providerRegistry.groups()) {
        groups.push({
          provider: group.provider,
          label: group.label,
          models: filterModelNames(group.provider, await group.models),
        })
      }
      return groups.filter((group) => group.models.length > 0)
    },

    defaultModel() {
      return normalizeModelName(settings.defaultModel)
    },

    async getModelCapabilities(modelName, providerHint) {
      const normalized = normalizeModelName(modelName)
      if (specialRegistry.isSpecial(normalized)) {
        return specialRegistry.capabilities(normalized)
      }
      const providerId = resolveProviderId(modelName, providerHint)
      const capabilities = await providerRegistry
        .get(providerId)
        ?.getModelCapabilities(modelName)
      if (!capabilities) {
        throw runtimeError(404, 'Provider not available for model.')
      }
      return capabilities
    },

    // `file` is whatever the provider SDK accepts: a temp file path on the
    // server, a Blob in the browser.
    async uploadFile(file, { mimeType, displayName, model, provider } = {}) {
      const modelName = normalizeModelName(model)
      if (!modelName) {
        throw runtimeError(400, 'Model is required for file upload.')
      }
      const providerId = resolveProviderId(modelName, provider)
      const providerInstance = providerRegistry.get(providerId)
      const context = { provider: providerId, model: modelName }
      if (!providerInstance) {
        throw runtimeError(404, 'Provider not available for file upload.', context)
      }
      if (typeof providerInstance.uploadFile !== 'function') {
        throw runtimeError(
          400,
          'File upload is not supported for this model.',
          context
        )
      }
      const capabilities =
        typeof providerInstance.getModelCapabilities === 'function'
          ? await providerInstance.getModelCapabilities(modelName)
          : null
      const attachmentPolicy = capabilities?.attachments || {}
      if (
        attachmentPolicy.enabled !== true ||
        attachmentPolicy.allowRemoteUpload !== true ||
        !isMimeAllowedByPolicy(mimeType, attachmentPolicy.allowedMimes)
      ) {
        throw runtimeError(
          400,
          'File upload is not supported for this model or file type.',
          context
        )
      }
      return providerInstance.uploadFile(file, mimeType, displayName)
    },

    /**
     * Validates a start_generation payload and returns how to run it.
     * `abortable` tells whether passing a signal to run() actually stops the
     * provider request; run() yields the stream chunks (a single chunk for
     * non-streaming requests).
     */
    prepareGeneration(data) {
      const {
        provider,
        messages,
        model: modelName,
        parameters,
        routing,
        tools,
        systemInstruction,
        streaming,
        chatId,
        requestId,
      } = data ?? {}
      if (!modelName) throw new Error('model is required')

      const normalizedModel = normalizeModelName(modelName)
      if (specialRegistry.isSpecial(normalizedModel)) {
        return {
          special: true,
          abortable: false,
          run: () => specialRegistry.generate(normalizedModel, data),
        }
      }

      const providerId = resolveProviderId(normalizedModel, provider)
      const providerInstance = providerRegistry.get(providerId)
      if (!providerInstance) {
        throw new Error(`${providerId || 'Requested'} provider is not configured`)
      }
      if (!Array.isArray(messages)) throw new Error('messages must be an array')

      const abortable = Boolean(
        providerInstance.supportsAbort ||
          (streaming && providerInstance.supportsStreamAbort)
      )
      const buildRequest = (signal) => ({
        provider: providerId,
        chatId,
        requestId,
        model: modelName,
        messages,
        parameters: parameters || {},
        routing: routing || {},
        tools: tools || {},
        systemInstruction: systemInstruction || '',
        ...(signal ? { signal } : {}),
      })
      return {
        special: false,
        providerId,
        abortable,
        async *run(signal) {
          const request = buildRequest(abortable ? signal : null)
          if (streaming) {
            yield* providerInstance.generateStream(request)
          } else {
            yield await providerInstance.generate(request)
          }
        },
      }
    },
  }
}
