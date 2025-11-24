import { v4 as uuidv4 } from 'uuid'
import { cloneAttachment } from './attachments'

function createDefaultContentRuntimeState() {
  return {
    isStreaming: false,
    hasText: false,
    hasAttachments: false,
    hasMetadata: false,
    isReady: false,
    updatedAt: null,
  }
}

function ensureContentRuntime(message) {
  if (!message) return createDefaultContentRuntimeState()
  message.runtime = message.runtime || createInitialRuntime()
  if (!message.runtime.content) {
    message.runtime.content = createDefaultContentRuntimeState()
  }
  return message.runtime.content
}

function createInitialRuntime({
  isStreamingContent = false,
  isStreamingThoughts = false,
} = {}) {
  return {
    system: {
      thoughts: {
        rawText: '',
        updatedAt: null,
        isStreaming: isStreamingThoughts,
      },
    },
    content: {
      isStreaming: isStreamingContent,
      hasText: false,
      hasAttachments: false,
      hasMetadata: false,
      isReady: !isStreamingContent,
      updatedAt: null,
    },
  }
}

function cloneRuntime(runtime) {
  const clone = createInitialRuntime()
  if (!runtime) return clone
  const thoughts = runtime.system?.thoughts || {}
  Object.assign(clone.system.thoughts, {
    rawText: thoughts.rawText ?? '',
    updatedAt: thoughts.updatedAt ?? null,
    isStreaming: thoughts.isStreaming ?? false,
  })
  const content = runtime.content || {}
  Object.assign(clone.content, {
    isStreaming: content.isStreaming ?? false,
    hasText: content.hasText ?? false,
    hasAttachments: content.hasAttachments ?? false,
    hasMetadata: content.hasMetadata ?? false,
    isReady: content.isReady ?? !content.isStreaming,
    updatedAt: content.updatedAt ?? null,
  })
  return clone
}

function cloneConfigSnapshot(config) {
  if (!config) return null
  return {
    ...config,
    tools: config?.tools ? { ...config.tools } : undefined,
    parameters: config?.parameters ? { ...config.parameters } : undefined,
    options: config?.options ? { ...config.options } : undefined,
  }
}

function ensureAttachmentBlob(att) {
  if (!att) return null
  const blob = att.blob || att.file || null
  return {
    ...att,
    blob,
  }
}

function normalizeAttachments(attachments, sender) {
  if (!Array.isArray(attachments)) return []
  return attachments.map((att, index) => ({
    ...att,
    id: att.id ?? uuidv4(),
    source: sender,
    order: typeof att.order === 'number' ? att.order : index,
  }))
}

function normalizeAutoAttachments(list, sender) {
  return normalizeAttachments(
    (list || []).map(ensureAttachmentBlob).filter(Boolean),
    sender
  )
}

function coerceAutoSender(role) {
  if (typeof role !== 'string') return 'user'
  const normalized = role.trim().toLowerCase()
  if (['user', 'model', 'system', 'tool'].includes(normalized)) {
    return normalized
  }
  return 'user'
}

function syncContentRuntimeFromMessage(message) {
  const runtimeContent = ensureContentRuntime(message)
  const text = message?.content?.text ?? ''
  runtimeContent.hasText = text.trim().length > 0
  runtimeContent.hasAttachments = Array.isArray(message?.attachments)
    ? message.attachments.length > 0
    : false
  const metadata = message?.metadata ?? {}
  runtimeContent.hasMetadata = Object.keys(metadata).some((key) => {
    const value = metadata[key]
    if (value === null || value === undefined) return false
    if (typeof value === 'string') return value.trim().length > 0
    if (typeof value === 'object') return Object.keys(value).length > 0
    return true
  })
  const referenceTime = message?.updatedAt ?? Date.now()
  runtimeContent.updatedAt = referenceTime
  if (
    runtimeContent.hasText ||
    runtimeContent.hasAttachments ||
    runtimeContent.hasMetadata
  ) {
    runtimeContent.isReady = true
  }
  // Ensure isStreaming reflects message status if not explicitly set
  if (message?.status === 'streaming') {
    runtimeContent.isStreaming = true
  }

  return runtimeContent
}

