import { defineStore } from 'pinia'
import { useChatsStore } from './chats'
import { parseModelResponseSync, findStableBoundary } from '../services/parser'
import {
  buildDisplayIndicators,
  buildMetadataHtml,
} from '../services/messageMetadata'

/**
 * @typedef {import('../types').Message} Message
 * @typedef {import('../types').Attachment} Attachment
 * @typedef {import('../types').Segment} Segment
 */

/**
 * What Message.vue renders for one message.
 * @typedef {object} MessageGroup
 * @property {string} id
 * @property {Message['sender']} sender
 * @property {Message} message
 * @property {{ key: string, messageId: string, status: string, indicators: { icon?: string, text: string }[], thoughtSegments: Segment[], hasThoughts: boolean, isStreamingThoughts: boolean, updatedAt: number | null, isCollapsed: boolean, shouldRender: boolean }} system
 * @property {{ key: string, messageId: string, sender: Message['sender'], status: string, segments: Segment[], attachments: Attachment[], metadataHtml: string, shouldRender?: boolean }} content
 */

const PREVIEWABLE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'text/plain',
  'text/markdown',
  'text/html',
  'text/css',
  'text/javascript',
  'application/json',
])

// Parsing markdown is the expensive step; reuse the result while the text is
// unchanged. Keyed by `${messageId}:content` / `${messageId}:thoughts`.
const segmentCache = new Map()

function segmentsFor(key, text) {
  if (!text) return []
  const cached = segmentCache.get(key)
  if (cached?.text === text) return cached.segments
  const segments = parseModelResponseSync(text)
  segmentCache.set(key, { text, segments })
  return segments
}

// While text streams in, re-parsing all of it on every update costs time
// proportional to its length, so a long answer gets slower and slower. The
// part before the last stable boundary is parsed once and kept; only the
// tail is re-parsed. Completed text gets a normal full parse, so the final
// rendering does not depend on where the boundaries fell.
const streamCache = new Map()

function streamingSegmentsFor(key, text) {
  let entry = streamCache.get(key)
  if (!entry || !text.startsWith(entry.stableText)) {
    entry = { stableText: '', segments: [] }
  }
  const end = findStableBoundary(text, entry.stableText.length)
  if (end > entry.stableText.length) {
    entry = {
      stableText: text.slice(0, end),
      segments: [
        ...entry.segments,
        ...parseModelResponseSync(text.slice(entry.stableText.length, end)),
      ],
    }
  }
  streamCache.set(key, entry)
  return [...entry.segments, ...parseModelResponseSync(text.slice(end))]
}

function renderSegments(key, text, isStreaming) {
  if (isStreaming) return streamingSegmentsFor(key, text)
  streamCache.delete(key)
  return segmentsFor(key, text)
}

// Group objects are reused while their inputs are unchanged, so a Message
// component only re-renders when its own message changed.
const groupCache = new Map()

// Everything buildGroup reads. Stores replace these objects when they change,
// except the primitives, which are compared by value.
function groupInputs(message) {
  const thoughts = message.runtime?.system?.thoughts
  return [
    message,
    message.content,
    message.status,
    message.attachments,
    message.metadata,
    message.configSnapshot,
    message.uiFlags,
    thoughts,
    thoughts?.rawText,
    thoughts?.isStreaming,
    thoughts?.updatedAt,
  ]
}

function sameInputs(a, b) {
  return a.length === b.length && a.every((value, i) => Object.is(value, b[i]))
}

// Thoughts start collapsed; uiFlags only records an expanded state.
function isThoughtCollapsed(message) {
  return message.uiFlags?.thoughtsCollapsed !== false
}

/**
 * @param {Message} message
 * @returns {MessageGroup}
 */
