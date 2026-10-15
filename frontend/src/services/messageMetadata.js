import { escapeHtml, safeAnchorHtml } from './htmlSafety'

function parametersFromConfig(config) {
  if (!config) return {}
  return config.parameters && typeof config.parameters === 'object'
    ? config.parameters
    : {}
}

const PARAMETER_LABELS = {
  temperature: 'Temp',
  topP: 'Top-P',
  topK: 'Top-K',
  maxOutputTokens: 'MaxTokens',
  thinkingBudget: 'Thinking',
  thinkingLevel: 'Thinking Level',
}

const PARAMETER_INDICATORS = {
  temperature: 'thermometer-half',
  topP: 'chart-pie',
  topK: 'sliders-h',
  maxOutputTokens: 'file-alt',
  thinkingBudget: 'cogs',
  thinkingLevel: 'cogs',
}

const TOOL_INDICATORS = {
  urlContext: { icon: 'link', text: 'URL Context' },
  grounding: { icon: 'search', text: 'Search Grounding' },
  codeExecution: { icon: 'code', text: 'Code Execution' },
}

export function buildDisplayIndicators(message) {
  const indicators = []
  const config = message?.configSnapshot || {}
  const params = parametersFromConfig(config)

  if (config.model) indicators.push({ icon: 'robot', text: config.model })
  for (const [key, value] of Object.entries(params)) {
    if (key === 'includeThoughts') continue
    const label = PARAMETER_LABELS[key]
    if (label === undefined || value === undefined) continue
    indicators.push({
      icon: PARAMETER_INDICATORS[key] || 'sliders-h',
      text: `${label}: ${value}`,
    })
  }
  if (params.includeThoughts) {
    indicators.push({ icon: 'check', text: 'Include Thoughts' })
  }
  if (params.writingFunctionCall === true) {
    indicators.push({ icon: 'pen-nib', text: 'Writing FC' })
  }
  for (const [key, value] of Object.entries(config.tools || {})) {
    if (!value || !TOOL_INDICATORS[key]) continue
    indicators.push(TOOL_INDICATORS[key])
  }
  return indicators
}

function buildParameterParts(params) {
  return Object.entries(params)
    .map(([key, value]) => {
      const label = PARAMETER_LABELS[key]
      if (label === undefined || value === undefined) return null
      return `${label}: ${escapeHtml(value)}`
    })
    .filter(Boolean)
}

export function buildMetadataLines(
  message,
  { includeModelDetails = true } = {}
) {
  const config = message?.configSnapshot || {}
  const metadata = message?.metadata || {}
  const params = parametersFromConfig(config)
  const lines = []
  const parameterParts = buildParameterParts(params)

  const modelLabel = config.model ? escapeHtml(config.model) : ''
  if (includeModelDetails && modelLabel) {
    lines.push(
      parameterParts.length
        ? `${modelLabel} [ ${parameterParts.join(', ')} ]`
        : modelLabel
    )
  } else if (includeModelDetails && parameterParts.length) {
    lines.push(`Parameters [ ${parameterParts.join(', ')} ]`)
  }

  const usage = metadata.usage || {}
  const usageParts = []
  if (usage.prompt != null)
    usageParts.push(`Prompt: ${escapeHtml(usage.prompt)}`)
  if (usage.uncachedInput != null)
    usageParts.push(`Uncached: ${escapeHtml(usage.uncachedInput)}`)
  if (usage.cacheRead != null)
    usageParts.push(`Cache Read: ${escapeHtml(usage.cacheRead)}`)
  if (usage.cacheWrite != null)
    usageParts.push(`Cache Write: ${escapeHtml(usage.cacheWrite)}`)
  if (usage.output != null)
    usageParts.push(`Output: ${escapeHtml(usage.output)}`)
  if (usage.reasoning != null)
    usageParts.push(`Reasoning: ${escapeHtml(usage.reasoning)}`)
  if (usage.total != null) usageParts.push(`Total: ${escapeHtml(usage.total)}`)

  const detailSegments = []
  if (params.serviceTier === 'flex' || metadata.serviceTier === 'flex') {
    const tierLabels = {
      flex: 'Flex',
      standard: 'Standard',
      priority: 'Priority',
    }
    detailSegments.push(
      `Tier: ${tierLabels[metadata.serviceTier] || 'Unknown'}`
    )
  }
  const writingLabels = {
    used: 'Used',
    not_used: 'Not used',
    invalid: 'Invalid',
    incomplete: 'Incomplete',
  }
  const writingStatus =
    writingLabels[metadata.writingFunctionCall] ||
    (metadata.writingFunctionCall === 'pending' &&
    message.status === 'cancelled'
      ? 'Incomplete'
      : null)
  if (writingStatus) detailSegments.push(`Writing FC: ${writingStatus}`)
  if (usageParts.length)
    detailSegments.push(`Tokens [ ${usageParts.join(', ')} ]`)
  if (metadata.finishReason) {
    detailSegments.push(`Finish [ ${escapeHtml(metadata.finishReason)} ]`)
  }
  if (
    Array.isArray(metadata.thoughtSignatures) &&
    metadata.thoughtSignatures.length
  ) {
    detailSegments.push(
      `Thought Signatures [ ${metadata.thoughtSignatures.length} ]`
    )
  }
  if (detailSegments.length) lines.push(detailSegments.join(', '))

  const grounding = metadata.grounding || {}
  const sources = Array.isArray(grounding.sources) ? grounding.sources : []
  if (sources.length) {
    lines.push(
      `Grounding Sources: ${sources
        .map((src) =>
          safeAnchorHtml(
            src.uri,
            src.title || src.uri,
            'target="_blank" rel="noopener noreferrer"'
          )
        )
        .join(', ')}`
    )
  }
  const queries = grounding.webSearchQueries || []
  if (Array.isArray(queries) && queries.length) {
    lines.push(
      `Search Queries: ${queries.map((q) => escapeHtml(q)).join(', ')}`
    )
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
