import OpenAI from 'openai'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  applyCapabilityModelOverride,
  buildModelCapabilitiesFromEffective,
  deepMerge,
  findCapabilityModelOverride,
  getDefaultCapabilities,
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

const MODELS_CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// Loads and normalizes the endpoint config file referenced by
// OPENAI_COMPAT_CONFIG. Accepts a single endpoint object or an array of them:
//   {
//     "label": "vLLM (Local)",
//     "baseUrl": "http://localhost:8000/v1",
//     "apiKey": "EMPTY",
//     "models": ["Qwen/Qwen3-32B"],
//     "headers": { "X-Custom": "value" },
//     "request": { "chat_template_kwargs": { "reasoning_effort": "no_think" } }
//   }
// `request` is deep-merged into every chat completion body, so server-specific
// extensions (vLLM chat_template_kwargs etc.) pass through untouched.
export function loadOpenAICompatEndpoints(configPath) {
  if (!configPath) return []

  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
  } catch (error) {
    console.warn(`Failed to load OpenAI-compatible config from ${configPath}:`, error.message)
    return []
  }

  const entries = Array.isArray(parsed) ? parsed : [parsed]
  const endpoints = []
  entries.forEach((entry, index) => {
    if (!isPlainObject(entry)) return
    const baseUrl = String(entry.baseUrl || entry.base_url || '').trim()
    if (!baseUrl) {
      console.warn(`OpenAI-compatible config entry ${index}: "baseUrl" is required; entry skipped.`)
      return
    }
    endpoints.push({
      id: typeof entry.id === 'string' ? entry.id.trim() : '',
      label: typeof entry.label === 'string' ? entry.label.trim() : '',
      baseUrl,
      // vLLM and friends require a non-empty key even when auth is disabled.
      apiKey: String(entry.apiKey || entry.api_key || '').trim() || 'EMPTY',
      models: Array.isArray(entry.models)
        ? entry.models.map((m) => String(m).trim()).filter(Boolean)
        : [],
      headers: isPlainObject(entry.headers) ? entry.headers : {},
      request: isPlainObject(entry.request) ? entry.request : {},
    })
  })
  return endpoints
}

function normalizeUsage(u) {
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

export class OpenAICompatProvider {
  constructor(endpoint, systemInstruction, options = {}) {
    const { capabilitiesPath, systemInstructionMode, providerId } = options
    this.providerId = providerId || 'openai-compat'
    this.client = new OpenAI({
      apiKey: endpoint.apiKey,
      baseURL: endpoint.baseUrl,
      defaultHeaders: endpoint.headers,
    })
    this.defaultSystemInstruction = systemInstruction
    this.systemInstructionMode = normalizeSystemInstructionMode(systemInstructionMode)
    this.capabilities = loadCapabilities('openai-compat', capabilitiesPath, runtimeDirname)
    this.label = endpoint.label || this.capabilities?.label || 'OpenAI Compatible'
    this.allowlist = endpoint.models
    this.requestOverrides = endpoint.request
    this.metadataTtlMs = MODELS_CACHE_TTL_MS
    this._modelsCache = null
    this.supportsStreamAbort = true
  }

  setDefaultSystemInstruction(systemInstruction, mode = this.systemInstructionMode) {
    this.defaultSystemInstruction = systemInstruction
    this.systemInstructionMode = normalizeSystemInstructionMode(mode)
  }

  _buildConfig(modelName, request) {
    const requestParameters = request?.parameters || {}
    const { parameters, features } = getEffectiveCapabilities(this.capabilities, modelName)
    const config = buildProviderConfig(parameters, requestParameters)

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
    if (!part.data) return null
    const mimeType = part.mimeType || 'application/octet-stream'
    if (mimeType.startsWith('image/')) {
      return {
        type: 'image_url',
        image_url: { url: `data:${mimeType};base64,${part.data}` },
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
    // Generic OpenAI-compatible servers have no document block type; skip.
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
    // Config-file overrides win over UI parameters; nested objects merge so
    // e.g. chat_template_kwargs entries combine instead of replacing.
    return deepMerge(
      {
        model: request.model,
        messages,
        ...config,
      },
      this.requestOverrides
    )
  }

  async *generateStream(request) {
    const stream = await this.client.chat.completions.create(
      {
        ...this._buildRequest(request),
        stream: true,
        stream_options: { include_usage: true },
      },
      request.signal ? { signal: request.signal } : undefined
    )

    const emit = (extra) =>
      eventFromParts({
        chatId: request.chatId,
        requestId: request.requestId,
        provider: this.providerId,
        ...extra,
      })

    for await (const data of stream) {
      if (data.error) {
        const err = new Error(data.error.message || 'OpenAI-compatible stream error')
        err.status = Number(data.error.code) || 502
        throw err
      }

      const choice = data.choices?.[0]
      if (choice) {
        const delta = choice.delta || {}
        const finishReason = choice.finish_reason
        if (finishReason === 'error') {
          throw new Error('OpenAI-compatible stream ended with error')
        }
        if (delta.content) {
          yield emit({ parts: [{ text: delta.content }] })
        }
        // vLLM (DeepSeek-style) streams thoughts as `reasoning_content`.
        const reasoning = delta.reasoning_content ?? delta.reasoning
        if (reasoning) {
          yield emit({ parts: [{ text: reasoning, thought: true }] })
        }
        if (finishReason) {
          yield emit({ finishReason })
        }
      }

      if (data.usage) {
        yield emit({ usage: normalizeUsage(data.usage) })
      }
    }
  }

  async generate(request) {
    const data = await this.client.chat.completions.create(this._buildRequest(request))
    const choice = data.choices?.[0] || {}
    const message = choice.message || {}
    const parts = []
    const reasoning = message.reasoning_content ?? message.reasoning
    if (reasoning) parts.push({ text: reasoning, thought: true })
    if (typeof message.content === 'string' && message.content) {
      parts.push({ text: message.content })
    }
    return eventFromParts({
      chatId: request.chatId,
      requestId: request.requestId,
      provider: this.providerId,
      parts,
      usage: normalizeUsage(data.usage),
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
    this._modelsCache = { data, fetchedAt: now }
    return this._modelsCache
  }

  async listModels() {
    let served = null
    try {
      const cache = await this._loadModelsMetadata()
      served = cache.data.map((m) => m.id).filter(Boolean)
    } catch {
      // Endpoint unreachable; fall back to the configured list below.
    }
    if (this.allowlist.length) {
      if (!served) return [...this.allowlist]
      const filtered = this.allowlist.filter((id) => served.includes(id))
      return filtered.length ? filtered : [...this.allowlist]
    }
    // Unlike OpenRouter, a self-hosted endpoint serves few models, so listing
    // everything it reports is the sensible default.
    return served || []
  }

  async getModelCapabilities(modelName) {
    const base = getDefaultCapabilities(this.capabilities)
    const override = findCapabilityModelOverride(this.capabilities, modelName)
    const effective = applyCapabilityModelOverride(base, override)
    const display = buildModelCapabilitiesFromEffective(effective, modelName)
    display.provider = this.providerId
    display.label = this.label
    return display
  }
}
