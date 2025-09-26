import { defineStore } from 'pinia'
import { v4 as uuidv4 } from 'uuid'
import { parseTransformScript } from '../services/responseTransforms'
import * as db from '../services/db'

export const CHAT_SETTINGS_VERSION = 1

const DEFAULT_ROLE = 'user'
const DEFAULT_ATTACHMENT_MIME = 'application/octet-stream'
const KNOWN_AUTO_ROLES = new Set(['user', 'model'])

const normalizeAutoRoleValue = (value) => {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return KNOWN_AUTO_ROLES.has(normalized) ? normalized : DEFAULT_ROLE
}

const normalizeAttachmentDraft = (draft) => {
  const id = draft?.id || uuidv4()
  return {
    id,
    name: typeof draft?.name === 'string' ? draft.name : '',
    mimeType:
      typeof draft?.mimeType === 'string' && draft.mimeType
        ? draft.mimeType
        : DEFAULT_ATTACHMENT_MIME,
    size: typeof draft?.size === 'number' ? draft.size : 0,
    source: draft?.source || 'auto-message',
    file: draft?.file || null,
    blob: draft?.blob || null,
    order: typeof draft?.order === 'number' ? draft.order : 0,
    remoteUri: typeof draft?.remoteUri === 'string' ? draft.remoteUri : null,
    uploadProgress:
      typeof draft?.uploadProgress === 'number' ? draft.uploadProgress : 100,
    error: typeof draft?.error === 'string' ? draft.error : null,
    expirationTime:
      typeof draft?.expirationTime === 'number' ? draft.expirationTime : null,
  }
}

const normalizeAutoMessageDraft = (part) => {
  const id = part?.id || uuidv4()
  const role = normalizeAutoRoleValue(part?.role)
  return {
    id,
    role,
    text: typeof part?.text === 'string' ? part.text : '',
    attachments: Array.isArray(part?.attachments)
      ? part.attachments.map((item) => normalizeAttachmentDraft(item))
      : [],
  }
}

const normalizeTransform = (rule, index = 0) => {
  const type = rule?.type === 'remove' ? 'remove' : 'replace'
  const id = rule?.id || uuidv4()
  const pattern = typeof rule?.pattern === 'string' ? rule.pattern : ''
  const applyOrder =
    typeof rule?.applyOrder === 'number' ? rule.applyOrder : index
  const base = {
    id,
    type,
    pattern,
    applyOrder,
  }
  if (type === 'replace') {
    return {
      ...base,
      replacement:
        typeof rule?.replacement === 'string' ? rule.replacement : '',
    }
  }
  return base
}

const normalizeAutoMessagesDraft = (parts) => ({
  pre: Array.isArray(parts?.pre)
    ? parts.pre.map((item) => normalizeAutoMessageDraft(item))
    : [],
  post: Array.isArray(parts?.post)
    ? parts.post.map((item) => normalizeAutoMessageDraft(item))
    : [],
})

const attachmentDraftFromRecord = (record, index = 0) =>
  normalizeAttachmentDraft({
    ...record,
    file: null,
    blob: record?.blob || null,
    order: typeof record?.order === 'number' ? record.order : index,
  })

const autoMessageDraftFromRecord = (record) => ({
  id: record?.id || uuidv4(),
  role: normalizeAutoRoleValue(record?.role),
  text: typeof record?.text === 'string' ? record.text : '',
  attachments: Array.isArray(record?.attachments)
    ? record.attachments.map((att, idx) => attachmentDraftFromRecord(att, idx))
    : [],
})

const attachmentPayloadFromDraft = (draft, index) => ({
  id: draft?.id || uuidv4(),
  name: draft?.name || '',
  mimeType: draft?.mimeType || DEFAULT_ATTACHMENT_MIME,
  size: typeof draft?.size === 'number' ? draft.size : 0,
  source: draft?.source || 'auto-message',
  order: typeof draft?.order === 'number' ? draft.order : index,
  blob: draft?.file || draft?.blob || null,
  remoteUri: typeof draft?.remoteUri === 'string' ? draft.remoteUri : null,
  uploadProgress:
    typeof draft?.uploadProgress === 'number' ? draft.uploadProgress : 100,
  error: typeof draft?.error === 'string' ? draft.error : null,
  expirationTime:
    typeof draft?.expirationTime === 'number' ? draft.expirationTime : null,
})

const autoMessagePayloadFromDraft = (draft, location, position) => ({
  id: draft?.id,
  location,
  position,
  role: normalizeAutoRoleValue(draft?.role),
  text: draft?.text || '',
  attachments: Array.isArray(draft?.attachments)
    ? draft.attachments.map((att, idx) => attachmentPayloadFromDraft(att, idx))
    : [],
})

