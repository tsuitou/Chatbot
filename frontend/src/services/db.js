/** ---------- Data Entity Definitions ----------

Message {
  id: string,
  type: 'message',
  chatId: string,
  sender: 'user' | 'model',
  sequence: number,             // ordering key (10, 20, 30, ...)
  status: 'pending' | 'streaming' | 'completed' | 'error' | 'cancelled',
  content: {
    text: string,
  },
  metadata: Record<string, any>,
  configSnapshot?: Record<string, any>,
  requestId?: string,
  createdAt: number,
  updatedAt: number,
  attachments?: Array<Attachment>, // hydrated on read only
}

Attachment {
  id: string,
  type: 'attachment',
  chatId: string,
  messageId: string,
  name: string,
  mimeType: string,
  size: number,
  source: 'user' | 'model',
  remoteUri?: string,
  blob?: Blob,
  order: number,
}

Chat {
  id: string,
  type: 'chat',
  title: string,
  createdAt: number,
  lastModified: number,
  isBookmarked?: boolean,
  messages?: Array<Message>,
}

-------------------------------------------------------------------------------- **/

import { openDB } from 'idb'
import { v4 as uuidv4 } from 'uuid'
import JSZip from 'jszip'

const DB_NAME = 'GeminiChatDB'
const DB_VERSION = 8
const STORE_NAME = 'app_store'

const TYPE_CHAT = 'chat'
const TYPE_MESSAGE = 'message'
const TYPE_ATTACHMENT = 'attachment'
const TYPE_AUTO_MESSAGE = 'auto_message'

const IDX_BY_TYPE = 'byType'
const IDX_MESSAGE_BY_CHAT = 'messageByChat'
const IDX_MESSAGE_BY_CHAT_SEQUENCE = 'messageByChatSequence'
const IDX_ATTACHMENT_BY_MESSAGE = 'attachmentByMessage'
const IDX_ATTACHMENT_BY_CHAT = 'attachmentByChat'
const IDX_AUTO_MESSAGE_BY_CHAT_LOCATION = 'autoMessageByChatLocation'

const AUTO_MESSAGE_LOCATIONS = new Set(['pre', 'post'])
const DEFAULT_AUTO_ROLE = 'user'

const now = () => Date.now()

function cloneBlobCompatible(blob) {
  if (typeof Blob !== 'undefined' && blob instanceof Blob) {
    return blob.slice(0, blob.size, blob.type)
  }
  return blob
}

function cloneFileCompatible(file) {
  const hasFile = typeof File !== 'undefined'
  if (hasFile && file instanceof File) {
    return new File([file], file.name, {
      type: file.type,
      lastModified: file.lastModified,
    })
  }
  return file
}

function manualDeepClone(value) {
  if (value === null || typeof value !== 'object') {
    return value
  }

  const clonedFile = cloneFileCompatible(value)
  if (clonedFile !== value) {
    return clonedFile
  }

  const clonedBlob = cloneBlobCompatible(value)
  if (clonedBlob !== value) {
    return clonedBlob
  }

  if (value instanceof Date) {
    return new Date(value.getTime())
  }

  if (Array.isArray(value)) {
    return value.map((item) => manualDeepClone(item))
  }

  const result = {}
  for (const [key, val] of Object.entries(value)) {
    result[key] = manualDeepClone(val)
  }
  return result
}

let structuredCloneWarningShown = false

function shouldBypassStructuredClone(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') {
    return false
  }

  if (
    (typeof Blob !== 'undefined' && value instanceof Blob) ||
    (typeof File !== 'undefined' && value instanceof File)
  ) {
    return true
  }

  if (seen.has(value)) {
    return false
  }
  seen.add(value)

  if (Array.isArray(value)) {
    return value.some((item) => shouldBypassStructuredClone(item, seen))
  }

  const prototype = Object.getPrototypeOf(value)
  const isPlainObject = prototype === Object.prototype || prototype === null
  if (!isPlainObject) {
    return true
  }

  // Check for Vue reactive objects (Proxy)
  if (
    value.toString().includes('[object Object]') &&
    Object.getOwnPropertyNames(value).length > 0 &&
    typeof value.__v_isRef === 'undefined' &&
    Object.getOwnPropertyDescriptor(value, Object.getOwnPropertyNames(value)[0])
      ?.get
  ) {
    return true
  }

  for (const [, nested] of Object.entries(value)) {
    if (shouldBypassStructuredClone(nested, seen)) {
      return true
    }
  }
  return false
}

