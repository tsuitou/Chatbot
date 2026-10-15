export const FLEX_TIMEOUT_MS = 15 * 60 * 1000

export function generationOptions(parameters, definitions) {
  const serviceTier =
    parameters?.serviceTier ?? definitions?.serviceTier?.default
  const writing =
    parameters?.writingFunctionCall ??
    definitions?.writingFunctionCall?.default ??
    false
  if (serviceTier != null && !['standard', 'flex'].includes(serviceTier)) {
    throw new Error('Service Tier must be Standard or Flex.')
  }
  if (typeof writing !== 'boolean') {
    throw new Error('Writing Function Call must be enabled or disabled.')
  }
  if (serviceTier === 'flex' && !definitions?.serviceTier) {
    throw new Error('Flex is not supported for this model.')
  }
  if (writing && !definitions?.writingFunctionCall) {
    throw new Error('Writing Function Call is not supported for this model.')
  }
  return {
    serviceTier: definitions?.serviceTier ? serviceTier : undefined,
    writing,
  }
}

export function tierMetadata(value) {
  if (typeof value !== 'string') return {}
  const tier = value.toLowerCase()
  if (tier === 'default') return { serviceTier: 'standard' }
  return ['standard', 'flex', 'priority'].includes(tier)
    ? { serviceTier: tier }
    : {}
}
