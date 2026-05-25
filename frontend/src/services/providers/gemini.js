import { v4 as uuidv4 } from 'uuid'
import { uploadFile as apiUploadFile } from '../api'
import { safeAnchorHtml } from '../htmlSafety'
import {
  escapeHtml,
  blobToBase64,
  normalizeError as sharedNormalizeError,
  parseUsage,
  appendIfDefined,
  base64ToBlob,
  parametersFromConfig,
  optionsFromConfig,
} from './utils'

export const id = 'gemini'
export const label = 'Google Gemini'
export const supportedTools = [
  'useUrlContext',
  'useGrounding',
  'useCodeExecution',
]
export const attachmentPolicy = {
  allowRemoteUpload: true,
  allowedMimes: null,
}

function prepareToolConfig(tools = {}) {
  const result = []
  if (tools.useUrlContext) result.push({ urlContext: {} })
  if (tools.useCodeExecution) result.push({ codeExecution: {} })
  if (tools.useGrounding) result.push({ googleSearch: {} })
  return result
}

function coerceParameters(config) {
  return {
    ...(config?.parameters || {}),
  }
}

function coerceOptions(config) {
  return {
    ...(config?.options || {}),
  }
}

async function buildMessageParts(message) {
  const parts = []
  const text = message?.content?.text ?? ''
  if (text) {
    parts.push({ text })
  }

  if (message?.attachments && message.attachments.length > 0) {
    for (const att of message.attachments) {
      if (att.remoteUri) {
        parts.push({
          fileData: { mimeType: att.mimeType, fileUri: att.remoteUri },
        })
      } else if (att.blob) {
        const base64Data = await blobToBase64(att.blob)
        parts.push({
          inlineData: { mimeType: att.mimeType, data: base64Data },
        })
      } else {
        throw new Error(
          `Attachment "${att?.name || att?.id || '(unknown)'}" is missing both blob data and remote URI. This may indicate a data consistency issue or incomplete upload.`
        )
      }
    }
  }

  if (parts.length === 0) {
    parts.push({ text: '' })
  }

  const thoughtSignatures = Array.isArray(message?.metadata?.thoughtSignatures)
    ? message.metadata.thoughtSignatures
    : []
  if (thoughtSignatures.length) {
    const seen = new Set()
    for (const entry of thoughtSignatures) {
      const signature = entry?.signature ?? entry
      if (!signature) continue
      const targetIndex =
        typeof entry?.partIndex === 'number' &&
        entry.partIndex >= 0 &&
        entry.partIndex < parts.length
          ? entry.partIndex
          : 0
      const key = `${targetIndex}:${signature}`
      if (seen.has(key)) continue
      seen.add(key)
      const target = parts[targetIndex] || parts[0]
      if (target) {
        target.thoughtSignature = signature
      }
    }
  }

  return parts
}

export async function buildPayload({
  chatId,
  requestId,
  model,
  streaming,
  messages = [],
  requestConfig,
}) {
  const parameters = coerceParameters(requestConfig)
  const options = coerceOptions(requestConfig)

  const config = {
    tools: prepareToolConfig(requestConfig.tools),
  }

  const excludedKeys = ['thinkingBudget', 'thinkingLevel']
  for (const [key, value] of Object.entries(parameters)) {
    if (excludedKeys.includes(key)) continue
    appendIfDefined(config, key, value)
  }

  if (requestConfig.systemInstruction) {
    config.systemInstruction = requestConfig.systemInstruction
  }

  const thinkingBudget = parameters.thinkingBudget
  const thinkingLevel = parameters.thinkingLevel
  const includeThoughts = options.includeThoughts

  if (
    thinkingBudget != null ||
    thinkingLevel != null ||
    includeThoughts != null
  ) {
    const thinkingConfig = {}
    appendIfDefined(thinkingConfig, 'thinkingBudget', thinkingBudget)
    appendIfDefined(thinkingConfig, 'thinkingLevel', thinkingLevel)
    if (includeThoughts != null) {
      thinkingConfig.includeThoughts = !!includeThoughts
    }
    if (Object.keys(thinkingConfig).length > 0) {
      config.thinkingConfig = thinkingConfig
    }
  }

  const contents = []
  for (const message of messages) {
    if (!message?.sender) continue
    const role = String(message.sender).toLowerCase()
    if (!['user', 'model', 'system', 'tool'].includes(role)) continue
    const parts = await buildMessageParts(message)
    contents.push({ role, parts })
  }

  return {
    provider: id,
    chatId,
    requestId,
    model,
    contents,
    config,
    streaming,
  }
}

