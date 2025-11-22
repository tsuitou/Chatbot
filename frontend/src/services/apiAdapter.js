import { getDefaultProviderId, getProviderById } from './providers'

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    if (!blob) {
      reject(new Error('No blob provided for base64 conversion.'))
      return
    }
    const reader = new FileReader()
    reader.onloadend = () => {
      if (reader.error) {
        reject(reader.error)
        return
      }
      const result = reader.result
      if (typeof result !== 'string') {
        reject(new Error('Failed to read blob as data URL.'))
        return
      }
      const [, base64String = ''] = result.split(',')
      resolve(base64String)
    }
    reader.onerror = () => {
      reject(reader.error || new Error('Failed to read blob as data URL.'))
    }
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
