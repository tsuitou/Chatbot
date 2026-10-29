import { v4 as uuidv4 } from 'uuid'
import { cloneAttachment } from './attachments'

/**
 * @typedef {import('../types').Message} Message
 * @typedef {import('../types').Attachment} Attachment
 * @typedef {import('../types').RequestConfig} RequestConfig
 * @typedef {import('../types').GenerationPlan} GenerationPlan
 */

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
  const { systemInstruction, ...snapshot } = config
  void systemInstruction
  return {
    ...snapshot,
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

/** @type {import('../types').Sender[]} */
const SENDERS = ['user', 'model', 'system', 'tool']

/** @returns {import('../types').Sender} */
function coerceAutoSender(role) {
  if (typeof role !== 'string') return 'user'
  const normalized = role.trim().toLowerCase()
  return SENDERS.find((sender) => sender === normalized) || 'user'
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

/**
 * Auto messages as history entries placed around the anchor sequence.
 * @param {import('../types').AutoMessage[]} autoList
 * @param {{ location: 'pre' | 'post', userSequence: number }} placement
 * @returns {Message[]}
 */
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

/**
 * @param {{ sequence: number, text: string, attachments?: Attachment[], configSnapshot?: RequestConfig }} args
 * @returns {Message}
 */
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

/**
 * An empty model message that a stream will fill.
 * @param {{ sequence: number, requestId: string, configSnapshot?: RequestConfig }} args
 * @returns {Message}
 */
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
    // Shows the status/thoughts bubble for responses created in this app; saved
    // with the message so it survives reloads.
    uiFlags: { systemBubbleActive: true },
    runtime: createInitialRuntime({
      isStreamingContent: true,
      isStreamingThoughts: true,
    }),
  }
}

/**
 * A normalized copy safe to keep in the store.
 * @param {Message | null | undefined} raw
 * @returns {Message | null}
 */
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

/**
 * @param {Message[]} list
 * @returns {Message[]}
 */
function hydrateMessages(list) {
  if (!Array.isArray(list)) return []
  return list
    .map(prepareMessageForState)
    .filter(Boolean)
    .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
}

/** @param {Message} message */
function isInvalidModelHistoryMessage(message) {
  return (
    message?.sender === 'model' &&
    ['pending', 'streaming', 'cancelled'].includes(message.status)
  )
}

/**
 * History plus auto messages, in send order.
 * @param {{ historyMessages: Message[], autoMessages: { pre: import('../types').AutoMessage[], post: import('../types').AutoMessage[] }, anchorSequence: number }} args
 * @returns {Message[]}
 */
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
  // Interrupted model messages carry no persisted usable content, so keep them
  // out of the request history sent to the provider.
  const history = (historyMessages || []).filter(
    (message) =>
      !isInvalidModelHistoryMessage(message) &&
      !(
        message.sender === 'model' &&
        message.metadata?.writingFunctionCall &&
        message.metadata.writingFunctionCall !== 'used'
      )
  )
  return [...preAuto, ...history, ...postAuto]
}

// Sequences are spaced by 10 so auto messages can be slotted in between.
const SEQUENCE_STEP = 10

/**
 * @param {Message[]} messages
 * @returns {Message[]}
 */
function sortBySequence(messages) {
  return [...(messages || [])].sort(
    (a, b) => (a.sequence ?? 0) - (b.sequence ?? 0)
  )
}

/** @param {Pick<Message, 'sequence'>[]} messages */
function nextSequence(messages) {
  if (!messages?.length) return SEQUENCE_STEP
  return Math.max(...messages.map((m) => m.sequence ?? 0)) + SEQUENCE_STEP
}

// A new prompt goes after everything in the chat and its response right after.
/**
 * @param {Message[]} messages
 * @returns {GenerationPlan & { userSequence: number }}
 */
function planSend(messages) {
  const userSequence = nextSequence(messages)
  return {
    userSequence,
    anchorSequence: userSequence,
    responseSequence: userSequence + SEQUENCE_STEP,
  }
}

// Rerunning a model message replaces it (and everything after); rerunning a
// user message keeps it and replaces everything after it.
/**
 * @param {Message[]} messages
 * @param {string} targetId
 * @returns {(GenerationPlan & { pruneIds: string[], historyMessages: Message[] }) | null}
 */
function planResend(messages, targetId) {
  const sorted = sortBySequence(messages)
  const index = sorted.findIndex((m) => m.id === targetId)
  if (index === -1) return null
  const target = sorted[index]
  const replacesTarget = target.sender === 'model'
  const cut = replacesTarget ? index : index + 1
  const historyMessages = sorted.slice(0, cut)
  const targetSequence = target.sequence ?? 0

  const anchor = [...historyMessages]
    .reverse()
    .find((msg) => msg.sender === 'user')
  let anchorSequence = targetSequence
  if (anchor) {
    anchorSequence = anchor.sequence ?? 0
  } else if (historyMessages.length) {
    anchorSequence = historyMessages.at(-1).sequence ?? targetSequence
  }

  return {
    pruneIds: sorted.slice(cut).map((m) => m.id),
    historyMessages,
    anchorSequence,
    responseSequence: replacesTarget
      ? targetSequence
      : nextSequence(historyMessages),
  }
}

export {
  buildAutoMessageEntries,
  cloneConfigSnapshot,
  cloneRuntime,
  createInitialRuntime,
  createModelMessage,
  createUserMessage,
  isInvalidModelHistoryMessage,
  nextSequence,
  planResend,
  planSend,
  prepareMessageForState,
  hydrateMessages,
  normalizeAttachments,
  prepareRequestMessages,
  syncContentRuntimeFromMessage,
  setContentStreamingState,
  sortBySequence,
  ensureContentRuntime,
}