export function parseStreamChunk(rawChunk) {
  const result = {}
  let textContent = ''
  let thoughtContent = ''
  const attachments = []
  const thoughtSignatures = []
  const seenSignatures = new Set()

  if (Array.isArray(rawChunk.parts)) {
    for (let idx = 0; idx < rawChunk.parts.length; idx++) {
      const part = rawChunk.parts[idx]
      if (part.text) {
        if (part.thought) {
          thoughtContent += part.text
        } else {
          textContent += part.text
        }
      }
      if (part.executableCode) {
        const { language, code } = part.executableCode
        textContent += `\n\n\`\`\`${language}\n${code}\n\`\`\`\n`
      }
      if (part.codeExecutionResult) {
        const output = part.codeExecutionResult.output ?? ''
        textContent += `\n\n\`\`\`bash\n${output}\n\`\`\`\n`
      }
      if (part.inlineData) {
        const { mimeType, data } = part.inlineData
        const blob = base64ToBlob(data, mimeType)
        attachments.push({
          id: uuidv4(),
          name: `generated_${Date.now()}`,
          mimeType,
          size: blob.size,
          source: 'model',
          blob,
        })
      }
      if (part.thoughtSignature) {
        const sig = String(part.thoughtSignature)
        const key = `${idx}:${sig}`
        if (!seenSignatures.has(key)) {
          seenSignatures.add(key)
          thoughtSignatures.push({ signature: sig, partIndex: idx })
        }
      }
    }
  }

  if (textContent) {
    result.deltaText = textContent
  }
  if (thoughtContent) {
    result.thoughtDelta = thoughtContent
  }
  if (attachments.length > 0) {
    result.newAttachments = attachments
  }

  const metadata = {}
  if (thoughtSignatures.length) {
    metadata.thoughtSignatures = thoughtSignatures
  }

  if (rawChunk.finishReason) {
    metadata.finishReason = rawChunk.finishReason
    result.finishReason = rawChunk.finishReason
  }

  const usage = parseUsage(rawChunk.usage)
  if (usage) metadata.usage = usage

  const grounding = rawChunk.grounding || rawChunk.metadata?.grounding
  if (grounding) {
    const sources = []
    if (Array.isArray(grounding.groundingChunks)) {
      for (const chunk of grounding.groundingChunks) {
        const uri = chunk.web?.uri
        const title = chunk.web?.title
        if (uri && title) {
          sources.push({ uri, title })
        }
      }
    } else if (Array.isArray(grounding.sources)) {
      for (const src of grounding.sources) {
        const uri = src?.uri
        const title = src?.title
        if (uri && title) {
          sources.push({ uri, title })
        }
      }
    }
    metadata.grounding = {
      sources,
      webSearchQueries: grounding.webSearchQueries ?? [],
      raw: grounding,
    }
  }

  if (Object.keys(metadata).length > 0) {
    metadata.provider = id
    result.metadata = metadata
  }

  return result
}