export const normalizeChatSettings = (raw) => {
  if (!raw) {
    return {
      version: CHAT_SETTINGS_VERSION,
      systemPrompt: '',
      transformSource: '',
      responseTransforms: [],
      autoMessages: { pre: [], post: [] },
    }
  }
  return {
    version:
      typeof raw.version === 'number' ? raw.version : CHAT_SETTINGS_VERSION,
    systemPrompt: typeof raw.systemPrompt === 'string' ? raw.systemPrompt : '',
    transformSource:
      typeof raw.transformSource === 'string' ? raw.transformSource : '',
    responseTransforms: Array.isArray(raw.responseTransforms)
      ? raw.responseTransforms.map((item, index) =>
          normalizeTransform(item, index)
        )
      : [],
    autoMessages: normalizeAutoMessagesDraft(raw.autoMessages || raw.autoParts),
  }
}

export const createEmptyChatSettings = (overrides = {}) =>
  normalizeChatSettings({ ...overrides })

const cloneSettings = (settings) => normalizeChatSettings(settings)

const mergeSettings = (base, updates) => {
  if (!updates) return cloneSettings(base)
  const normalizedUpdates = normalizeChatSettings(updates)
  return {
    version: normalizedUpdates.version,
    systemPrompt: normalizedUpdates.systemPrompt ?? base.systemPrompt ?? '',
    transformSource:
      normalizedUpdates.transformSource ?? base.transformSource ?? '',
    responseTransforms:
      normalizedUpdates.responseTransforms.length > 0
        ? normalizedUpdates.responseTransforms
        : base.responseTransforms,
    autoMessages: normalizedUpdates.autoMessages || base.autoMessages,
  }
}

