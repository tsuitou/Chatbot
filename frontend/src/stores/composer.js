import { defineStore } from 'pinia'
import { uploadFile } from '../services/api'
import { createAttachmentBucket } from '../services/attachments'
import { createDefaultToolSettings } from '../config/defaultTools'
import { useModelsStore } from './models'

function enabledTools(selectedTools = {}, toolDefinitions = {}) {
  const result = {}
  for (const [key, definition] of Object.entries(toolDefinitions || {})) {
    if (definition?.enabled && selectedTools[key]) {
      result[key] = true
    }
  }
  return result
}

// The prompt being written and the model/tool choices it will be sent with.
export const useComposerStore = defineStore('composer', {
  state: () => ({
    prompt: '',
    model: null,
    providerId: null,
    streamingEnabled: true,
    tools: createDefaultToolSettings(),
    attachmentBucket: createAttachmentBucket(),
  }),

  getters: {
    capabilities(state) {
      return useModelsStore().capabilitiesFor(state.model, state.providerId)
    },
    toolDefinitions() {
      return this.capabilities.tools || {}
    },
    // Everything a request needs from the composer; the session adds the
    // chat-specific system instruction.
    requestConfig(state) {
      const settings = useModelsStore().settingsFor(state.model)
      const tools =
        settings.parameters.writingFunctionCall === true
          ? {}
          : enabledTools(state.tools, this.toolDefinitions)
      return {
        providerId: state.providerId || settings.providerId,
        model: state.model,
        tools,
        attachments: this.capabilities.attachments || {},
        parameters: { ...settings.parameters },
        routing: { ...settings.routing },
        streaming: state.streamingEnabled,
      }
    },
  },

  actions: {
    init() {
      this.attachmentBucket = this.createAttachmentBucket()
    },

    attachmentPolicy() {
      const policy = this.capabilities.attachments || {}
      if (policy.enabled !== true) {
        return {
          allowRemoteUpload: false,
          allowedMimes: new Set(),
          maxInlineFileSize: null,
        }
      }
      return {
        ...policy,
        allowRemoteUpload: policy.allowRemoteUpload === true,
        allowedMimes: policy.allowedMimes || null,
        maxInlineFileSize: policy.maxInlineFileSize || null,
      }
    },

    createAttachmentBucket(options = {}) {
      return createAttachmentBucket({
        ...options,
        policy: () => this.attachmentPolicy(),
        uploadFn: async (file, uploadOptions) => {
          const { model, providerId } = this.requestConfig
          return uploadFile(file, {
            model,
            providerId,
            onProgress: uploadOptions?.onProgress,
          })
        },
      })
    },

    // Unsupported attachments stay in the chat but are left out of the
    // request, so switching back to a capable model sends them again.
    withoutUnsupportedAttachments(messages) {
      const bucket = this.attachmentBucket
      let skipped = 0
      const sendable = messages.map((message) => {
        const attachments = message.attachments || []
        const kept = attachments.filter((att) => !bucket?.isUnsupported?.(att))
        skipped += attachments.length - kept.length
        return kept.length === attachments.length
          ? message
          : { ...message, attachments: kept }
      })
      return { messages: sendable, skipped }
    },

    applyDefaultModel(model, providerId = null) {
      if (!this.model && typeof model === 'string') {
        this.model = model
        this.providerId = providerId
      }
    },

    setActiveModel(model, providerId = null) {
      this.model = typeof model === 'string' ? model : null
      this.providerId = providerId
    },

    async selectModel(model, providerId = null) {
      this.setActiveModel(model, providerId)
      await useModelsStore().ensureModelCapabilities(model, providerId)
      this.pruneToolsForCurrentModel()
      this.attachmentBucket.dropUnsupportedForCurrentPolicy?.()
    },

    pruneToolsForCurrentModel() {
      const toolDefinitions = this.toolDefinitions
      const defaults = createDefaultToolSettings()
      const next = {}
      for (const key of Object.keys(toolDefinitions)) {
        if (!toolDefinitions[key]?.enabled) continue
        next[key] =
          typeof this.tools[key] === 'boolean'
            ? this.tools[key]
            : !!defaults[key]
      }
      this.tools = next
    },

    setStreamingEnabled(enabled) {
      this.streamingEnabled = !!enabled
    },

    setPrompt(value) {
      this.prompt = value ?? ''
    },

    clear() {
      this.prompt = ''
      this.attachmentBucket.clear()
    },

    toggleTool(name) {
      if (!Object.prototype.hasOwnProperty.call(this.tools, name)) return
      this.tools = { ...this.tools, [name]: !this.tools[name] }
    },
  },
})
