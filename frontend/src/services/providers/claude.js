import {
  escapeHtml,
  blobToBase64,
  normalizeError as sharedNormalizeError,
  parseUsage,
  appendIfDefined,
  parametersFromConfig,
} from './utils'

export const id = 'claude'
export const label = 'Anthropic Claude'
export const supportedTools = []
export const attachmentPolicy = {
  allowRemoteUpload: false,
  allowedMimes: new Set([
    'text/plain',
    'application/pdf',
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
  ]),
}

function isSupportedInlineAttachment(att) {
  const mimeType = att?.mimeType || ''
  return (
    mimeType.startsWith('image/') ||
    mimeType === 'application/pdf' ||
    mimeType === 'text/plain'
  )
}

async function attachmentToContentBlock(att) {
  if (!att?.blob || !isSupportedInlineAttachment(att)) return null

  const data = await blobToBase64(att.blob)
  const mimeType = att.mimeType || 'application/octet-stream'
  if (mimeType.startsWith('image/')) {
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: mimeType,
        data,
      },
    }
  }
  return {
    type: 'document',
    source: {
      type: 'base64',
      media_type: mimeType,
      data,
    },
  }
}

async function buildContentBlocks(message) {
  const blocks = []
  const text = message?.content?.text ?? ''
  if (text) {
    blocks.push({ type: 'text', text })
  }
  for (const att of message?.attachments || []) {
    const block = await attachmentToContentBlock(att)
    if (block) blocks.push(block)
  }
  if (!blocks.length) {
    blocks.push({ type: 'text', text: '' })
  }
  return blocks
}

function mergeSystem(existing, next) {
  const parts = []
  if (existing) parts.push(existing)
  if (next) parts.push(next)
  return parts.join('\n\n')
}

function buildClaudeConfig(requestConfig) {
  const parameters = requestConfig?.parameters || {}
  const config = {}

  const maxTokens = Number(parameters.maxOutputTokens)
  if (Number.isFinite(maxTokens) && maxTokens > 0) {
    config.max_tokens = maxTokens
  }

  appendIfDefined(config, 'temperature', parameters.temperature)
  appendIfDefined(config, 'top_p', parameters.topP)
  appendIfDefined(config, 'top_k', parameters.topK)

  if (requestConfig.systemInstruction) {
    config.system = requestConfig.systemInstruction
  }

  const thinkingBudget = Number(parameters.thinkingBudget)
  if (thinkingBudget === 0) {
    config.thinking = { type: 'disabled' }
  } else if (thinkingBudget === -1) {
    config.thinking = { type: 'adaptive' }
  } else if (Number.isFinite(thinkingBudget) && thinkingBudget >= 1024) {
    config.thinking = {
      type: 'enabled',
      budget_tokens: thinkingBudget,
    }
  }

  return config
}

export async function buildPayload({
  chatId,
  requestId,
  model,
  messages = [],
  streaming,
  requestConfig,
}) {
  const config = buildClaudeConfig(requestConfig)
  const claudeMessages = []

  for (const message of messages) {
    if (!message?.sender) continue
    const role = String(message.sender).toLowerCase()
    if (role === 'system') {
      config.system = mergeSystem(config.system, message?.content?.text || '')
      continue
    }
    if (!['user', 'model'].includes(role)) continue
    claudeMessages.push({
      role: role === 'model' ? 'assistant' : 'user',
      content: await buildContentBlocks(message),
    })
  }

  return {
    provider: id,
    chatId,
    requestId,
    model,
    messages: claudeMessages,
    config,
    streaming,
  }
}

export function parseStreamChunk(rawChunk) {
  const result = {}
  const metadata = {}

  if (Array.isArray(rawChunk.parts)) {
    for (const part of rawChunk.parts) {
      if (typeof part?.text === 'string' && part.text) {
        if (part.thought) {
          result.thoughtDelta = (result.thoughtDelta || '') + part.text
        } else {
          result.deltaText = (result.deltaText || '') + part.text
        }
      }
    }
  }

  const usage = parseUsage(rawChunk.usage)
  if (usage) metadata.usage = usage

  if (rawChunk.finishReason) {
    result.finishReason = rawChunk.finishReason
    metadata.finishReason = rawChunk.finishReason
  }

  if (Object.keys(metadata).length) {
    metadata.provider = id
    result.metadata = metadata
  }

  return result
}

export function buildDisplayIndicators(message) {
  const indicators = []
  const config = message?.configSnapshot || {}
  const params = parametersFromConfig(config)

  if (config.model) indicators.push({ icon: 'robot', text: config.model })
  if (params.temperature !== undefined) {
    indicators.push({
      icon: 'thermometer-half',
      text: `Temperature: ${params.temperature}`,
    })
  }
  if (params.topP !== undefined) {
    indicators.push({ icon: 'chart-pie', text: `Top-P: ${params.topP}` })
  }
  if (params.topK !== undefined) {
    indicators.push({ icon: 'sliders-h', text: `Top-K: ${params.topK}` })
  }
  if (params.maxOutputTokens !== undefined) {
    indicators.push({
      icon: 'file-alt',
      text: `Max Output Tokens: ${params.maxOutputTokens}`,
    })
  }
  if (params.thinkingBudget !== undefined) {
    indicators.push({
      icon: 'cogs',
      text: `Thinking Budget: ${params.thinkingBudget}`,
    })
  }
  return indicators
}

function buildMetadataLines(message, { includeModelDetails = true } = {}) {
  const config = message?.configSnapshot || {}
  const metadata = message?.metadata || {}
  const params = parametersFromConfig(config)
  const lines = []
  const parameterParts = []

  if (params.temperature !== undefined)
    parameterParts.push(`Temp: ${params.temperature}`)
  if (params.topP !== undefined) parameterParts.push(`Top-P: ${params.topP}`)
  if (params.topK !== undefined) parameterParts.push(`Top-K: ${params.topK}`)
  if (params.maxOutputTokens !== undefined)
    parameterParts.push(`MaxTokens: ${params.maxOutputTokens}`)
  if (params.thinkingBudget !== undefined)
    parameterParts.push(`Thinking: ${params.thinkingBudget}`)

  if (includeModelDetails && config.model) {
    lines.push(
      parameterParts.length
        ? `${config.model} [ ${parameterParts.join(', ')} ]`
        : config.model
    )
  }

  const finishReason = metadata.finishReason || metadata.finish_reason
  const usage = metadata.usage || {}
  const usageParts = []
  if (usage.prompt != null) usageParts.push(`Prompt: ${usage.prompt}`)
  if (usage.output != null) usageParts.push(`Output: ${usage.output}`)
  if (usage.reasoning != null) usageParts.push(`Reasoning: ${usage.reasoning}`)
  if (usage.total != null) usageParts.push(`Total: ${usage.total}`)

  const detailSegments = []
  if (usageParts.length) {
    detailSegments.push(`Tokens [ ${usageParts.join(', ')} ]`)
  }
  if (finishReason) {
    detailSegments.push(`Finish [ ${finishReason} ]`)
  }
  if (detailSegments.length) {
    lines.push(detailSegments.join(', '))
  }

  return lines
}

export function buildMetadataHtml(message) {
  return buildMetadataLines(message, { includeModelDetails: false }).join('\n')
}

export function buildMetadataHtmlForExport(message) {
  return buildMetadataLines(message, { includeModelDetails: false })
    .map((line) => `<div class="metadata-item">${escapeHtml(line)}</div>`)
    .join('')
}

export function normalizeError(rawError, phase) {
  return sharedNormalizeError(rawError, phase, id)
}
