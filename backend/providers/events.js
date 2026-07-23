import { normalizeGeminiUsage } from './shared.js'

export function normalizeUsage(u) {
  if (!u) return null
  const input = u.inputTokens ?? u.input_tokens ?? null
  const uncachedInput = u.uncachedInputTokens ?? null
  const cacheRead = u.cacheReadTokens ?? null
  const cacheWrite = u.cacheWriteTokens ?? null
  const output = u.outputTokens ?? u.output_tokens ?? null
  const reasoning = u.reasoningTokens ?? u.thoughtsTokenCount ?? null
  const total =
    u.totalTokens ??
    u.totalTokenCount ??
    (input != null && output != null ? input + output : null)
  return {
    prompt: input,
    uncachedInput,
    cacheRead,
    cacheWrite,
    output,
    reasoning,
    total,
    raw: u,
  }
}

function normalizeGrounding(grounding) {
  if (!grounding) return null
  const sources = []
  if (Array.isArray(grounding.groundingChunks)) {
    for (const chunk of grounding.groundingChunks) {
      const uri = chunk.web?.uri
      const title = chunk.web?.title
      if (uri && title) sources.push({ uri, title })
    }
  } else if (Array.isArray(grounding.sources)) {
    for (const src of grounding.sources) {
      const uri = src?.uri
      const title = src?.title
      if (uri && title) sources.push({ uri, title })
    }
  }
  return {
    sources,
    webSearchQueries: grounding.webSearchQueries ?? [],
    raw: grounding,
  }
}

export function eventFromParts({
  chatId,
  requestId,
  provider,
  parts = [],
  usage = null,
  finishReason = null,
  grounding = null,
  metadata = null,
}) {
  const event = {
    chatId,
    requestId,
    provider,
  }
  const nextMetadata = { ...(metadata || {}), provider }
  let deltaText = ''
  let thoughtDelta = ''
  const attachments = []
  const thoughtSignatures = []
  const seenSignatures = new Set()
  let inThinkingContext = true

  for (let idx = 0; idx < (parts || []).length; idx++) {
    const part = parts[idx]
    if (part?.text) {
      if (part.thought) {
        thoughtDelta += part.text
      } else {
        deltaText += part.text
        inThinkingContext = false
      }
    }
    if (part?.executableCode) {
      const { language, code } = part.executableCode
      const formatted = `\n\n\`\`\`${language}\n${code}\n\`\`\`\n`
      if (inThinkingContext) thoughtDelta += formatted
      else deltaText += formatted
    }
    if (part?.codeExecutionResult) {
      const output = part.codeExecutionResult.output ?? ''
      const formatted = `\n\n\`\`\`bash\n${output}\n\`\`\`\n`
      if (inThinkingContext) thoughtDelta += formatted
      else deltaText += formatted
    }
    if (part?.inlineData) {
      const { mimeType, data } = part.inlineData
      attachments.push({
        name: `generated_${Date.now()}_${idx}`,
        mimeType,
        data,
      })
    }
    if (part?.thoughtSignature) {
      const signature = String(part.thoughtSignature)
      const key = `${idx}:${signature}`
      if (!seenSignatures.has(key)) {
        seenSignatures.add(key)
        thoughtSignatures.push({ signature, partIndex: idx })
      }
    }
  }

  if (deltaText) event.deltaText = deltaText
  if (thoughtDelta) event.thoughtDelta = thoughtDelta
  if (attachments.length) event.attachments = attachments
  if (thoughtSignatures.length) nextMetadata.thoughtSignatures = thoughtSignatures
  if (finishReason) {
    event.finishReason = finishReason
    nextMetadata.finishReason = finishReason
  }
  const normalizedUsage = normalizeUsage(usage)
  if (normalizedUsage) nextMetadata.usage = normalizedUsage
  const normalizedGrounding = normalizeGrounding(grounding)
  if (normalizedGrounding) nextMetadata.grounding = normalizedGrounding
  if (Object.keys(nextMetadata).length > 1) event.metadata = nextMetadata

  return event
}

export function geminiEvent({ chatId, requestId, chunk, provider = 'gemini' }) {
  return eventFromParts({
    chatId,
    requestId,
    provider,
    parts: chunk?.candidates?.[0]?.content?.parts,
    usage: normalizeGeminiUsage(chunk?.usageMetadata),
    finishReason: chunk?.candidates?.[0]?.finishReason,
    grounding: chunk?.candidates?.[0]?.groundingMetadata,
  })
}

export function textEvent({ chatId, requestId, provider, text, thought = false, metadata }) {
  return eventFromParts({
    chatId,
    requestId,
    provider,
    parts: text ? [{ text, thought }] : [],
    metadata,
  })
}
