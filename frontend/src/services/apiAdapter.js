import { getDefaultProviderId, getProviderById } from './providers'

// --- Helpers ---

/**
 * Convert a Blob into a Base64 string asynchronously.
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => {
      const base64String = reader.result.split(',')[1]
      resolve(base64String)
    }
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
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
      }
    }
  }

  if (parts.length === 0) {
    parts.push({ text: '' })
  }

  return parts
}

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
  const contents = []
  for (const message of sorted) {
    if (!message?.sender) continue
    if (
      !['user', 'model', 'system', 'tool'].includes(
        String(message.sender).toLowerCase()
      )
    ) {
      continue
    }
    const role = String(message.sender).toLowerCase()
    const parts = await buildMessageParts(message)
    contents.push({ role, parts })
  }

  const payload = provider.createRequestPayload({
    chatId,
    requestId,
    model,
    contents,
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
  if (provider.normalizeError) {
    return provider.normalizeError(rawError, phase)
  }

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
  }
}