const deepClone = (input) => {
  if (shouldBypassStructuredClone(input)) {
    return manualDeepClone(input)
  }

  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(input)
    } catch {
      if (!structuredCloneWarningShown) {
        structuredCloneWarningShown = true
        console.warn('structuredClone failed, falling back to manual clone.')
      }
    }
  }
  return manualDeepClone(input)
}

function buildChatAttachmentRange(chatId) {
  return IDBKeyRange.bound([chatId, ''], [chatId, '\uffff'])
}

function buildAutoMessageRange(chatId) {
  return IDBKeyRange.bound(
    [chatId, '', -Infinity],
    [chatId, '\uffff', Infinity]
  )
}

function cloneAttachmentForChat(original, chatId, messageId) {
  const base = deepClone(original) || {}

  const next = {
    ...base,
    id: uuidv4(),
    type: TYPE_ATTACHMENT,
    chatId,
    messageId,
    name: base.name ?? 'attachment',
    mimeType: base.mimeType ?? 'application/octet-stream',
    size: base.size ?? base.blob?.size ?? 0,
    source: base.source ?? 'user',
    order: typeof base.order === 'number' ? base.order : 0,
    remoteUri: base.remoteUri ?? null,
    uploadProgress: base.uploadProgress ?? 100,
    error: base.error ?? null,
    expirationTime: base.expirationTime ?? null,
  }

  next.blob = base.blob ?? null
  if (!next.blob) {
    delete next.blob
  }

  if (base.file) {
    next.file = base.file
  } else if ('file' in next) {
    delete next.file
  }

  return next
}

const dbPromise = openDB(DB_NAME, DB_VERSION, {
  upgrade(db) {
    if (db.objectStoreNames.contains(STORE_NAME)) {
      db.deleteObjectStore(STORE_NAME)
    }
    const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' })
    store.createIndex(IDX_BY_TYPE, 'type', { unique: false })
    store.createIndex(IDX_MESSAGE_BY_CHAT, 'chatId', { unique: false })
    store.createIndex(IDX_MESSAGE_BY_CHAT_SEQUENCE, ['chatId', 'sequence'], {
      unique: false,
    })
    store.createIndex(IDX_ATTACHMENT_BY_MESSAGE, ['messageId', 'order'], {
      unique: false,
    })
    store.createIndex(IDX_ATTACHMENT_BY_CHAT, ['chatId', 'messageId'], {
      unique: false,
    })
    store.createIndex(
      IDX_AUTO_MESSAGE_BY_CHAT_LOCATION,
      ['chatId', 'location', 'position'],
      { unique: false }
    )
  },
})

function ensureContent(raw) {
  if (!raw || typeof raw !== 'object') return { text: '' }
  return { text: raw.text ?? '' }
}

function normalizeMessage(chatId, input) {
  if (!input?.sender) {
    throw new Error('Message sender is required')
  }
  const createdAt = input.createdAt ?? now()
  return {
    id: input.id ?? uuidv4(),
    type: TYPE_MESSAGE,
    chatId,
    sender: input.sender,
    sequence: typeof input.sequence === 'number' ? input.sequence : 0,
    status: input.status ?? 'pending',
    content: ensureContent(input.content),
    metadata: deepClone(input.metadata ?? {}),
    configSnapshot: input.configSnapshot
      ? deepClone(input.configSnapshot)
      : null,
    requestId: input.requestId ?? null,
    createdAt,
    updatedAt: input.updatedAt ?? createdAt,
  }
}

function buildAttachmentRecord(
  chatId,
  messageId,
  attachment,
  index,
  fallbackSource
) {
  const base = attachment ?? {}
  const source = base.source ?? fallbackSource
  if (!source) {
    throw new Error('Attachment source must be specified')
  }
  return {
    ...base,
    id: base.id ?? uuidv4(),
    type: TYPE_ATTACHMENT,
    chatId,
    messageId,
    order: typeof base.order === 'number' ? base.order : index,
    source,
  }
}