export function buildDisplayIndicators(message) {
  const indicators = []
  const config = message?.configSnapshot || {}
  const params = parametersFromConfig(config)
  const options = optionsFromConfig(config)

  if (config.model) {
    indicators.push({ icon: 'robot', text: config.model })
  }
  if (params.temperature !== undefined) {
    indicators.push({
      icon: 'thermometer-half',
      text: `Temperature: ${params.temperature}`,
    })
  }
  if (params.topP !== undefined) {
    indicators.push({ icon: 'chart-pie', text: `Top-P: ${params.topP}` })
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
  if (params.thinkingLevel !== undefined) {
    indicators.push({
      icon: 'cogs',
      text: `Thinking Level: ${params.thinkingLevel}`,
    })
  }
  if (options.includeThoughts) {
    indicators.push({ icon: 'check', text: 'Include Thoughts' })
  }
  if (config.tools?.useUrlContext) {
    indicators.push({ icon: 'link', text: 'URL Context' })
  }
  if (config.tools?.useGrounding) {
    indicators.push({ icon: 'search', text: 'Search Grounding' })
  }
  if (config.tools?.useCodeExecution) {
    indicators.push({ icon: 'code', text: 'Code Execution' })
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
    parameterParts.push(`Temp: ${escapeHtml(params.temperature)}`)
  if (params.topP !== undefined)
    parameterParts.push(`Top-P: ${escapeHtml(params.topP)}`)
  if (params.maxOutputTokens !== undefined)
    parameterParts.push(`MaxTokens: ${escapeHtml(params.maxOutputTokens)}`)
  if (params.thinkingBudget !== undefined)
    parameterParts.push(`Thinking: ${escapeHtml(params.thinkingBudget)}`)
  if (params.thinkingLevel !== undefined)
    parameterParts.push(`Thinking Level: ${escapeHtml(params.thinkingLevel)}`)

  const modelLabel = config.model ? escapeHtml(config.model) : ''
  let firstLine = ''
  if (modelLabel) {
    firstLine = modelLabel
    if (parameterParts.length) {
      firstLine += ` [ ${parameterParts.join(', ')} ]`
    }
  } else if (parameterParts.length) {
    firstLine = `Parameters [ ${parameterParts.join(', ')} ]`
  }
  if (firstLine && includeModelDetails) {
    lines.push(firstLine)
  }

  const finishReason = metadata.finishReason || metadata.finish_reason
  const usage = metadata.usage || {}
  const prompt = usage.prompt ?? usage.promptTokenCount
  const output = usage.output ?? usage.candidatesTokenCount
  const reasoning = usage.reasoning ?? usage.thoughtsTokenCount
  const total = usage.total ?? usage.totalTokenCount
  const signatureCount = Array.isArray(metadata.thoughtSignatures)
    ? metadata.thoughtSignatures.length
    : 0
  const usageParts = []
  if (prompt != null) usageParts.push(`Prompt: ${escapeHtml(prompt)}`)
  if (output != null) usageParts.push(`Output: ${escapeHtml(output)}`)
  if (reasoning != null) usageParts.push(`Reasoning: ${escapeHtml(reasoning)}`)
  if (total != null) usageParts.push(`Total: ${escapeHtml(total)}`)

  const detailSegments = []
  if (usageParts.length) {
    detailSegments.push(`Tokens [ ${usageParts.join(', ')} ]`)
  }
  if (finishReason) {
    detailSegments.push(`Finish [ ${escapeHtml(finishReason)} ]`)
  }
  if (signatureCount > 0) {
    detailSegments.push(`Thought Signatures [ ${signatureCount} ]`)
  }
  if (detailSegments.length) {
    lines.push(detailSegments.join(', '))
  }

  const grounding = metadata.grounding || {}
  let sources = []
  if (Array.isArray(grounding.sources) && grounding.sources.length) {
    sources = grounding.sources
  } else if (Array.isArray(grounding.groundingChunks)) {
    sources = grounding.groundingChunks
      .map((chunk) => {
        const uri = chunk.web?.uri
        const title = chunk.web?.title
        return uri && title ? { uri, title } : null
      })
      .filter(Boolean)
  }

  const queries = grounding.webSearchQueries || grounding.web_search_queries

  if (sources.length) {
    const sourceLinks = sources
      .map((src) => {
        return safeAnchorHtml(
          src.uri,
          src.title || src.uri,
          'target="_blank" rel="noopener noreferrer"'
        )
      })
      .join(', ')
    lines.push(`Grounding Sources: ${sourceLinks}`)
  }

  if (Array.isArray(queries) && queries.length) {
    const safeQueries = queries.map((q) => escapeHtml(q)).join(', ')
    lines.push(`Search Queries: ${safeQueries}`)
  }

  return lines
}

export function buildMetadataHtml(message) {
  return buildMetadataLines(message, { includeModelDetails: false }).join('\n')
}

export function buildMetadataHtmlForExport(message) {
  return buildMetadataLines(message, { includeModelDetails: false })
    .map((line) => `<div class="metadata-item">${line}</div>`)
    .join('')
}

export function normalizeError(rawError, phase) {
  return sharedNormalizeError(rawError, phase, id)
}

export async function uploadAttachment(file, { onProgress } = {}) {
  const progressHandler =
    typeof onProgress === 'function' ? onProgress : () => {}
  const uploaded = await apiUploadFile(file, progressHandler)
  return {
    uri: uploaded?.uri ?? null,
    expiresAt: uploaded?.expirationTime ?? uploaded?.expiresAt ?? null,
  }
}
