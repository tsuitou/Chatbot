import Anthropic from '@anthropic-ai/sdk'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  buildConfigRanges,
  getEffectiveCapabilities,
  loadCapabilities,
} from './capabilities.js'

const runtimeFilename = fileURLToPath(import.meta.url)
const runtimeDirname = path.dirname(runtimeFilename)

function normalizeUsage(u) {
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
    const { capabilitiesPath } = options
    this.anthropic = new Anthropic({ apiKey })
    this.defaultSystemInstruction = systemInstruction
    this.capabilities = loadCapabilities('claude', capabilitiesPath, runtimeDirname)
  }

  setDefaultSystemInstruction(systemInstruction) {
    this.defaultSystemInstruction = systemInstruction
  }

  _normalizeRequest(modelName, messages, config = {}) {
    const { parameters, features } = getEffectiveCapabilities(this.capabilities, modelName)
    const ranges = buildConfigRanges(parameters, features)

    const request = {
      model: modelName,
      messages,
      ...config,
    }

    if (request.max_tokens === undefined || request.max_tokens === null) {
      if (ranges.maxOutputTokens && ranges.maxOutputTokens.default !== undefined) {
        request.max_tokens = ranges.maxOutputTokens.default
      }
    }

    if (request.temperature === undefined || request.temperature === null) {
      if (ranges.temperature && ranges.temperature.default !== undefined) {
        request.temperature = ranges.temperature.default
      }
    }

    if (request.top_p === undefined || request.top_p === null) {
      if (ranges.topP && ranges.topP.default !== undefined) {
        request.top_p = ranges.topP.default
      }
    }

    if (request.top_k === undefined || request.top_k === null) {
      if (ranges.topK && ranges.topK.default !== undefined) {
        request.top_k = ranges.topK.default
      }
    }

    if (request.thinking === undefined || request.thinking === null) {
      if (ranges.thinkingBudget && ranges.thinkingBudget.default !== undefined) {
        const defaultBudget = ranges.thinkingBudget.default
        if (defaultBudget === -1) {
          request.thinking = { type: 'adaptive' }
        } else if (defaultBudget >= 1024) {
          request.thinking = {
            type: 'enabled',
            budget_tokens: defaultBudget
          }
          // Ensure max_tokens is strictly greater than budget_tokens
          const currentMax = request.max_tokens || 64000
          if (currentMax <= defaultBudget) {
            request.max_tokens = defaultBudget + 1024
          }
        }
      }
    } else if (request.thinking && request.thinking.type === 'disabled') {
      delete request.thinking
    }

    if (!request.system && this.defaultSystemInstruction) {
      request.system = this.defaultSystemInstruction
    }
    return request
  }

  async *generateStream(modelName, messages, config, chatId, requestId) {
    const request = this._normalizeRequest(modelName, messages, config)
    const stream = this.anthropic.messages.stream(request)
    const rawUsage = { input_tokens: null, output_tokens: null }

    for await (const event of stream) {
      if (event.type === 'message_start') {
        const u = event.message?.usage
        if (u?.input_tokens != null) rawUsage.input_tokens = u.input_tokens
        if (u?.output_tokens != null) rawUsage.output_tokens = u.output_tokens
        yield { chatId, requestId, provider: 'claude', usage: normalizeUsage(rawUsage) }
      } else if (event.type === 'content_block_delta') {
        const delta = event.delta || {}
        if (delta.type === 'text_delta') {
          yield { chatId, requestId, provider: 'claude', parts: [{ text: delta.text || '' }] }
        } else if (delta.type === 'thinking_delta' || delta.type === 'thinking') {
          yield { chatId, requestId, provider: 'claude', parts: [{ text: delta.thinking || '', thought: true }] }
        }
      } else if (event.type === 'message_delta') {
        const u = event.usage
        if (u?.output_tokens != null) rawUsage.output_tokens = u.output_tokens
        yield {
          chatId,
          requestId,
          provider: 'claude',
          usage: normalizeUsage(rawUsage),
          finishReason: event.delta?.stop_reason || null,
        }
      }
    }
  }

  async generate(modelName, messages, config, chatId, requestId) {
    const request = this._normalizeRequest(modelName, messages, config)
    const result = await this.anthropic.messages.create(request)
    const parts = (result.content || []).map((block) => {
      if (block.type === 'text') return { text: block.text }
      if (block.type === 'thinking') return { text: block.thinking, thought: true }
      return null
    }).filter(Boolean)
    return {
      chatId,
      requestId,
      provider: 'claude',
      parts,
      usage: normalizeUsage(result.usage),
      finishReason: result.stop_reason || null,
    }
  }

  async listModels() {
    const page = await this.anthropic.models.list()
    const models = Array.isArray(page?.data) ? page.data : []
    return models.map((model) => model.id).filter(Boolean)
  }

  async getModelConfigRanges(modelName) {
    const { parameters, features } = getEffectiveCapabilities(this.capabilities, modelName)
    return buildConfigRanges(parameters, features)
  }
}