async function deleteAttachmentsForMessage(store, messageId) {
  const range = IDBKeyRange.bound([messageId, -Infinity], [messageId, Infinity])
  const attachments = await store.index(IDX_ATTACHMENT_BY_MESSAGE).getAll(range)
  for (const att of attachments || []) {
    await store.delete(att.id)
  }
}

async function replaceAttachments(
  store,
  chatId,
  messageId,
  attachments,
  fallbackSource
) {
  const range = IDBKeyRange.bound([messageId, -Infinity], [messageId, Infinity])
  const existing = await store.index(IDX_ATTACHMENT_BY_MESSAGE).getAll(range)
  const existingById = new Map((existing || []).map((a) => [a.id, a]))
  const nextList = Array.isArray(attachments) ? attachments : []

  for (let i = 0; i < nextList.length; i++) {
    const raw = nextList[i]
    const record = buildAttachmentRecord(
      chatId,
      messageId,
      raw,
      i,
      fallbackSource
    )
    const prev = existingById.get(record.id)
    if (!prev) {
      await store.put(record)
    } else {
      const restPrev = { ...prev }
      delete restPrev.id
      const restNext = { ...record }
      delete restNext.id
      if (JSON.stringify(restPrev) !== JSON.stringify(restNext)) {
        await store.put({ ...prev, ...record })
      }
    }
    existingById.delete(record.id)
  }

  for (const id of existingById.keys()) {
    await store.delete(id)
  }
}

function buildAttachmentLookup(rawAttachments) {
  const map = new Map()
  for (const attachment of rawAttachments || []) {
    if (!attachment?.messageId) continue
    if (attachment.type !== TYPE_ATTACHMENT) continue
    const bucket = map.get(attachment.messageId)
    if (bucket) {
      bucket.push(attachment)
    } else {
      map.set(attachment.messageId, [attachment])
    }
  }
  for (const bucket of map.values()) {
    bucket.sort((a, b) => (a?.order ?? 0) - (b?.order ?? 0))
  }
  return map
}

function withAttachments(record, attachmentLookup) {
  const attachments = attachmentLookup.get(record.id) || []
  return {
    ...record,
    attachments: attachments.slice(),
  }
}

function hydrateMessageRecords(records, attachmentLookup) {
  const hydrated = []
  for (const record of records || []) {
    if (record?.type !== TYPE_MESSAGE) continue
    hydrated.push(withAttachments(record, attachmentLookup))
  }
  return hydrated
}

function organizeAutoMessages(records, attachmentLookup) {
  const buckets = { pre: [], post: [] }
  for (const record of records || []) {
    if (record?.type !== TYPE_AUTO_MESSAGE) continue
    const hydrated = withAttachments(record, attachmentLookup)
    const bucket = hydrated.location === 'post' ? buckets.post : buckets.pre
    bucket.push({ ...hydrated, attachments: hydrated.attachments || [] })
  }
  buckets.pre.sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
  buckets.post.sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
  return buckets
}

async function ensureChat(store, chatId) {
  const chat = await store.get(chatId)
  if (!chat || chat.type !== TYPE_CHAT) {
    throw new Error('Chat not found')
  }
  return chat
}

function coerceAutoLocation(raw) {
  if (typeof raw === 'string' && AUTO_MESSAGE_LOCATIONS.has(raw)) {
    return raw
  }
  return 'pre'
}

function coerceAutoPosition(raw) {
  const num = Number(raw)
  return Number.isFinite(num) && num >= 0 ? num : 0
}

function normalizeAutoMessage(chatId, input) {
  const createdAt = input.createdAt ?? now()
  return {
    id: input.id ?? uuidv4(),
    type: TYPE_AUTO_MESSAGE,
    chatId,
    location: coerceAutoLocation(input.location),
    position: coerceAutoPosition(input.position),
    role:
      typeof input.role === 'string' && input.role.trim()
        ? input.role.trim()
        : DEFAULT_AUTO_ROLE,
    text: typeof input.text === 'string' ? input.text : '',
    createdAt,
    updatedAt: input.updatedAt ?? createdAt,
  }
}

export async function getChatList() {
  const db = await dbPromise
  return db.getAllFromIndex(STORE_NAME, IDX_BY_TYPE, TYPE_CHAT)
}