function buildGroup(message) {
  /** @type {Partial<import('../types').MessageRuntime['system']['thoughts']>} */
  const thoughtsState = message.runtime?.system?.thoughts || {}
  const thoughtSegments = renderSegments(
    `${message.id}:thoughts`,
    thoughtsState.rawText ?? '',
    !!thoughtsState.isStreaming
  )
  const system = {
    key: `${message.id}:system`,
    messageId: message.id,
    status: message.status,
    indicators: buildDisplayIndicators(message),
    thoughtSegments,
    hasThoughts: thoughtSegments.length > 0,
    isStreamingThoughts: !!thoughtsState.isStreaming,
    updatedAt: thoughtsState.updatedAt || null,
    isCollapsed: isThoughtCollapsed(message),
    // Only model messages created in this app get the system bubble; older
    // records without the flag keep their previous, plainer look.
    shouldRender:
      message.sender === 'model' && !!message.uiFlags?.systemBubbleActive,
  }

  const content = {
    key: `${message.id}:content`,
    messageId: message.id,
    sender: message.sender,
    status: message.status,
    segments: renderSegments(
      `${message.id}:content`,
      message.content?.text ?? '',
      message.status === 'streaming'
    ),
    attachments: message.attachments || [],
    metadataHtml:
      message.status === 'completed' ? buildMetadataHtml(message) : '',
  }
  content.shouldRender =
    message.sender === 'user' ||
    content.segments.length > 0 ||
    content.attachments.length > 0 ||
    !!content.metadataHtml

  return {
    id: message.id,
    sender: message.sender,
    message,
    system,
    content,
  }
}

function pruneCaches(liveIds) {
  for (const id of groupCache.keys()) {
    if (!liveIds.has(id)) groupCache.delete(id)
  }
  for (const cache of [segmentCache, streamCache]) {
    for (const key of cache.keys()) {
      if (!liveIds.has(key.slice(0, key.lastIndexOf(':')))) {
        cache.delete(key)
      }
    }
  }
}

export const useDisplayStore = defineStore('display', {
  state: () => ({
    /** @type {string | null} */
    previewFileId: null,
  }),

  getters: {
    /** @returns {MessageGroup[]} */
    messageGroups() {
      const messages = useChatsStore().activeMessages
      const liveIds = new Set()
      const groups = messages.map((message) => {
        liveIds.add(message.id)
        const inputs = groupInputs(message)
        const cached = groupCache.get(message.id)
        if (cached && sameInputs(cached.inputs, inputs)) return cached.group
        const group = buildGroup(message)
        groupCache.set(message.id, { inputs, group })
        return group
      })
      pruneCaches(liveIds)
      return groups
    },

    /** @returns {Attachment[]} */
    previewableFiles() {
      const files = []
      const seen = new Set()
      for (const group of this.messageGroups) {
        for (const att of group.content.attachments) {
          if (!PREVIEWABLE_MIMES.has(att.mimeType) || seen.has(att.id)) continue
          seen.add(att.id)
          files.push(att)
        }
      }
      return files
    },

    // Closes by itself when the previewed attachment disappears.
    /** @returns {Attachment | null} */
    activePreviewFile(state) {
      if (!state.previewFileId) return null
      return (
        this.previewableFiles.find((f) => f.id === state.previewFileId) || null
      )
    },
    /** @returns {string | null} */
    activePreviewFileId() {
      return this.activePreviewFile?.id ?? null
    },
    /** @returns {boolean} */
    isPreviewOpen() {
      return !!this.activePreviewFile
    },
  },

  actions: {
    toggleThoughtCollapse(messageId) {
      const message = useChatsStore().findMessageById(messageId)
      if (!message) return
      useChatsStore().updateMessageUiFlags(
        messageId,
        isThoughtCollapsed(message)
          ? { thoughtsCollapsed: false }
          : { thoughtsCollapsed: undefined }
      )
    },

    openPreview(fileId) {
      if (this.previewableFiles.some((f) => f.id === fileId)) {
        this.previewFileId = fileId
      }
    },

    closePreview() {
      this.previewFileId = null
    },

    setActivePreviewFile(fileId) {
      if (this.previewableFiles.some((f) => f.id === fileId)) {
        this.previewFileId = fileId
      }
    },
  },
})
