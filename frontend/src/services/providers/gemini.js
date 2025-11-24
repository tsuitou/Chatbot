import { v4 as uuidv4 } from 'uuid'
import { uploadFile as apiUploadFile } from '../api'

export const id = 'gemini'
export const label = 'Google Gemini'

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

function appendIfDefined(target, key, value) {
  if (value === undefined || value === null || value === '') return
  target[key] = value
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function createRequestPayload({
  chatId,
  requestId,
  model,
  streaming,
  contents,
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

function base64ToBlob(base64, mimeType) {
  const byteCharacters = atob(base64)
  const byteNumbers = new Array(byteCharacters.length)
  for (let i = 0; i < byteCharacters.length; i++) {
    byteNumbers[i] = byteCharacters.charCodeAt(i)
  }
  const byteArray = new Uint8Array(byteNumbers)
  return new Blob([byteArray], { type: mimeType })
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

  if (rawChunk.usage) {
    const usage = rawChunk.usage
    metadata.usage = {
      prompt: usage.promptTokenCount ?? null,
      reasoning: usage.thoughtsTokenCount ?? null,
      output: usage.candidatesTokenCount ?? null,
      total: usage.totalTokenCount ?? null,
      raw: usage,
    }
  }

  if (rawChunk.grounding) {
    const grounding = rawChunk.grounding
    const sources = []
    if (Array.isArray(grounding.groundingChunks)) {
      for (const chunk of grounding.groundingChunks) {
        const uri = chunk.web?.uri
        const title = chunk.web?.title
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

function parametersFromConfig(config) {
  if (!config) return {}
  return config.parameters && typeof config.parameters === 'object'
    ? config.parameters
    : {}
}

function optionsFromConfig(config) {
  if (!config) return {}
  return config.options && typeof config.options === 'object'
    ? config.options
    : {}
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
    parameterParts.push(`Temp: ${params.temperature}`)
  if (params.topP !== undefined) parameterParts.push(`Top-P: ${params.topP}`)
  if (params.maxOutputTokens !== undefined)
    parameterParts.push(`MaxTokens: ${params.maxOutputTokens}`)
  if (params.thinkingBudget !== undefined)
    parameterParts.push(`Thinking: ${params.thinkingBudget}`)
  if (params.thinkingLevel !== undefined)
    parameterParts.push(`Thinking Level: ${params.thinkingLevel}`)

  const modelLabel = config.model ? config.model : ''
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
  if (prompt != null) usageParts.push(`Prompt: ${prompt}`)
  if (output != null) usageParts.push(`Output: ${output}`)
  if (reasoning != null) usageParts.push(`Reasoning: ${reasoning}`)
  if (total != null) usageParts.push(`Total: ${total}`)

  const detailSegments = []
  if (usageParts.length) {
    detailSegments.push(`Tokens [ ${usageParts.join(', ')} ]`)
  }
  if (finishReason) {
    detailSegments.push(`Finish [ ${finishReason} ]`)
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
  const groundingSegments = []

  if (sources.length) {
    const sourceLinks = sources
      .map((src) => {
        const safeUri = escapeHtml(src.uri)
        const safeTitle = escapeHtml(src.title)
        return `<a href="${safeUri}" target="_blank">${safeTitle}</a>`
      })
      .join(', ')
    groundingSegments.push(`Grounding Sources [ ${sourceLinks} ]`)
  }

  if (Array.isArray(queries) && queries.length) {
    groundingSegments.push(`Search Queries [ ${queries.join(', ')} ]`)
  }

  if (groundingSegments.length) {
    lines.push(groundingSegments.join(', '))
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
  const status = rawError?.status || 500
  let code = 'E_UNKNOWN'
  if (status === 400) code = 'E_BAD_REQUEST'
  if (status === 401) code = 'E_UNAUTHORIZED'
  if (status === 403) code = 'E_FORBIDDEN'
  if (status === 429) code = 'E_RATE_LIMIT'
  if (status >= 500) code = 'E_BACKEND'

  return {
    code,
    message:
      rawError?.message || rawError?.error || 'An unknown error occurred.',
    status,
    phase,
    retryable: status >= 500,
    provider: id,
  }
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