export async function saveNewChat(chat) {
  const db = await dbPromise
  const tx = db.transaction(STORE_NAME, 'readwrite')
  const store = tx.store
  const ts = now()
  const base = {
    id: chat.id ?? uuidv4(),
    type: TYPE_CHAT,
    createdAt: chat.createdAt ?? ts,
    lastModified: ts,
    ...chat,
  }
  await store.put(deepClone(base))
  await tx.done
  return base.id
}

export async function saveChatSettings(chatId, settings = null) {
  const db = await dbPromise
  const tx = db.transaction(STORE_NAME, 'readwrite')
  const store = tx.store
  const chat = await ensureChat(store, chatId)
  const next = {
    ...chat,
    lastModified: now(),
  }
  if (settings && typeof settings === 'object') {
    next.settings = deepClone(settings)
  } else if ('settings' in next) {
    delete next.settings
  }
  await store.put(next)
  await tx.done
}

export async function updateChatMetadata(chatId, patch = {}) {
  const db = await dbPromise
  const tx = db.transaction(STORE_NAME, 'readwrite')
  const store = tx.store
  const chat = await ensureChat(store, chatId)
  const updated = { ...chat, ...patch, lastModified: now() }
  await store.put(updated)
  await tx.done
}

export async function getChatDetails(chatId) {
  const db = await dbPromise
  const tx = db.transaction(STORE_NAME, 'readonly')
  const store = tx.store

  const chat = await store.get(chatId)
  if (!chat || chat.type !== TYPE_CHAT) {
    await tx.done
    return null
  }

  const messageRange = IDBKeyRange.bound(
    [chatId, -Infinity],
    [chatId, Infinity]
  )
  const [rawMessages, rawAutoMessages, rawAttachments] = await Promise.all([
    store.index(IDX_MESSAGE_BY_CHAT_SEQUENCE).getAll(messageRange),
    store
      .index(IDX_AUTO_MESSAGE_BY_CHAT_LOCATION)
      .getAll(buildAutoMessageRange(chatId)),
    store
      .index(IDX_ATTACHMENT_BY_CHAT)
      .getAll(buildChatAttachmentRange(chatId)),
  ])

  const attachmentLookup = buildAttachmentLookup(rawAttachments)
  const messages = hydrateMessageRecords(rawMessages, attachmentLookup)
  const autoMessages = organizeAutoMessages(rawAutoMessages, attachmentLookup)
  await tx.done
  return { ...chat, messages, autoMessages }
}

export async function getAutoMessages(chatId) {
  const db = await dbPromise
  const tx = db.transaction(STORE_NAME, 'readonly')
  const store = tx.store
  const [rawAutoMessages, rawAttachments] = await Promise.all([
    store
      .index(IDX_AUTO_MESSAGE_BY_CHAT_LOCATION)
      .getAll(buildAutoMessageRange(chatId)),
    store
      .index(IDX_ATTACHMENT_BY_CHAT)
      .getAll(buildChatAttachmentRange(chatId)),
  ])
  const attachmentLookup = buildAttachmentLookup(rawAttachments)
  const autoMessages = organizeAutoMessages(rawAutoMessages, attachmentLookup)
  await tx.done
  return autoMessages
}

function buildAutoMessagePayload(payload) {
  const result = []
  const pushItem = (item, location, position) => {
    result.push({
      ...item,
      location,
      position,
    })
  }
  if (Array.isArray(payload)) {
    payload.forEach((item, index) =>
      pushItem(item, coerceAutoLocation(item.location), index)
    )
    return result
  }
  ;(payload?.pre || []).forEach((item, index) => pushItem(item, 'pre', index))
  ;(payload?.post || []).forEach((item, index) => pushItem(item, 'post', index))
  return result
}

export async function saveAutoMessages(
  chatId,
  payload = { pre: [], post: [] }
) {
  const db = await dbPromise
  const tx = db.transaction(STORE_NAME, 'readwrite')
  const store = tx.store
  const chat = await ensureChat(store, chatId)

  const existingRecords = await store
    .index(IDX_AUTO_MESSAGE_BY_CHAT_LOCATION)
    .getAll(buildAutoMessageRange(chatId))

  const existingMap = new Map(
    existingRecords.map((record) => [record.id, record])
  )

  const incoming = buildAutoMessagePayload(payload)

  for (const raw of incoming) {
    const record = normalizeAutoMessage(chatId, raw)
    existingMap.delete(record.id)
    await store.put(deepClone(record))
    if (raw.attachments) {
      await replaceAttachments(
        store,
        chatId,
        record.id,
        raw.attachments,
        'auto-message'
      )
    }
  }

  for (const leftover of existingMap.values()) {
    await deleteAttachmentsForMessage(store, leftover.id)
    await store.delete(leftover.id)
  }

  await store.put({ ...chat, lastModified: now() })
  await tx.done
}

