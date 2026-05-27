import { getDefaultProviderId, getProviderById } from './providers'
import {
  base64ToBlob,
  blobToBase64,
  normalizeError as defaultNormalizeError,
} from './providers/utils'
import { v4 as uuidv4 } from 'uuid'

// --- Public API ---

async function buildCanonicalParts(message) {
  const parts = []
  const text = message?.content?.text ?? ''
  if (text) {
    parts.push({ type: 'text', text })
  }

  for (const att of message?.attachments || []) {
    if (att.remoteUri) {
      parts.push({
        type: 'file',
        mimeType: att.mimeType,
        name: att.name,
        remoteUri: att.remoteUri,
      })
    } else if (att.blob) {
      parts.push({
        type: 'file',
        mimeType: att.mimeType,
        name: att.name,
        data: await blobToBase64(att.blob),
      })
    } else {
      throw new Error(
        `Attachment "${att?.name || att?.id || '(unknown)'}" has no usable data.`
      )
    }
  }

  const thoughtSignatures = Array.isArray(message?.metadata?.thoughtSignatures)
    ? message.metadata.thoughtSignatures
    : []
  for (const entry of thoughtSignatures) {
    const signature = entry?.signature ?? entry
    if (!signature) continue
    parts.push({
      type: 'thoughtSignature',
      signature,
      partIndex: typeof entry?.partIndex === 'number' ? entry.partIndex : 0,
    })
  }

  if (!parts.length) {
    parts.push({ type: 'text', text: '' })
  }
  return parts
}

async function buildCanonicalMessages(messages) {
  const result = []
  for (const message of messages) {
    if (!message?.sender) continue
    const role = String(message.sender).toLowerCase()
    if (!['user', 'model', 'system', 'tool'].includes(role)) continue
    result.push({
      role,
      parts: await buildCanonicalParts(message),
    })
  }
  return result
}

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

  const sorted = [...messages].sort(
    (a, b) => (a.sequence ?? 0) - (b.sequence ?? 0)
  )

  return {
    provider: providerId,
    chatId,
    requestId,
    model,
    messages: await buildCanonicalMessages(sorted),
    parameters: { ...(requestConfig.parameters || {}) },
    options: { ...(requestConfig.options || {}) },
    tools: { ...(requestConfig.tools || {}) },
    systemInstruction: requestConfig.systemInstruction || '',
    streaming,
  }
}

export function parseApiResponse(rawChunk) {
  const result = {
    deltaText: rawChunk?.deltaText ?? '',
    thoughtDelta: rawChunk?.thoughtDelta ?? '',
  }
  if (rawChunk?.finishReason) {
    result.finishReason = rawChunk.finishReason
  }
  if (rawChunk?.metadata) {
    result.metadata = rawChunk.metadata
  }
  if (Array.isArray(rawChunk?.attachments) && rawChunk.attachments.length) {
    result.newAttachments = rawChunk.attachments.map((att) => {
      const blob = base64ToBlob(att.data, att.mimeType)
      return {
        id: uuidv4(),
        name: att.name || `generated_${Date.now()}`,
        mimeType: att.mimeType,
        size: blob.size,
        source: 'model',
        blob,
      }
    })
  }
  return result
}

export function normalizeError(rawError, phase, providerId) {
  const provider = getProviderById(providerId)
  if (provider?.normalizeError) {
    return provider.normalizeError(rawError, phase)
  }
  return defaultNormalizeError(rawError, phase, providerId)
}
