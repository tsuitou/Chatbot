import { getDefaultProviderId, getProviderById } from './providers'
import { normalizeError as fallbackNormalizeError } from './providers/utils'

// --- Public API ---

export async function createApiRequest({
  chatId,
  messages = [],
  model,
  requestConfig = {},
  streaming = true,
  requestId,
}) {
  if (!model) {
    throw new Error('Model name is required to create an API request')
  }

  const providerId = requestConfig.providerId || getDefaultProviderId()
  const provider = getProviderById(providerId)

  const sorted = [...messages].sort(
    (a, b) => (a.sequence ?? 0) - (b.sequence ?? 0)
  )
  if (typeof provider.buildPayload !== 'function') {
    throw new Error(`Provider "${providerId}" does not support payload builds`)
  }

  const payload = await provider.buildPayload({
    chatId,
    requestId,
    model,
    streaming,
    requestConfig: {
      ...requestConfig,
      providerId,
    },
    messages: sorted,
  })

  if (!payload) {
    throw new Error(
      `Provider "${providerId}" failed to build a request payload`
    )
  }

  return payload
}

export function parseApiResponse(rawChunk, providerId) {
  const provider = getProviderById(providerId)
  if (provider.parseStreamChunk) {
    return provider.parseStreamChunk(rawChunk)
  }
  return {}
}

export function normalizeError(rawError, phase, providerId) {
  const provider = getProviderById(providerId)
  if (provider?.normalizeError) {
    return provider.normalizeError(rawError, phase)
  }
  return fallbackNormalizeError(rawError, phase, providerId)
}