export async function deleteAutoMessages(chatId) {
  const db = await dbPromise
  const tx = db.transaction(STORE_NAME, 'readwrite')
  const store = tx.store
  const [records, attachments] = await Promise.all([
    store
      .index(IDX_AUTO_MESSAGE_BY_CHAT_LOCATION)
      .getAll(buildAutoMessageRange(chatId)),
    store
      .index(IDX_ATTACHMENT_BY_CHAT)
      .getAll(buildChatAttachmentRange(chatId)),
  ])

  const attachmentLookup = buildAttachmentLookup(attachments)

  for (const record of records || []) {
    const bucket = attachmentLookup.get(record.id)
    if (bucket) {
      for (const att of bucket) {
        await store.delete(att.id)
      }
      attachmentLookup.delete(record.id)
    }
    await store.delete(record.id)
  }

  await tx.done
}

export async function saveMessage(chatId, message) {
  const db = await dbPromise
  const tx = db.transaction(STORE_NAME, 'readwrite')
  const store = tx.store
  const chat = await ensureChat(store, chatId)
  const record = normalizeMessage(chatId, message)
  record.updatedAt = now()
  await store.put(deepClone(record))
  await replaceAttachments(
    store,
    chatId,
    record.id,
    message.attachments,
    record.sender
  )
  await store.put({ ...chat, lastModified: now() })
  await tx.done
  return record.id
}

export async function updateMessage(chatId, message) {
  const db = await dbPromise
  const tx = db.transaction(STORE_NAME, 'readwrite')
  const store = tx.store
  const chat = await ensureChat(store, chatId)
  const current = await store.get(message.id)
  if (!current || current.type !== TYPE_MESSAGE || current.chatId !== chatId) {
    throw new Error('Message not found')
  }
  const next = {
    ...current,
    ...normalizeMessage(chatId, { ...current, ...message }),
    id: current.id,
    createdAt: current.createdAt,
    updatedAt: now(),
  }
  await store.put(deepClone(next))
  if (message.attachments) {
    await replaceAttachments(
      store,
      chatId,
      next.id,
      message.attachments,
      next.sender
    )
  }
  await store.put({ ...chat, lastModified: now() })
  await tx.done
}

export async function deleteMessage(chatId, messageId) {
  const db = await dbPromise
  const tx = db.transaction(STORE_NAME, 'readwrite')
  const store = tx.store
  const chat = await ensureChat(store, chatId)
  const target = await store.get(messageId)
  if (!target || target.type !== TYPE_MESSAGE) {
    await tx.done
    return
  }
  const range = IDBKeyRange.bound([messageId, -Infinity], [messageId, Infinity])
  const atts = await store.index(IDX_ATTACHMENT_BY_MESSAGE).getAll(range)
  for (const att of atts || []) {
    await store.delete(att.id)
  }
  await store.delete(messageId)
  await store.put({ ...chat, lastModified: now() })
  await tx.done
}

export async function deleteChat(chatId) {
  const db = await dbPromise
  const tx = db.transaction(STORE_NAME, 'readwrite')
  const store = tx.store
  const chat = await store.get(chatId)
  if (!chat || chat.type !== TYPE_CHAT) {
    await tx.done
    return
  }
  const [attachments, messages, autoMessages] = await Promise.all([
    store
      .index(IDX_ATTACHMENT_BY_CHAT)
      .getAll(buildChatAttachmentRange(chatId)),
    store.index(IDX_MESSAGE_BY_CHAT).getAll(chatId),
    store
      .index(IDX_AUTO_MESSAGE_BY_CHAT_LOCATION)
      .getAll(buildAutoMessageRange(chatId)),
  ])

  for (const attachment of attachments || []) {
    await store.delete(attachment.id)
  }

  for (const msg of messages || []) {
    await store.delete(msg.id)
  }

  for (const autoMsg of autoMessages || []) {
    await store.delete(autoMsg.id)
  }

  await store.delete(chatId)
  await tx.done
}

