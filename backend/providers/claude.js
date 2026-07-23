import Anthropic from '@anthropic-ai/sdk'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  applyCapabilityModelOverride,
  buildModelCapabilitiesFromEffective,
  findCapabilityModelOverride,
  getDefaultCapabilities,
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

// Anthropic requires thinking.budget_tokens >= 1024 and max_tokens strictly
// greater than the budget. CLAUDE_DEFAULT_MAX_TOKENS only applies when a model
// definition omits maxOutputTokens (every listed model sets it).
const CLAUDE_MIN_THINKING_BUDGET = 1024
const CLAUDE_DEFAULT_MAX_TOKENS = 64000
const MODELS_CACHE_TTL_MS = 30 * 60 * 1000 // 30 minutes
const CLAUDE_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
const CLAUDE_DOCUMENT_MIMES = ['application/pdf', 'text/plain']
const EFFORT_LEVELS = [
  ['low', 'Low'],
  ['medium', 'Medium'],
  ['high', 'High'],
  ['xhigh', 'X High'],
  ['max', 'Max'],
]

function isSupported(value) {
  return value?.supported === true
}

function positiveInteger(value) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : null
}

function unique(values) {
  return [...new Set(values.filter(Boolean))]
}

function mergeAllowedMimes(attachments, mimes) {
  if (!mimes.length) return attachments
  return {
    ...(attachments || {}),
    enabled: true,
    allowRemoteUpload: false,
    allowedMimes: unique([...(attachments?.allowedMimes || []), ...mimes]),
  }
}

// Single source of truth for Claude's thinking quirks across API versions:
//   adaptive  — type:"adaptive" (auto). Opus 4.6+ / Fable 5.
//   enabled   — legacy type:"enabled" + budget_tokens. Removed (400) on
//               Fable 5 / Opus 4.7 / 4.8; still accepted on Sonnet 4.5 /
//               Haiku 4.5 (and deprecated-but-functional on Opus 4.6).
function deriveClaudeThinking(meta) {
  const thinking = meta?.capabilities?.thinking
  return {
    supported: isSupported(thinking),
    adaptive: isSupported(thinking?.types?.adaptive),
    enabled: isSupported(thinking?.types?.enabled),
  }
}

function buildThinkingParameter(meta, maxOutputTokens) {
  const thinking = deriveClaudeThinking(meta)
  if (!thinking.supported) return null

  const specialValues = [{ label: 'Disabled', value: 0 }]
  if (thinking.adaptive) {
    specialValues.push({ label: 'Adaptive', value: -1 })
  }

  const rangeMax = positiveInteger(maxOutputTokens)
  return {
    default: 'max',
    ui: {
      type: 'integer',
      label: 'Thinking Budget',
      ...(thinking.enabled && rangeMax
        ? {
            range: {
              min: CLAUDE_MIN_THINKING_BUDGET,
              max: Math.max(CLAUDE_MIN_THINKING_BUDGET, rangeMax - 1),
              step: 256,
            },
          }
        : {}),
      specialValues,
    },
    api: { transform: 'claudeThinking', adaptiveSupported: thinking.adaptive },
  }
}

function buildEffortParameter(meta) {
  const effort = meta?.capabilities?.effort
  if (!isSupported(effort)) return null

  const options = EFFORT_LEVELS
    .filter(([key]) => isSupported(effort[key]))
    .map(([value, label]) => ({ value, label }))

  if (!options.length) return null
  return {
    ui: {
      type: 'enum',
      label: 'Effort',
      options,
    },
    api: { path: 'output_config.effort' },
  }
}