function setContentStreamingState(message, isStreaming) {
  const runtimeContent = ensureContentRuntime(message)
  runtimeContent.isStreaming = !!isStreaming
  runtimeContent.updatedAt = Date.now()
  return runtimeContent
}

function buildAutoMessageEntries(autoList, { location, userSequence }) {
  if (!Array.isArray(autoList) || !autoList.length) return []
  const createdAt = Date.now()
  const baseSequence =
    location === 'pre' ? userSequence - autoList.length : userSequence + 1
  return autoList.map((item, index) => {
    const sender = coerceAutoSender(item.role)
    return {
      id: item.id || uuidv4(),
      sender,
      sequence: baseSequence + index,
      status: 'completed',
      content: { text: item.text || '' },
      metadata: { autoMessage: true, location },
      configSnapshot: null,
      requestId: null,
      createdAt,
      updatedAt: createdAt,
      attachments: normalizeAutoAttachments(item.attachments, sender),
      uiFlags: {},
      runtime: createInitialRuntime(),
    }
  })
}

function createUserMessage({ sequence, text, attachments, configSnapshot }) {
  const ts = Date.now()
  return {
    id: uuidv4(),
    sender: 'user',
    sequence,
    status: 'completed',
    content: { text },
    metadata: {},
    configSnapshot: cloneConfigSnapshot(configSnapshot),
    requestId: null,
    createdAt: ts,
    updatedAt: ts,
    attachments: attachments || [],
    uiFlags: {},
    runtime: createInitialRuntime(),
  }
}

function createModelMessage({ sequence, requestId, configSnapshot }) {
  const ts = Date.now()
  return {
    id: uuidv4(),
    sender: 'model',
    sequence,
    status: 'streaming',
    content: { text: '' },
    metadata: {},
    configSnapshot: cloneConfigSnapshot(configSnapshot),
    requestId,
    createdAt: ts,
    updatedAt: ts,
    attachments: [],
    uiFlags: {},
    runtime: createInitialRuntime({
      isStreamingContent: true,
      isStreamingThoughts: true,
    }),
  }
}

function prepareMessageForState(raw) {
  if (!raw) return null
  const normalized = {
    ...raw,
    attachments: normalizeAttachments(raw.attachments ?? [], raw.sender).map(
      cloneAttachment
    ),
    configSnapshot: cloneConfigSnapshot(raw.configSnapshot),
    metadata: { ...(raw.metadata ?? {}) },
    uiFlags: { ...(raw.uiFlags ?? {}) },
    runtime: cloneRuntime(raw.runtime),
  }

  // Ensure runtime structure exists
  ensureContentRuntime(normalized)

  // Sync runtime state with message content
  syncContentRuntimeFromMessage(normalized)

  return normalized
}

// Deprecated alias, keeping for backward compat if needed during refactor
const hydrateMessage = prepareMessageForState

function hydrateMessages(list) {
  if (!Array.isArray(list)) return []
  return list
    .map(prepareMessageForState)
    .filter(Boolean)
    .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
}

function prepareRequestMessages({
  historyMessages,
  autoMessages,
  anchorSequence,
}) {
  const preAuto = buildAutoMessageEntries(autoMessages.pre, {
    location: 'pre',
    userSequence: anchorSequence,
  })
  const postAuto = buildAutoMessageEntries(autoMessages.post, {
    location: 'post',
    userSequence: anchorSequence,
  })
  return [...preAuto, ...historyMessages, ...postAuto]
}

export {
  buildAutoMessageEntries,
  cloneConfigSnapshot,
  cloneRuntime,
  createInitialRuntime,
  createModelMessage,
  createUserMessage,
  hydrateMessage, // Deprecated but exported for safety
  prepareMessageForState,
  hydrateMessages,
  normalizeAttachments,
  prepareRequestMessages,
  syncContentRuntimeFromMessage,
  setContentStreamingState,
  ensureContentRuntime,
}