export async function getAllRecords() {
  const db = await dbPromise
  return db.getAll(STORE_NAME)
}

const hasBlobCtor = typeof Blob !== 'undefined'
const hasFileCtor = typeof File !== 'undefined'

function sanitizeAttachmentForInspection(attachment) {
  const copy = { ...attachment }
  if (hasBlobCtor && copy.blob instanceof Blob) {
    copy.blobSize = copy.blob.size
    copy.blobType = copy.blob.type
    delete copy.blob
  }
  if (hasFileCtor && copy.file instanceof File) {
    copy.fileName = copy.file.name
    delete copy.file
  }
  return copy
}

function sanitizeRecordForInspection(record) {
  if (!record || typeof record !== 'object') return record
  const copy = { ...record }
  if (hasBlobCtor && copy.blob instanceof Blob) {
    copy.blobSize = copy.blob.size
    copy.blobType = copy.blob.type
    delete copy.blob
  }
  if (hasFileCtor && copy.file instanceof File) {
    copy.fileName = copy.file.name
    delete copy.file
  }
  if (Array.isArray(copy.attachments)) {
    copy.attachments = copy.attachments.map((att) =>
      sanitizeAttachmentForInspection(att)
    )
  }
  if (Array.isArray(copy.messages)) {
    copy.messages = copy.messages.map((msg) => sanitizeRecordForInspection(msg))
  }
  if (Array.isArray(copy.autoMessages)) {
    copy.autoMessages = copy.autoMessages.map((msg) =>
      sanitizeRecordForInspection(msg)
    )
  }
  return copy
}

export async function getRecordCounts() {
  const db = await dbPromise
  const tx = db.transaction(STORE_NAME, 'readonly')
  const store = tx.store
  const index = store.index(IDX_BY_TYPE)

  const [all, chat, message, attachment] = await Promise.all([
    store.count(),
    index.count(TYPE_CHAT),
    index.count(TYPE_MESSAGE),
    index.count(TYPE_ATTACHMENT),
  ])

  await tx.done
  return {
    all,
    chat,
    message,
    attachment,
  }
}

export async function getRecordsPage({
  type = 'all',
  offset = 0,
  limit = 50,
} = {}) {
  const db = await dbPromise
  const tx = db.transaction(STORE_NAME, 'readonly')
  const store = tx.store
  const effectiveLimit = Math.max(1, Number(limit) || 1)
  const skip = Math.max(0, Number(offset) || 0)

  const records = []
  let total = 0

  if (type === 'all') {
    total = await store.count()
    let cursor = await store.openCursor()
    if (cursor && skip > 0) {
      cursor = await cursor.advance(skip)
    }
    while (cursor && records.length < effectiveLimit) {
      records.push(sanitizeRecordForInspection(cursor.value))
      cursor = await cursor.continue()
    }
  } else {
    const keyRange = IDBKeyRange.only(type)
    const index = store.index(IDX_BY_TYPE)
    total = await index.count(type)
    let cursor = await index.openCursor(keyRange)
    if (cursor && skip > 0) {
      cursor = await cursor.advance(skip)
    }
    while (cursor && records.length < effectiveLimit) {
      records.push(sanitizeRecordForInspection(cursor.value))
      cursor = await cursor.continue()
    }
  }

  await tx.done
  return { records, total }
}

export async function deleteRecordById(id) {
  const db = await dbPromise
  await db.delete(STORE_NAME, id)
}

export async function clearStore() {
  const db = await dbPromise
  await db.clear(STORE_NAME)
}

export async function getStorageUsage() {
  const all = await getAllRecords()
  let total = 0
  for (const r of all) {
    if (r.type === TYPE_ATTACHMENT) {
      total += r.size ?? r.blob?.size ?? 0
    } else {
      total += JSON.stringify(r).length
    }
  }
  return total
}

