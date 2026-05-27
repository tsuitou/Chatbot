import Anthropic from '@anthropic-ai/sdk'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  buildConfigRanges,
  buildModelCapabilities,
  getEffectiveCapabilities,
  loadCapabilities,
} from './capabilities.js'
import { eventFromParts } from './events.js'
import { applyParameterMap, mergeText } from './request.js'

const runtimeFilename = fileURLToPath(import.meta.url)
const runtimeDirname = path.dirname(runtimeFilename)

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
    const { capabilitiesPath } = options
    this.anthropic = new Anthropic({ apiKey })
    this.defaultSystemInstruction = systemInstruction
    this.capabilities = loadCapabilities('claude', capabilitiesPath, runtimeDirname)
  }

  setDefaultSystemInstruction(systemInstruction) {
    this.defaultSystemInstruction = systemInstruction
  }

  _buildConfig(modelName, request) {
    const requestParameters = request?.parameters || {}
    const { parameters, features } = getEffectiveCapabilities(this.capabilities, modelName)
    const ranges = buildConfigRanges(parameters)

    const config = {}
    applyParameterMap(
      config,
      requestParameters,
      this.capabilities?.api?.parameterMap
    )

    if (config.max_tokens === undefined || config.max_tokens === null) {
      if (ranges.maxOutputTokens && ranges.maxOutputTokens.default !== undefined) {
        config.max_tokens = ranges.maxOutputTokens.default
      }
    }

    if (config.temperature === undefined || config.temperature === null) {
      if (ranges.temperature && ranges.temperature.default !== undefined) {
        config.temperature = ranges.temperature.default
      }
    }

    if (config.top_p === undefined || config.top_p === null) {
      if (ranges.topP && ranges.topP.default !== undefined) {
        config.top_p = ranges.topP.default
      }
    }

    if (config.top_k === undefined || config.top_k === null) {
      if (ranges.topK && ranges.topK.default !== undefined) {
        config.top_k = ranges.topK.default
      }
    }

    const thinkingBudget = Number(requestParameters.thinkingBudget)
    if (thinkingBudget === 0) {
      config.thinking = { type: 'disabled' }
    } else if (thinkingBudget === -1) {
      config.thinking = { type: 'adaptive' }
    } else if (Number.isFinite(thinkingBudget) && thinkingBudget >= 1024) {
      config.thinking = {
        type: 'enabled',
        budget_tokens: thinkingBudget,
      }
      const currentMax = config.max_tokens || 64000
      if (currentMax <= thinkingBudget) {
        config.max_tokens = thinkingBudget + 1024
      }
    }

    if (config.thinking === undefined || config.thinking === null) {
      if (ranges.thinkingBudget && ranges.thinkingBudget.default !== undefined) {
        const defaultBudget = ranges.thinkingBudget.default
        if (defaultBudget === -1) {
          config.thinking = { type: 'adaptive' }
        } else if (defaultBudget >= 1024) {
          config.thinking = {
            type: 'enabled',
            budget_tokens: defaultBudget
          }
          // Ensure max_tokens is strictly greater than budget_tokens
          const currentMax = config.max_tokens || 64000
          if (currentMax <= defaultBudget) {
            config.max_tokens = defaultBudget + 1024
          }
        }
      }
    } else if (config.thinking && config.thinking.type === 'disabled') {
      delete config.thinking
    }

    if (request?.systemInstruction || this.defaultSystemInstruction) {
      config.system = request?.systemInstruction || this.defaultSystemInstruction
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
