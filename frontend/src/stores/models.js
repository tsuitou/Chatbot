import { defineStore } from 'pinia'
import * as db from '../services/db'
import { getModelCapabilities } from '../services/api'
import { normalizeSettingsEntry, cloneSettings } from '../services/modelConfig'

export const EMPTY_CAPABILITIES = Object.freeze({
  features: {},
  parameters: {},
  tools: {},
  attachments: { enabled: false },
})

function normalizeModelGroups(input) {
  if (!Array.isArray(input)) return []
  if (input.every((item) => typeof item === 'string')) {
    return [
      {
        provider: null,
        label: 'Models',
        models: [...input],
      },
    ]
  }
  return input
    .map((group) => ({
      provider: group?.provider || null,
      label: group?.label || group?.provider || 'Models',
      models: Array.isArray(group?.models) ? [...group.models] : [],
    }))
    .filter((group) => group.models.length > 0)
}

function capabilityKey(providerId, model) {
  return `${providerId || ''}:${model || ''}`
}

// Server-provided model catalogue plus the user's per-model settings.
export const useModelsStore = defineStore('models', {
  state: () => ({
    availableModels: [],
    defaultModel: null,
    settingsByModel: {},
    capabilitiesByKey: {},
  }),

  getters: {
    allAvailableModels: (state) =>
      state.availableModels.flatMap((group) =>
        Array.isArray(group?.models) ? group.models : []
      ),
  },

  actions: {
    setAvailableModels(models) {
      this.availableModels = normalizeModelGroups(models)
    },

    setDefaultModel(model) {
      this.defaultModel = typeof model === 'string' ? model : null
    },

    setModelSettings(settingsByModel = {}) {
      this.settingsByModel = { ...settingsByModel }
    },

    async loadModelSettings() {
      this.setModelSettings(await db.getModelSettings())
    },

    // A fresh copy, safe for callers to mutate.
    settingsFor(model) {
      const raw = model && this.settingsByModel[model]
      return cloneSettings(normalizeSettingsEntry(raw || null))
    },

    capabilitiesFor(model, providerId) {
      if (!model) return EMPTY_CAPABILITIES
      return (
        this.capabilitiesByKey[capabilityKey(providerId, model)] ||
        EMPTY_CAPABILITIES
      )
    },

    async ensureModelCapabilities(model, providerId) {
      if (!model) return EMPTY_CAPABILITIES
      const key = capabilityKey(providerId, model)
      const cached = this.capabilitiesByKey[key]
      if (cached) return cached
      const capabilities = await getModelCapabilities(model, providerId)
      this.capabilitiesByKey = {
        ...this.capabilitiesByKey,
        [key]: capabilities,
      }
      return capabilities
    },
  },
})
