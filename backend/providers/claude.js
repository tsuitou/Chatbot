import Anthropic from '@anthropic-ai/sdk'
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

// Anthropic requires thinking.budget_tokens >= 1024 and max_tokens strictly
// greater than the budget. CLAUDE_DEFAULT_MAX_TOKENS only applies when a model
// definition omits maxOutputTokens (every listed model sets it).
const CLAUDE_MIN_THINKING_BUDGET = 1024
const CLAUDE_DEFAULT_MAX_TOKENS = 64000

function claudeThinkingTransform({ config, value }) {
  const budget = Number(value)
  if (budget === -1) {
    config.thinking = { type: 'adaptive' }
    return
  }
  if (!Number.isFinite(budget) || budget < CLAUDE_MIN_THINKING_BUDGET) return

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
  const input = u.input_tokens ?? null
  const output = u.output_tokens ?? null
  return {
    inputTokens: input,
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
  }

  setDefaultSystemInstruction(systemInstruction, mode = this.systemInstructionMode) {
    this.defaultSystemInstruction = systemInstruction
    this.systemInstructionMode = normalizeSystemInstructionMode(mode)
  }

  _buildConfig(modelName, request) {
    const requestParameters = request?.parameters || {}
    const { parameters, features } = getEffectiveCapabilities(this.capabilities, modelName)
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

  _buildRequest(request) {
    const config = this._buildConfig(request.model, request)
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
    }
  }

  async *generateStream(request) {
    const sdkRequest = this._buildRequest(request)
    const stream = this.anthropic.messages.stream(sdkRequest)
    const rawUsage = { input_tokens: null, output_tokens: null }

    for await (const event of stream) {
      if (event.type === 'message_start') {
        const u = event.message?.usage
        if (u?.input_tokens != null) rawUsage.input_tokens = u.input_tokens
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
    const sdkRequest = this._buildRequest(request)
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
    const page = await this.anthropic.models.list()
    const models = Array.isArray(page?.data) ? page.data : []
    return models.map((model) => model.id).filter(Boolean)
  }

  async getModelCapabilities(modelName) {
    return buildModelCapabilities(this.capabilities, modelName)
  }
}