function applyClaudeModelMetadata(effective, meta) {
  if (!effective || !meta) return effective

  const capabilities = meta.capabilities || {}
  const maxOutputTokens = positiveInteger(meta.max_tokens)
  const fallbackMaxOutputTokens = positiveInteger(
    effective.parameters?.maxOutputTokens?.ui?.range?.max
  )
  const thinkingMaxOutputTokens = maxOutputTokens || fallbackMaxOutputTokens
  const maxInputTokens = positiveInteger(meta.max_input_tokens)
  const parameters = { ...(effective.parameters || {}) }
  const thinking = deriveClaudeThinking(meta)
  const features = {
    ...(effective.features || {}),
    batch: isSupported(capabilities.batch),
    citations: isSupported(capabilities.citations),
    codeExecution: isSupported(capabilities.code_execution),
    contextManagement: isSupported(capabilities.context_management),
    structuredOutputs: isSupported(capabilities.structured_outputs),
    extendedThinking: thinking.supported,
    adaptiveThinking: thinking.adaptive,
    ...(maxInputTokens ? { maxInputTokens } : {}),
    ...(meta.display_name ? { displayName: meta.display_name } : {}),
    ...(meta.created_at ? { createdAt: meta.created_at } : {}),
  }

  if (maxOutputTokens && parameters.maxOutputTokens) {
    const maxParam = {
      ...parameters.maxOutputTokens,
      ui: {
        ...(parameters.maxOutputTokens.ui || {}),
        range: {
          ...(parameters.maxOutputTokens.ui?.range || {}),
          max: maxOutputTokens,
        },
      },
    }
    if (
      typeof maxParam.default === 'number' &&
      (maxParam.default <= 0 || maxParam.default > maxOutputTokens)
    ) {
      maxParam.default = maxOutputTokens
    }
    parameters.maxOutputTokens = maxParam
    features.maxOutputTokens = maxOutputTokens
  }

  const thinkingParameter = buildThinkingParameter(meta, thinkingMaxOutputTokens)
  if (thinkingParameter) parameters.thinkingBudget = thinkingParameter
  else delete parameters.thinkingBudget

  const effortParameter = buildEffortParameter(meta)
  if (effortParameter) parameters.effort = effortParameter
  else delete parameters.effort

  let attachments = { ...(effective.attachments || {}) }
  const mimes = []
  if (isSupported(capabilities.image_input)) mimes.push(...CLAUDE_IMAGE_MIMES)
  if (isSupported(capabilities.pdf_input)) mimes.push(...CLAUDE_DOCUMENT_MIMES)
  attachments = mergeAllowedMimes(attachments, mimes)

  return {
    ...effective,
    features,
    parameters,
    attachments,
  }
}

function claudeThinkingTransform({ config, value, definition }) {
  const adaptiveSupported = definition?.api?.adaptiveSupported === true
  const budget = Number(value)

  // Explicit "Adaptive" selection (-1).
  if (budget === -1) {
    config.thinking = { type: 'adaptive' }
    return
  }
  if (!Number.isFinite(budget) || budget < CLAUDE_MIN_THINKING_BUDGET) return

  // type:"enabled" with budget_tokens is deprecated and rejected (400) on
  // adaptive-capable models (Opus 4.6+/Fable 5). Map any positive budget to
  // adaptive there; keep the explicit budget only for legacy models that lack
  // adaptive thinking (e.g. Sonnet 4.5, Haiku 4.5).
  if (adaptiveSupported) {
    config.thinking = { type: 'adaptive' }
    return
  }

  config.thinking = {
    type: 'enabled',
    budget_tokens: budget,
  }
  const currentMax = config.max_tokens || CLAUDE_DEFAULT_MAX_TOKENS
  if (currentMax <= budget) {
    config.max_tokens = budget + CLAUDE_MIN_THINKING_BUDGET
  }
}

function normalizeClaudeUsage(u) {
  if (!u) return null
  const uncachedInput = u.input_tokens ?? null
  const cacheRead = u.cache_read_input_tokens ?? null
  const cacheWrite = u.cache_creation_input_tokens ?? null
  const inputParts = [uncachedInput, cacheRead, cacheWrite]
  const input = inputParts.some((value) => value != null)
    ? inputParts.reduce((sum, value) => sum + (value ?? 0), 0)
    : null
  const output = u.output_tokens ?? null
  return {
    inputTokens: input,
    uncachedInputTokens: uncachedInput,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    outputTokens: output,
    reasoningTokens: null,
    totalTokens: input != null && output != null ? input + output : null,
  }
}

export class ClaudeProvider {
  constructor(apiKey, systemInstruction, options = {}) {
    const { capabilitiesPath, systemInstructionMode } = options
    this.anthropic = new Anthropic({ apiKey })
    this.defaultSystemInstruction = systemInstruction
    this.systemInstructionMode =
      normalizeSystemInstructionMode(systemInstructionMode)
    this.capabilities = loadCapabilities('claude', capabilitiesPath, runtimeDirname)
    this.label = this.capabilities?.label ?? 'Claude'
    this.metadataTtlMs = MODELS_CACHE_TTL_MS
    this._modelsCache = null
  }

  setDefaultSystemInstruction(systemInstruction, mode = this.systemInstructionMode) {
    this.defaultSystemInstruction = systemInstruction
    this.systemInstructionMode = normalizeSystemInstructionMode(mode)
  }

  async _getEffectiveCapabilities(modelName) {
    const base = getDefaultCapabilities(this.capabilities)
    const meta = await this._getModelMetadata(modelName)
    const withMetadata = applyClaudeModelMetadata(base, meta)
    const override = findCapabilityModelOverride(this.capabilities, modelName)
    return applyCapabilityModelOverride(withMetadata, override)
  }

