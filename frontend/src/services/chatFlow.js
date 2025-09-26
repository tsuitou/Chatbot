import { v4 as uuidv4 } from 'uuid'

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
    attachments: normalizeAttachments(attachments, 'user'),
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

function hydrateMessage(raw) {
  if (!raw) return null
  const hydrated = {
    ...raw,
    attachments: normalizeAttachments(raw.attachments ?? [], raw.sender),
    configSnapshot: cloneConfigSnapshot(raw.configSnapshot),
    metadata: { ...(raw.metadata ?? {}) },
    uiFlags: { ...(raw.uiFlags ?? {}) },
    runtime: cloneRuntime(raw.runtime),
  }
  const runtimeContent =
    hydrated.runtime.content ||
    (hydrated.runtime.content = {
      isStreaming: hydrated.status === 'streaming',
      hasText: false,
      hasAttachments: false,
      hasMetadata: false,
      isReady: hydrated.status !== 'streaming',
      updatedAt: hydrated.updatedAt ?? hydrated.createdAt ?? null,
    })
  const text = hydrated.content?.text ?? ''
  runtimeContent.hasText = text.trim().length > 0
  runtimeContent.hasAttachments = Array.isArray(hydrated.attachments)
    ? hydrated.attachments.length > 0
    : false
  const metadata = hydrated.metadata ?? {}
  runtimeContent.hasMetadata = Object.keys(metadata).length > 0
  if (runtimeContent.isStreaming === undefined) {
    runtimeContent.isStreaming = hydrated.status === 'streaming'
  }
  if (runtimeContent.isReady === undefined || runtimeContent.isReady === null) {
    runtimeContent.isReady =
      runtimeContent.isStreaming === false &&
      (runtimeContent.hasText ||
        runtimeContent.hasAttachments ||
        runtimeContent.hasMetadata)
  }
  if (!runtimeContent.updatedAt) {
    runtimeContent.updatedAt = hydrated.updatedAt ?? hydrated.createdAt ?? null
  }
  return hydrated
}

function hydrateMessages(list) {
  if (!Array.isArray(list)) return []
  return list
    .map(hydrateMessage)
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
  hydrateMessage,
  hydrateMessages,
  normalizeAttachments,
  prepareRequestMessages,
}
