import OpenAI from 'openai'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  buildModelCapabilities,
  getEffectiveCapabilities,
  loadCapabilities,
} from './capabilities.js'
import { buildProviderConfig } from './configBuilder.js'
import { eventFromParts } from './events.js'
import { mergeText } from './request.js'
import {
  normalizeSystemInstructionMode,
  resolveSystemInstruction,
} from '../systemInstruction.js'

const runtimeFilename = fileURLToPath(import.meta.url)
const runtimeDirname = path.dirname(runtimeFilename)

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'
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
      u.total_tokens ?? (input != null && output != null ? input + output : null),
  }
}

// Concatenates textual reasoning_details blocks. Fallback for models that emit
// structured reasoning instead of the simple `reasoning` string.
function extractReasoningDetails(details) {
  if (!Array.isArray(details)) return ''
  return details
    .filter((d) => d && typeof d.type === 'string' && d.type.startsWith('reasoning') && d.text)
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
    p.max = cap
    if (typeof p.default === 'number' && p.default > cap) p.default = cap
    if (typeof p.min === 'number' && p.min > cap) p.min = cap
    params.maxOutputTokens = p
  }

  base.parameters = params

  const inputs = Array.isArray(meta.architecture?.input_modalities)
    ? meta.architecture.input_modalities
    : []
  const mimes = []
  if (inputs.includes('image')) mimes.push(...IMAGE_MIMES)
  if (inputs.includes('file')) mimes.push('application/pdf', 'text/plain')
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

export class OpenRouterProvider {
  constructor(apiKey, systemInstruction, options = {}) {
    const {
      capabilitiesPath,
      systemInstructionMode,
      appUrl,
      appTitle,
      models,
    } = options
    this.client = new OpenAI({
      apiKey,
      baseURL: OPENROUTER_BASE_URL,
      defaultHeaders: {
        ...(appUrl ? { 'HTTP-Referer': appUrl } : {}),
        ...(appTitle ? { 'X-OpenRouter-Title': appTitle } : {}),
      },
    })
    this.defaultSystemInstruction = systemInstruction
    this.systemInstructionMode = normalizeSystemInstructionMode(systemInstructionMode)
    this.capabilities = loadCapabilities('openrouter', capabilitiesPath, runtimeDirname)
    this.label = this.capabilities?.label ?? 'OpenRouter'
    this.allowlist = String(models || '')
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean)
    this.metadataTtlMs = MODELS_CACHE_TTL_MS
    this._modelsCache = null
  }

  setDefaultSystemInstruction(systemInstruction, mode = this.systemInstructionMode) {
    this.defaultSystemInstruction = systemInstruction
    this.systemInstructionMode = normalizeSystemInstructionMode(mode)
  }

  _buildConfig(modelName, request) {
    const requestParameters = request?.parameters || {}
    const { parameters, features } = getEffectiveCapabilities(this.capabilities, modelName)
    const config = buildProviderConfig(parameters, requestParameters, {
      openrouterReasoning: openrouterReasoningTransform,
    })

    const systemInstruction = resolveSystemInstruction({
      defaultSystemInstruction: this.defaultSystemInstruction,
      userSystemInstruction: request?.systemInstruction,
      mode: this.systemInstructionMode,
    })
    const system =
      features?.systemInstruction !== false && systemInstruction ? systemInstruction : ''
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
      let text = ''
      try {
        text = Buffer.from(part.data, 'base64').toString('utf-8')
      } catch {
        text = ''
      }
      return { type: 'text', text }
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
    return {
      model: request.model,
      messages,
      ...config,
    }
  }

  async *generateStream(request) {
    const stream = await this.client.chat.completions.create({
      ...this._buildRequest(request),
      stream: true,
      stream_options: { include_usage: true },
    })

    const emit = (extra) =>
      eventFromParts({
        chatId: request.chatId,
        requestId: request.requestId,
        provider: 'openrouter',
        ...extra,
      })

    for await (const data of stream) {
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
        if (delta.content) {
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
          yield emit({ finishReason })
        }
      }

      if (data.usage) {
        yield emit({ usage: normalizeOpenRouterUsage(data.usage) })
      }
    }
  }

  async generate(request) {
    const data = await this.client.chat.completions.create(this._buildRequest(request))
    const choice = data.choices?.[0] || {}
    const message = choice.message || {}
    const parts = []
    const reasoning =
      message.reasoning ?? extractReasoningDetails(message.reasoning_details)
    if (reasoning) parts.push({ text: reasoning, thought: true })
    if (typeof message.content === 'string' && message.content) {
      parts.push({ text: message.content })
    }
    return eventFromParts({
      chatId: request.chatId,
      requestId: request.requestId,
      provider: 'openrouter',
      parts,
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
    const base = buildModelCapabilities(this.capabilities, modelName)
    const meta = await this._getModelMetadata(modelName)
    return applyOpenRouterModelMetadata(base, meta)
  }
}