  async _buildConfig(modelName, request) {
    const requestParameters = request?.parameters || {}
    const { parameters, features } = await this._getEffectiveCapabilities(modelName)
    const config = buildProviderConfig(parameters, requestParameters, {
      claudeThinking: claudeThinkingTransform,
    })

    const systemInstruction = resolveSystemInstruction({
      defaultSystemInstruction: this.defaultSystemInstruction,
      userSystemInstruction: request?.systemInstruction,
      mode: this.systemInstructionMode,
    })
    if (features?.systemInstruction !== false && systemInstruction) {
      config.system = systemInstruction
    }
    return config
  }

  _buildContentBlock(part) {
    if (part?.type === 'text') {
      return { type: 'text', text: part.text || '' }
    }
    if (part?.type !== 'file') return null
    if (!part.data) {
      throw new Error('Claude attachments must be sent as inline data.')
    }
    const mimeType = part.mimeType || 'application/octet-stream'
    if (mimeType.startsWith('image/')) {
      return {
        type: 'image',
        source: { type: 'base64', media_type: mimeType, data: part.data },
      }
    }
    return {
      type: 'document',
      source: { type: 'base64', media_type: mimeType, data: part.data },
    }
  }

  _buildMessagesAndSystem(messages = [], system) {
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
    return { messages: result, system: mergedSystem }
  }

  async _buildRequest(request) {
    const config = await this._buildConfig(request.model, request)
    const { messages, system } = this._buildMessagesAndSystem(
      request.messages,
      config.system
    )
    if (system) config.system = system
    else delete config.system
    return {
      model: request.model,
      messages,
      ...config,
      cache_control: { type: 'ephemeral' },
    }
  }

  async *generateStream(request) {
    const sdkRequest = await this._buildRequest(request)
    const stream = this.anthropic.messages.stream(sdkRequest)
    const rawUsage = {
      input_tokens: null,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
      output_tokens: null,
    }

    for await (const event of stream) {
      if (event.type === 'message_start') {
        const u = event.message?.usage
        if (u?.input_tokens != null) rawUsage.input_tokens = u.input_tokens
        if (u?.cache_read_input_tokens != null) {
          rawUsage.cache_read_input_tokens = u.cache_read_input_tokens
        }
        if (u?.cache_creation_input_tokens != null) {
          rawUsage.cache_creation_input_tokens = u.cache_creation_input_tokens
        }
        if (u?.output_tokens != null) rawUsage.output_tokens = u.output_tokens
        yield eventFromParts({
          chatId: request.chatId,
          requestId: request.requestId,
          provider: 'claude',
          usage: normalizeClaudeUsage(rawUsage),
        })
      } else if (event.type === 'content_block_delta') {
        const delta = event.delta || {}
        if (delta.type === 'text_delta') {
          yield eventFromParts({
            chatId: request.chatId,
            requestId: request.requestId,
            provider: 'claude',
            parts: [{ text: delta.text || '' }],
          })
        } else if (delta.type === 'thinking_delta' || delta.type === 'thinking') {
          yield eventFromParts({
            chatId: request.chatId,
            requestId: request.requestId,
            provider: 'claude',
            parts: [{ text: delta.thinking || '', thought: true }],
          })
        }
      } else if (event.type === 'message_delta') {
        const u = event.usage
        if (u?.output_tokens != null) rawUsage.output_tokens = u.output_tokens
        yield eventFromParts({
          chatId: request.chatId,
          requestId: request.requestId,
          provider: 'claude',
          usage: normalizeClaudeUsage(rawUsage),
          finishReason: event.delta?.stop_reason || null,
        })
      }
    }
  }

  async generate(request) {
    const sdkRequest = await this._buildRequest(request)
    const result = await this.anthropic.messages.create(sdkRequest)
    const parts = (result.content || []).map((block) => {
      if (block.type === 'text') return { text: block.text }
      if (block.type === 'thinking') return { text: block.thinking, thought: true }
      return null
    }).filter(Boolean)
    return eventFromParts({
      chatId: request.chatId,
      requestId: request.requestId,
      provider: 'claude',
      parts,
      usage: normalizeClaudeUsage(result.usage),
      finishReason: result.stop_reason || null,
    })
  }

  async listModels() {
    try {
      const cache = await this._loadModelsMetadata()
      return cache.data.map((model) => model.id).filter(Boolean)
    } catch {
      const models = Array.isArray(this.capabilities?.models)
        ? this.capabilities.models
        : []
      return models
        .map((model) => model.modelName || model.id || model.modelQuery)
        .filter(Boolean)
    }
  }

  async getModelCapabilities(modelName) {
    const effective = await this._getEffectiveCapabilities(modelName)
    return buildModelCapabilitiesFromEffective(effective, modelName)
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
    const page = await this.anthropic.models.list()
    const data = Array.isArray(page?.data) ? page.data : []
    const byId = new Map(data.map((model) => [model.id, model]))
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
}