export async function cloneChat(chatId) {
  const db = await dbPromise
  const rtx = db.transaction(STORE_NAME, 'readonly')
  const storeR = rtx.store
  const chat = await storeR.get(chatId)
  if (!chat || chat.type !== TYPE_CHAT) {
    await rtx.done
    throw new Error('Chat not found')
  }
  const messageRange = IDBKeyRange.bound(
    [chatId, -Infinity],
    [chatId, Infinity]
  )
  const attachmentRange = buildChatAttachmentRange(chatId)
  const messages = await storeR
    .index(IDX_MESSAGE_BY_CHAT_SEQUENCE)
    .getAll(messageRange)
  const attachments = await storeR
    .index(IDX_ATTACHMENT_BY_CHAT)
    .getAll(attachmentRange)
  const autoMessages = await storeR
    .index(IDX_AUTO_MESSAGE_BY_CHAT_LOCATION)
    .getAll(buildAutoMessageRange(chatId))
  await rtx.done

  const newChatId = uuidv4()
  const ts = now()
  const wtx = db.transaction(STORE_NAME, 'readwrite')
  const storeW = wtx.store
  await storeW.put({
    ...deepClone(chat),
    id: newChatId,
    title: ' - ' + chat.title,
    createdAt: ts,
    lastModified: ts,
  })

  const messageIdMap = new Map()
  for (const msg of messages || []) {
    if (msg.type !== TYPE_MESSAGE) continue
    const newId = uuidv4()
    messageIdMap.set(msg.id, newId)
    await storeW.put({
      ...deepClone(msg),
      id: newId,
      chatId: newChatId,
    })
  }

  const autoMessageIdMap = new Map()
  for (const autoMsg of autoMessages || []) {
    const newId = uuidv4()
    autoMessageIdMap.set(autoMsg.id, newId)
    await storeW.put({
      ...deepClone(autoMsg),
      id: newId,
      chatId: newChatId,
    })
  }

  for (const att of attachments || []) {
    const mappedMessageId =
      messageIdMap.get(att.messageId) || autoMessageIdMap.get(att.messageId)
    if (!mappedMessageId) continue
    const clonedAttachment = cloneAttachmentForChat(
      att,
      newChatId,
      mappedMessageId
    )
    await storeW.put(clonedAttachment)
  }
  await wtx.done
  return { newChatId }
}

function buildArchiveManifest(
  chats,
  messagesByChat,
  attachmentsByChat,
  autoMessagesByChat
) {
  return {
    version: DB_VERSION,
    exportedAt: now(),
    entities: {
      chats: chats.map((chat) => ({ ...chat })),
      messages: messagesByChat.flatMap(([, msgs]) =>
        (msgs || []).map((m) => ({
          ...m,
          attachments: undefined,
        }))
      ),
      autoMessages: autoMessagesByChat.flatMap(([, autos]) => autos || []),
      attachments: attachmentsByChat.flatMap(([, atts]) => atts || []),
    },
  }
}

export async function exportArchive(scope = { kind: 'all' }) {
  const db = await dbPromise
  const tx = db.transaction(STORE_NAME, 'readonly')
  const store = tx.store

  let chats = []
  if (scope.kind === 'all') {
    chats = await store.index(IDX_BY_TYPE).getAll(TYPE_CHAT)
  } else {
    const arr = []
    for (const id of scope.chatIds || []) {
      const chat = await store.get(id)
      if (chat && chat.type === TYPE_CHAT) arr.push(chat)
    }
    chats = arr
  }

  const msgGroups = []
  const attGroups = []
  const autoMsgGroups = []
  for (const chat of chats) {
    const range = IDBKeyRange.bound([chat.id, -Infinity], [chat.id, Infinity])
    const messages = await store
      .index(IDX_MESSAGE_BY_CHAT_SEQUENCE)
      .getAll(range)
    const attachments = await store
      .index(IDX_ATTACHMENT_BY_CHAT)
      .getAll(buildChatAttachmentRange(chat.id))
    const autoMessages = await store
      .index(IDX_AUTO_MESSAGE_BY_CHAT_LOCATION)
      .getAll(buildAutoMessageRange(chat.id))
    msgGroups.push([chat.id, messages.filter((m) => m.type === TYPE_MESSAGE)])
    attGroups.push([
      chat.id,
      (attachments || []).map((a) => ({
        ...a,
        hasBlob: !!a.blob,
        blobPath: a.blob ? `attachments/${a.id}` : undefined,
      })),
    ])
    autoMsgGroups.push([chat.id, autoMessages])
  }
  await tx.done

  const manifest = buildArchiveManifest(
    chats,
    msgGroups,
    attGroups,
    autoMsgGroups
  )
  const zip = new JSZip()
  zip.file('manifest.json', JSON.stringify(manifest, null, 2))
  for (const [, atts] of attGroups) {
    for (const att of atts || []) {
      if (att.hasBlob && att.blobPath && att.blob) {
        zip.file(att.blobPath, att.blob)
      }
    }
  }
  return zip.generateAsync({ type: 'blob' })
}