export const useChatConfigStore = defineStore('chatConfig', {
  state: () => ({
    activeChatId: null,
    settingsByChatId: {},
    pendingSettings: null,
    transformErrorsByChatId: {},
    pendingTransformErrors: [],
  }),

  getters: {
    activeSettings(state) {
      if (state.activeChatId && state.settingsByChatId[state.activeChatId]) {
        return state.settingsByChatId[state.activeChatId]
      }
      if (!state.activeChatId && state.pendingSettings) {
        return state.pendingSettings
      }
      return createEmptyChatSettings()
    },
    activeTransformErrors(state) {
      if (
        state.activeChatId &&
        state.transformErrorsByChatId[state.activeChatId]
      ) {
        return state.transformErrorsByChatId[state.activeChatId]
      }
      if (!state.activeChatId) {
        return state.pendingTransformErrors
      }
      return []
    },
  },

  actions: {
    setActiveChat(chatId) {
      this.activeChatId = chatId || null
    },

    prepareForExistingChat(chatId, defaults = null) {
      if (!chatId) {
        this.prepareForNewChat(defaults)
        return
      }
      const normalized =
        defaults !== null
          ? normalizeChatSettings(defaults)
          : this.settingsByChatId[chatId] || createEmptyChatSettings()
      this.settingsByChatId = {
        ...this.settingsByChatId,
        [chatId]: normalized,
      }
      this.pendingSettings = null
      this.setActiveChat(chatId)
      this.transformErrorsByChatId = {
        ...this.transformErrorsByChatId,
        [chatId]: [],
      }
    },

    prepareForNewChat(defaults = null) {
      const base = defaults
        ? mergeSettings(createEmptyChatSettings(), defaults)
        : createEmptyChatSettings()
      this.pendingSettings = base
      this.setActiveChat(null)
      this.pendingTransformErrors = []
    },

    ensureForChat(chatId) {
      if (!chatId) {
        if (!this.pendingSettings) {
          this.pendingSettings = createEmptyChatSettings()
        }
        return this.pendingSettings
      }
      if (!this.settingsByChatId[chatId]) {
        this.settingsByChatId = {
          ...this.settingsByChatId,
          [chatId]: createEmptyChatSettings(),
        }
      }
      return this.settingsByChatId[chatId]
    },

    commitPending(chatId) {
      if (!chatId || !this.pendingSettings) {
        this.setActiveChat(chatId || null)
        return null
      }
      const committed = cloneSettings(this.pendingSettings)
      this.settingsByChatId = {
        ...this.settingsByChatId,
        [chatId]: committed,
      }
      this.pendingSettings = null
      this.setActiveChat(chatId)
      if (this.pendingTransformErrors.length) {
        this.transformErrorsByChatId = {
          ...this.transformErrorsByChatId,
          [chatId]: [...this.pendingTransformErrors],
        }
      }
      this.pendingTransformErrors = []
      return committed
    },

    updateSystemPrompt(nextPrompt) {
      const target = this.activeChatId
        ? this.settingsByChatId[this.activeChatId]
        : this.pendingSettings
      if (!target) {
        const base = createEmptyChatSettings({ systemPrompt: nextPrompt || '' })
        if (this.activeChatId) {
          this.settingsByChatId = {
            ...this.settingsByChatId,
            [this.activeChatId]: base,
          }
        } else {
          this.pendingSettings = base
        }
        return
      }
      target.systemPrompt = typeof nextPrompt === 'string' ? nextPrompt : ''
    },

    getSystemPrompt(chatId, fallback = '') {
      if (chatId && this.settingsByChatId[chatId]) {
        return this.settingsByChatId[chatId].systemPrompt || fallback || ''
      }
      if (!chatId && this.pendingSettings) {
        return this.pendingSettings.systemPrompt || fallback || ''
      }
      return fallback || ''
    },

    getTransformSource(chatId) {
      if (chatId && this.settingsByChatId[chatId]) {
        return this.settingsByChatId[chatId].transformSource || ''
      }
      if (!chatId && this.pendingSettings) {
        return this.pendingSettings.transformSource || ''
      }
      return ''
    },

    getResponseTransforms(chatId) {
      if (chatId && this.settingsByChatId[chatId]) {
        return this.settingsByChatId[chatId].responseTransforms || []
      }
      if (!chatId && this.pendingSettings) {
        return this.pendingSettings.responseTransforms || []
      }
      return []
    },

    getAutoMessages(chatId) {
      if (chatId && this.settingsByChatId[chatId]) {
        return (
          this.settingsByChatId[chatId].autoMessages || {
            pre: [],
            post: [],
          }
        )
      }
      if (!chatId && this.pendingSettings) {
        return this.pendingSettings.autoMessages || { pre: [], post: [] }
      }
      return { pre: [], post: [] }
    },

    getTransformErrors(chatId) {
      if (chatId && this.transformErrorsByChatId[chatId]) {
        return this.transformErrorsByChatId[chatId]
      }
      if (!chatId) {
        return this.pendingTransformErrors
      }
      return []
    },

    updateTransformSource(script) {
      const source = typeof script === 'string' ? script : ''
      const target = this.activeChatId
        ? this.ensureForChat(this.activeChatId)
        : this.ensureForChat(null)
      const { rules, errors } = parseTransformScript(source)
      target.transformSource = source
      target.responseTransforms = rules.map((rule, index) =>
        normalizeTransform(
          {
            ...rule,
            applyOrder: index,
          },
          index
        )
      )
      if (this.activeChatId) {
        this.transformErrorsByChatId = {
          ...this.transformErrorsByChatId,
          [this.activeChatId]: errors,
        }
      } else {
        this.pendingTransformErrors = errors
      }
      return { rules: target.responseTransforms, errors }
    },

    loadAutoMessages(chatId, grouped) {
      const normalized = {
        pre: Array.isArray(grouped?.pre)
          ? grouped.pre.map((item) => autoMessageDraftFromRecord(item))
          : [],
        post: Array.isArray(grouped?.post)
          ? grouped.post.map((item) => autoMessageDraftFromRecord(item))
          : [],
      }
      const target = this.ensureForChat(chatId || null)
      target.autoMessages = normalized
    },

    updateAutoMessages(location, drafts) {
      if (location !== 'pre' && location !== 'post') return
      const target = this.activeChatId
        ? this.ensureForChat(this.activeChatId)
        : this.ensureForChat(null)
      const nextDrafts = Array.isArray(drafts)
        ? drafts.map((item) => normalizeAutoMessageDraft(item))
        : []
      target.autoMessages = target.autoMessages || { pre: [], post: [] }
      target.autoMessages = {
        ...target.autoMessages,
        [location]: nextDrafts,
      }
    },

    serializeAutoMessages(chatId) {
      const target = chatId
        ? this.settingsByChatId[chatId]
        : this.pendingSettings
      if (!target?.autoMessages) {
        return { pre: [], post: [] }
      }
      const mapDrafts = (list, location) =>
        (list || []).map((draft, index) =>
          autoMessagePayloadFromDraft(draft, location, index)
        )
      return {
        pre: mapDrafts(target.autoMessages.pre, 'pre'),
        post: mapDrafts(target.autoMessages.post, 'post'),
      }
    },

    serializeSettings(chatId) {
      const target = chatId
        ? this.settingsByChatId[chatId]
        : this.pendingSettings
      const normalized = cloneSettings(target || createEmptyChatSettings())
      return {
        version: normalized.version,
        systemPrompt: normalized.systemPrompt,
        transformSource: normalized.transformSource,
        responseTransforms: normalized.responseTransforms,
      }
    },

    async persistSettings(chatId) {
      if (!chatId) return
      const settings = this.serializeSettings(chatId)
      await db.saveChatSettings(chatId, settings)
    },

    async persistAutoMessages(chatId) {
      if (!chatId) return
      const payload = this.serializeAutoMessages(chatId)
      await db.saveAutoMessages(chatId, payload)
    },

    clearChatSettings(chatId) {
      if (!chatId) {
        this.pendingSettings = null
        return
      }
      if (!this.settingsByChatId[chatId]) return
      const next = { ...this.settingsByChatId }
      delete next[chatId]
      this.settingsByChatId = next
      if (this.transformErrorsByChatId[chatId]) {
        const errState = { ...this.transformErrorsByChatId }
        delete errState[chatId]
        this.transformErrorsByChatId = errState
      }
    },
  },
})
