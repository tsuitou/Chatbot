import OpenAI from 'openai'
import {
  applyCapabilityModelOverride,
  buildModelCapabilitiesFromEffective,
  findCapabilityModelOverride,
  getDefaultCapabilities,
  getEffectiveCapabilities,
} from './capabilities.js'
import { decodeBase64Text } from './base64.js'
import { buildProviderConfig } from './configBuilder.js'
import { eventFromParts } from './events.js'
import { mergeText } from './request.js'
import {
  FLEX_TIMEOUT_MS,
  generationOptions,
  tierMetadata,
} from './generationOptions.js'
import {
  finishWriting,
  OpenRouterWritingAccumulator,
  writingFunctionDeclaration,
} from './writing.js'
import {
  normalizeSystemInstructionMode,
  resolveSystemInstruction,
} from '../systemInstruction.js'

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'
const OPENROUTER_ORIGIN = 'https://openrouter.ai'
const MODELS_CACHE_TTL_MS = 30 * 60 * 1000 // 30 minutes

// Maps capability parameter keys to the OpenRouter `supported_parameters`
// entries that gate them. Used to hide parameters a model cannot accept.
const PARAM_SUPPORT = {
  temperature: ['temperature'],
  topP: ['top_p'],
  topK: ['top_k'],
  maxOutputTokens: ['max_tokens', 'max_completion_tokens'],
  thinkingBudget: ['reasoning', 'include_reasoning'],
  reasoningEffort: ['reasoning', 'include_reasoning'],
}

const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

// Merges `thinkingBudget` (numeric token budget) and `reasoningEffort` (enum)
// into OpenRouter's unified `reasoning` object.
function openrouterReasoningTransform({ config, value, key }) {
  if (key === 'reasoningEffort') {
    if (value && value !== 'none') config.reasoning = { effort: value }
    return
  }
  // thinkingBudget
  const budget = Number(value)
  if (budget === -1) {
    config.reasoning = { enabled: true } // Auto
    return
  }
  if (!Number.isFinite(budget) || budget <= 0) return // Disabled -> omit reasoning
  config.reasoning = { max_tokens: budget }
}

function normalizeOpenRouterUsage(u) {
  if (!u) return null
  const input = u.prompt_tokens ?? null
  const output = u.completion_tokens ?? null
  const reasoning = u.completion_tokens_details?.reasoning_tokens ?? null
  return {
    inputTokens: input,
    outputTokens: output,
    reasoningTokens: reasoning,
    totalTokens:
      u.total_tokens ??
      (input != null && output != null ? input + output : null),
  }
}

// Concatenates textual reasoning_details blocks. Fallback for models that emit
// structured reasoning instead of the simple `reasoning` string.
function extractReasoningDetails(details) {
  if (!Array.isArray(details)) return ''
  return details
    .filter(
      (d) =>
        d &&
        typeof d.type === 'string' &&
        d.type.startsWith('reasoning') &&
        d.text
    )
    .map((d) => d.text)
    .join('')
}

// Overlays OpenRouter `/models` metadata onto static capabilities: hides
// unsupported parameters, caps max output tokens, and enables attachments per
// the model's declared input modalities.
function applyOpenRouterModelMetadata(base, meta) {
  if (!base || !meta) return base

  const supported = Array.isArray(meta.supported_parameters)
    ? meta.supported_parameters
    : null
  const params = { ...(base.parameters || {}) }

  if (supported) {
    for (const key of Object.keys(params)) {
      const needed = PARAM_SUPPORT[key]
      if (needed && !needed.some((n) => supported.includes(n))) {
        delete params[key]
      }
    }
  }

  const cap = meta.top_provider?.max_completion_tokens
  if (Number.isFinite(cap) && params.maxOutputTokens) {
    const p = { ...params.maxOutputTokens }
    if (p.ui) {
      p.ui = {
        ...p.ui,
        range: {
          ...(p.ui.range || {}),
          max: cap,
        },
      }
      if (typeof p.ui.range.min === 'number' && p.ui.range.min > cap) {
        p.ui.range.min = cap
      }
    } else {
      p.max = cap
      if (typeof p.min === 'number' && p.min > cap) p.min = cap
    }
    if (typeof p.default === 'number' && p.default > cap) p.default = cap
    params.maxOutputTokens = p
  }

  base.parameters = params

  const inputs = Array.isArray(meta.architecture?.input_modalities)
    ? meta.architecture.input_modalities
    : []
  const mimes = []
  // Text attachments are inlined as plain text, so any text model takes them.
  if (inputs.includes('text')) mimes.push('text/plain')
  if (inputs.includes('image')) mimes.push(...IMAGE_MIMES)
  if (inputs.includes('file')) mimes.push('application/pdf')
  if (mimes.length) {
    base.attachments = {
      ...(base.attachments || {}),
      enabled: true,
      allowRemoteUpload: false,
      allowedMimes: mimes,
    }
  }

  return base
}