export async function importArchive(file, opts = {}) {
  const idMode = opts.idMode ?? 'rewrite-if-conflict'
  const zip = await JSZip.loadAsync(file)
  const manifestFile = zip.file('manifest.json')
  if (!manifestFile) {
    throw new Error('manifest.json not found in the archive.')
  }
  const manifest = JSON.parse(await manifestFile.async('string'))

  const chats = manifest?.entities?.chats ?? []
  const messages = manifest?.entities?.messages ?? []
  const autoMessages = manifest?.entities?.autoMessages ?? []
  const attachments = manifest?.entities?.attachments ?? []

  opts.onProgress?.({
    phase: 'analyzing',
    totals: {
      chats: chats.length,
      messages: messages.length,
      autoMessages: autoMessages.length,
      attachments: attachments.length,
    },
  })

  const db = await dbPromise
  const existsId = async (id) => (await db.get(STORE_NAME, id)) != null
  const rewriteId = async (oldId, mode) => {
    if (mode === 'always') return uuidv4()
    if (mode === 'preserve') return oldId
    return (await existsId(oldId)) ? uuidv4() : oldId
  }

  const mapChat = new Map()
  const mapMessage = new Map()
  const mapAutoMessage = new Map()
  const mapAttachment = new Map()
  for (const chat of chats)
    mapChat.set(chat.id, await rewriteId(chat.id, idMode))
  for (const message of messages)
    mapMessage.set(message.id, await rewriteId(message.id, idMode))
  for (const autoMessage of autoMessages)
    mapAutoMessage.set(autoMessage.id, await rewriteId(autoMessage.id, idMode))
  for (const attachment of attachments)
    mapAttachment.set(attachment.id, await rewriteId(attachment.id, idMode))

  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i]
    if (att.hasBlob && att.blobPath) {
      att.blob = await zip.file(att.blobPath).async('blob')
    }
    opts.onProgress?.({
      phase: 'read:attachment',
      current: i + 1,
      total: attachments.length,
    })
  }

  const tx = db.transaction(STORE_NAME, 'readwrite')
  const store = tx.store

  for (let i = 0; i < chats.length; i++) {
    const chat = chats[i]
    await store.put({
      ...chat,
      id: mapChat.get(chat.id),
    })
    opts.onProgress?.({
      phase: 'write:chat',
      current: i + 1,
      total: chats.length,
    })
  }

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    await store.put({
      ...message,
      id: mapMessage.get(message.id),
      chatId: mapChat.get(message.chatId),
      type: TYPE_MESSAGE,
    })
    opts.onProgress?.({
      phase: 'write:message',
      current: i + 1,
      total: messages.length,
    })
  }

  for (let i = 0; i < autoMessages.length; i++) {
    const autoMessage = autoMessages[i]
    await store.put({
      ...autoMessage,
      id: mapAutoMessage.get(autoMessage.id),
      chatId: mapChat.get(autoMessage.chatId),
      type: TYPE_AUTO_MESSAGE,
    })
    opts.onProgress?.({
      phase: 'write:autoMessage',
      current: i + 1,
      total: autoMessages.length,
    })
  }

  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i]
    // eslint-disable-next-line no-unused-vars
    const { blobPath, hasBlob, ...rest } = att
    await store.put({
      ...rest,
      id: mapAttachment.get(att.id),
      chatId: mapChat.get(att.chatId),
      messageId:
        mapMessage.get(att.messageId) || mapAutoMessage.get(att.messageId),
      type: TYPE_ATTACHMENT,
    })
    opts.onProgress?.({
      phase: 'write:attachment',
      current: i + 1,
      total: attachments.length,
    })
  }

  await tx.done
  return { imported: chats.length }
}