function normalizeProviderSlug(value) {
  if (value === null || value === undefined) return ''
  if (!['string', 'number'].includes(typeof value)) return ''
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
}

function normalizeProviderName(value) {
  if (value === null || value === undefined) return ''
  if (!['string', 'number'].includes(typeof value)) return ''
  return String(value || '').trim()
}

function normalizePriceValue(value) {
  if (value === undefined || value === null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function normalizePricing(pricing) {
  if (!pricing || typeof pricing !== 'object') return null
  const result = {}
  for (const [key, value] of Object.entries(pricing)) {
    const normalized = normalizePriceValue(value)
    if (normalized !== null) result[key] = normalized
  }
  return Object.keys(result).length ? result : null
}

function normalizeOptionalNumber(value) {
  if (value === undefined || value === null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function firstValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value
  }
  return null
}

function normalizeOpenRouterProviderRouting(raw) {
  const provider =
    raw?.provider && typeof raw.provider === 'object' ? raw.provider : {}
  const result = {}

  if (Array.isArray(provider.only)) {
    result.only = provider.only.map(normalizeProviderSlug).filter(Boolean)
  }
  if (Array.isArray(provider.order)) {
    result.order = provider.order.map(normalizeProviderSlug).filter(Boolean)
  }
  if (Array.isArray(provider.ignore)) {
    result.ignore = provider.ignore.map(normalizeProviderSlug).filter(Boolean)
  }
  if (Array.isArray(provider.quantizations)) {
    result.quantizations = provider.quantizations
      .map(String)
      .map((v) => v.trim())
      .filter(Boolean)
  }
  if (typeof provider.allow_fallbacks === 'boolean') {
    result.allow_fallbacks = provider.allow_fallbacks
  }
  if (typeof provider.require_parameters === 'boolean') {
    result.require_parameters = provider.require_parameters
  }
  if (typeof provider.data_collection === 'string') {
    const value = provider.data_collection.trim()
    if (value === 'allow' || value === 'deny') result.data_collection = value
  }
  if (typeof provider.zdr === 'boolean') result.zdr = provider.zdr
  if (typeof provider.enforce_distillable_text === 'boolean') {
    result.enforce_distillable_text = provider.enforce_distillable_text
  }
  if (typeof provider.sort === 'string' && provider.sort.trim()) {
    result.sort = provider.sort.trim()
  } else if (provider.sort && typeof provider.sort === 'object') {
    result.sort = provider.sort
  }
  if (provider.max_price && typeof provider.max_price === 'object') {
    result.max_price = provider.max_price
  }

  for (const key of Object.keys(result)) {
    if (Array.isArray(result[key]) && result[key].length === 0)
      delete result[key]
  }
  return Object.keys(result).length ? result : null
}

function endpointProviderSlug(endpoint) {
  return (
    normalizeProviderSlug(endpoint?.tag) ||
    normalizeProviderSlug(endpoint?.provider_slug) ||
    normalizeProviderSlug(endpoint?.provider_id) ||
    normalizeProviderSlug(endpoint?.provider?.slug) ||
    normalizeProviderSlug(endpoint?.provider?.id) ||
    normalizeProviderSlug(endpoint?.provider_name) ||
    normalizeProviderSlug(endpoint?.provider) ||
    normalizeProviderSlug(endpoint?.name)
  )
}

function endpointProviderLabel(endpoint, slug) {
  return (
    normalizeProviderName(endpoint?.provider?.name) ||
    normalizeProviderName(endpoint?.provider_label) ||
    normalizeProviderName(endpoint?.provider_name) ||
    normalizeProviderName(endpoint?.provider) ||
    normalizeProviderName(endpoint?.name) ||
    slug
  )
}

function buildRoutingOptionFromEndpoint(endpoint) {
  const id = endpointProviderSlug(endpoint)
  if (!id) return null
  const serviceTier = String(
    endpoint.service_tier ||
      (id.endsWith('/flex')
        ? 'flex'
        : id.endsWith('/priority')
          ? 'priority'
          : 'standard')
  )
  const label = endpointProviderLabel(endpoint, id)
  return {
    id,
    label: `${label} (${id})`,
    providerAlias: normalizeProviderSlug(label),
    serviceTier,
    pricing: normalizePricing(endpoint.pricing),
    contextLength:
      endpoint.context_length ??
      endpoint.contextLength ??
      endpoint.top_provider?.context_length ??
      null,
    maxCompletionTokens:
      endpoint.max_completion_tokens ??
      endpoint.maxCompletionTokens ??
      endpoint.top_provider?.max_completion_tokens ??
      null,
    throughput: normalizeOptionalNumber(
      firstValue(
        endpoint.throughput,
        endpoint.performance?.throughput,
        endpoint.performance?.tokens_per_second,
        endpoint.metrics?.throughput,
        endpoint.metrics?.tokens_per_second
      )
    ),
    precision: firstValue(
      endpoint.precision,
      endpoint.quantization,
      endpoint.variant?.precision,
      endpoint.variant?.quantization,
      endpoint.top_provider?.precision,
      endpoint.top_provider?.quantization
    ),
    quantization: firstValue(
      endpoint.quantization,
      endpoint.variant?.quantization
    ),
    status: endpoint.status ?? null,
  }
}

function buildRoutingOptionFromModel(meta) {
  if (!meta) return null
  const slug = normalizeProviderSlug(meta.top_provider?.provider_name)
  if (!slug) return null
  return {
    id: slug,
    label: endpointProviderLabel(meta.top_provider, slug),
    pricing: normalizePricing(meta.pricing),
    contextLength:
      meta.top_provider?.context_length ?? meta.context_length ?? null,
    maxCompletionTokens: meta.top_provider?.max_completion_tokens ?? null,
    throughput: normalizeOptionalNumber(
      firstValue(
        meta.top_provider?.throughput,
        meta.top_provider?.tokens_per_second,
        meta.performance?.throughput,
        meta.performance?.tokens_per_second
      )
    ),
    precision: firstValue(
      meta.top_provider?.precision,
      meta.top_provider?.quantization
    ),
    quantization: meta.top_provider?.quantization ?? null,
    status: null,
  }
}

function applyRoutingCapabilities(base, options) {
  const normalized = Array.isArray(options) ? options.filter(Boolean) : []
  if (!normalized.length) return base
  base.routing = {
    ...(base.routing || {}),
    providerSelection: {
      enabled: true,
      options: normalized,
    },
  }
  return base
}

export class OpenRouterProvider {
  constructor(apiKey, systemInstruction, options = {}) {
    const {
      capabilities,
      systemInstructionMode,
      appUrl,
      appTitle,
      models,
      clientOptions,
    } = options
    this.client = new OpenAI({
      apiKey,
      baseURL: OPENROUTER_BASE_URL,
      defaultHeaders: {
        ...(appUrl ? { 'HTTP-Referer': appUrl } : {}),
        ...(appTitle ? { 'X-OpenRouter-Title': appTitle } : {}),
      },
      ...clientOptions,
    })
    this.defaultSystemInstruction = systemInstruction
    this.systemInstructionMode = normalizeSystemInstructionMode(
      systemInstructionMode
    )
    this.capabilities = capabilities || null
    this.label = this.capabilities?.label ?? 'OpenRouter'
    this.allowlist = String(models || '')
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean)
    this.metadataTtlMs = MODELS_CACHE_TTL_MS
    this._modelsCache = null
    this._providerOptionsCache = new Map()
    this.supportsStreamAbort = true
    this.supportsAbort = true
  }

  setDefaultSystemInstruction(
    systemInstruction,
    mode = this.systemInstructionMode
  ) {
    this.defaultSystemInstruction = systemInstruction
    this.systemInstructionMode = normalizeSystemInstructionMode(mode)
  }

  _buildConfig(modelName, request) {
    const requestParameters = request?.parameters || {}
    const { parameters, features } = getEffectiveCapabilities(
      this.capabilities,
      modelName
    )
    const config = buildProviderConfig(parameters, requestParameters, {
      openrouterReasoning: openrouterReasoningTransform,
    })
    const { serviceTier, writing } = generationOptions(
      requestParameters,
      parameters
    )
    if (serviceTier)
      config.service_tier = serviceTier === 'standard' ? 'default' : 'flex'
    if (writing) {
      config.tools = [
        { type: 'function', function: writingFunctionDeclaration() },
      ]
      config.tool_choice = {
        type: 'function',
        function: { name: 'submit_writing' },
      }
    }

    const systemInstruction = resolveSystemInstruction({
      defaultSystemInstruction: this.defaultSystemInstruction,
      userSystemInstruction: request?.systemInstruction,
      mode: this.systemInstructionMode,
    })
    const system =
      features?.systemInstruction !== false && systemInstruction
        ? systemInstruction
        : ''
    return { config, system }
  }

  _buildContentBlock(part) {
    if (part?.type === 'text') {
      return { type: 'text', text: part.text || '' }
    }
    if (part?.type !== 'file') return null
    // OpenRouter accepts inline base64 only; Gemini Files URIs are unsupported.
    if (!part.data) return null
    const mimeType = part.mimeType || 'application/octet-stream'
    if (mimeType.startsWith('image/')) {
      return {
        type: 'image_url',
        image_url: { url: `data:${mimeType};base64,${part.data}` },
      }
    }
    if (mimeType === 'application/pdf') {
      return {
        type: 'file',
        file: {
          filename: part.name || part.filename || 'document.pdf',
          file_data: `data:application/pdf;base64,${part.data}`,
        },
      }
    }
    if (mimeType.startsWith('text/')) {
      return { type: 'text', text: decodeBase64Text(part.data) }
    }
    // Unsupported MIME -> skip rather than crash.
    return null
  }

  _buildMessages(messages = [], system) {
    const result = []
    let mergedSystem = system

    for (const message of messages) {
      if (message.role === 'system') {
        const text = (message.parts || [])
          .filter((part) => part?.type === 'text')
          .map((part) => part.text || '')
          .join('\n')
        mergedSystem = mergeText(mergedSystem, text)
        continue
      }
      if (!['user', 'model'].includes(message.role)) continue
      const content = (message.parts || [])
        .map((part) => this._buildContentBlock(part))
        .filter(Boolean)
      result.push({
        role: message.role === 'model' ? 'assistant' : 'user',
        content: content.length ? content : [{ type: 'text', text: '' }],
      })
    }

    if (mergedSystem) {
      result.unshift({ role: 'system', content: mergedSystem })
    }
    return result
  }

  _buildRequest(request) {
    const { config, system } = this._buildConfig(request.model, request)
    const messages = this._buildMessages(request.messages, system)
    const providerRouting = normalizeOpenRouterProviderRouting(request.routing)
    return {
      model: request.model,
      messages,
      ...(providerRouting ? { provider: providerRouting } : {}),
      ...config,
    }
  }

  async _prepareRequest(request) {
    const body = this._buildRequest(request)
    if (body.tools) {
      const meta = await this._getModelMetadata(request.model)
      if (
        Array.isArray(meta?.supported_parameters) &&
        !['tools', 'tool_choice'].every((p) =>
          meta.supported_parameters.includes(p)
        )
      ) {
        throw new Error(
          'Writing Function Call is not supported for this model.'
        )
      }
      body.provider = { ...body.provider, require_parameters: true }
    }
    if (body.service_tier === 'flex') {
      const meta = await this._getModelMetadata(request.model)
      const options = await this._getModelProviderOptions(request.model, meta)
      const routing = body.provider || {}
      const matches = (option, slug) =>
        option.id === slug ||
        option.id.startsWith(`${slug}/`) ||
        option.providerAlias === slug
      const candidates = options.filter(
        (option) =>
          option.serviceTier === 'flex' &&
          option.id.endsWith('/flex') &&
          (!routing.only?.length ||
            routing.only.some((slug) => matches(option, slug))) &&
          !routing.ignore?.some((slug) => matches(option, slug))
      )
      if (!candidates.length) {
        throw new Error(
          'No Flex endpoint is available for this model and provider selection. Choose another provider or Standard.'
        )
      }
      // Explicit tier slugs prevent OpenRouter's standard-rate fallback when
      // the candidate pool contains no Flex endpoints.
      body.provider = {
        ...routing,
        only: candidates.map((option) => option.id),
      }
    }
    request.signal?.throwIfAborted()
    return body
  }

  _requestOptions(request) {
    return {
      ...(request.signal ? { signal: request.signal } : {}),
      ...(request.parameters?.serviceTier === 'flex'
        ? { timeout: FLEX_TIMEOUT_MS, maxRetries: 2 }
        : {}),
    }
  }

  async *generateStream(request) {
    const body = await this._prepareRequest(request)
    const writing = body.tools ? new OpenRouterWritingAccumulator() : null
    const metadata = writing ? { writingFunctionCall: 'pending' } : {}
    let finalReason
    try {
      const stream = await this.client.chat.completions.create(
        {
          ...body,
          stream: true,
          stream_options: { include_usage: true },
        },
        this._requestOptions(request)
      )

      const emit = (extra) =>
        eventFromParts({
          chatId: request.chatId,
          requestId: request.requestId,
          provider: 'openrouter',
          metadata: { ...metadata },
          ...extra,
        })

      for await (const data of stream) {
        Object.assign(metadata, tierMetadata(data.service_tier))
        // Mid-stream error surfaced as a top-level `error` field.
        if (data.error) {
          const err = new Error(data.error.message || 'OpenRouter stream error')
          err.status = Number(data.error.code) || 502
          throw err
        }

        const choice = data.choices?.[0]
        if (choice) {
          const delta = choice.delta || {}
          const finishReason = choice.finish_reason
          if (finishReason === 'error') {
            throw new Error('OpenRouter stream ended with error')
          }
          if (writing) writing.add(delta.tool_calls)
          if (delta.content && !writing) {
            yield emit({ parts: [{ text: delta.content }] })
          }
          // `reasoning`/`reasoning_details` are OpenRouter extensions not present
          // in the OpenAI SDK types; access them off the runtime delta.
          const reasoning =
            delta.reasoning ?? extractReasoningDetails(delta.reasoning_details)
          if (reasoning) {
            yield emit({ parts: [{ text: reasoning, thought: true }] })
          }
          if (finishReason) {
            finalReason = finishReason
            yield emit({ finishReason })
          }
        }

        if (data.usage) {
          yield emit({ usage: normalizeOpenRouterUsage(data.usage) })
        } else if (data.service_tier) {
          yield emit({})
        }
      }
      if (writing) {
        const output = writing.finish(finalReason)
        Object.assign(metadata, output.metadata)
        yield emit({ parts: output.parts })
      }
    } catch (error) {
      error.metadata = {
        ...metadata,
        ...(writing ? { writingFunctionCall: 'incomplete' } : {}),
        ...error.metadata,
      }
      throw error
    }
  }

  async generate(request) {
    const body = await this._prepareRequest(request)
    const data = await this.client.chat.completions.create(
      body,
      this._requestOptions(request)
    )
    const choice = data.choices?.[0] || {}
    const message = choice.message || {}
    const parts = []
    const metadata = tierMetadata(data.service_tier)
    const reasoning =
      message.reasoning ?? extractReasoningDetails(message.reasoning_details)
    if (reasoning) parts.push({ text: reasoning, thought: true })
    if (body.tools) {
      try {
        const output = finishWriting(
          (message.tool_calls || []).map((call) => ({
            name: call.function?.name,
            args: call.function?.arguments,
          })),
          choice.finish_reason,
          ['tool_calls', 'stop']
        )
        parts.push(...output.parts)
        Object.assign(metadata, output.metadata)
      } catch (error) {
        error.metadata = { ...metadata, ...error.metadata }
        throw error
      }
    } else if (typeof message.content === 'string' && message.content) {
      parts.push({ text: message.content })
    }
    return eventFromParts({
      chatId: request.chatId,
      requestId: request.requestId,
      provider: 'openrouter',
      parts,
      metadata,
      usage: normalizeOpenRouterUsage(data.usage),
      finishReason: choice.finish_reason || null,
    })
  }

  async _loadModelsMetadata(force = false) {
    const now = Date.now()
    if (
      !force &&
      this._modelsCache &&
      now - this._modelsCache.fetchedAt < this.metadataTtlMs
    ) {
      return this._modelsCache
    }
    const page = await this.client.models.list()
    const data = Array.isArray(page?.data) ? page.data : []
    const byId = new Map(data.map((m) => [m.id, m]))
    this._modelsCache = { data, byId, fetchedAt: now }
    return this._modelsCache
  }

  async _getModelMetadata(modelName) {
    try {
      const cache = await this._loadModelsMetadata()
      return cache.byId.get(modelName) || null
    } catch {
      return null
    }
  }

  async _getModelProviderOptions(modelName, meta) {
    const cached = this._providerOptionsCache.get(modelName)
    if (cached && Date.now() - cached.fetchedAt < this.metadataTtlMs)
      return cached.options
    const modelPath = modelName
      .split(':')[0]
      .split('/')
      .map(encodeURIComponent)
      .join('/')
    const detailsPath =
      meta?.links?.details ||
      `${OPENROUTER_BASE_URL}/models/${modelPath}/endpoints`

    try {
      const url = detailsPath.startsWith('http')
        ? detailsPath
        : `${OPENROUTER_ORIGIN}${
            detailsPath.startsWith('/') ? detailsPath : `/${detailsPath}`
          }`
      const response = await fetch(url, { signal: AbortSignal.timeout(15000) })
      if (!response.ok) {
        throw new Error(
          `OpenRouter endpoints request failed: ${response.status}`
        )
      }
      const payload = await response.json()
      const endpoints = Array.isArray(payload?.data?.endpoints)
        ? payload.data.endpoints
        : Array.isArray(payload?.data)
          ? payload.data
          : Array.isArray(payload?.endpoints)
            ? payload.endpoints
            : []
      const byId = new Map()
      for (const endpoint of endpoints) {
        const option = buildRoutingOptionFromEndpoint(endpoint)
        if (!option) continue
        const existing = byId.get(option.id)
        if (!existing || (!existing.pricing && option.pricing)) {
          byId.set(option.id, option)
        }
      }
      const options = [...byId.values()]
      if (options.length) {
        this._providerOptionsCache.set(modelName, {
          options,
          fetchedAt: Date.now(),
        })
        return options
      }
    } catch {
      // Provider details are best-effort; fall back to model-level metadata.
    }

    const fallback = buildRoutingOptionFromModel(meta)
    return fallback ? [fallback] : []
  }

  async listModels() {
    let cache = null
    try {
      cache = await this._loadModelsMetadata()
    } catch {
      // degrade: fall back to the configured allowlist below
    }
    // No allowlist means curation is required; avoid dumping hundreds of models.
    if (!this.allowlist.length) return []
    if (!cache) return [...this.allowlist]
    const filtered = this.allowlist.filter((id) => cache.byId.has(id))
    return filtered.length ? filtered : [...this.allowlist]
  }

  async getModelCapabilities(modelName) {
    const base = getDefaultCapabilities(this.capabilities)
    const meta = await this._getModelMetadata(modelName)
    const withMetadata = applyOpenRouterModelMetadata(base, meta)
    const override = findCapabilityModelOverride(this.capabilities, modelName)
    const effective = applyCapabilityModelOverride(withMetadata, override)
    if (
      Array.isArray(meta?.supported_parameters) &&
      !['tools', 'tool_choice'].every((p) =>
        meta.supported_parameters.includes(p)
      )
    ) {
      delete effective.parameters.writingFunctionCall
    }
    const display = buildModelCapabilitiesFromEffective(effective, modelName)
    const options = await this._getModelProviderOptions(modelName, meta)
    return applyRoutingCapabilities(display, options)
  }
}
