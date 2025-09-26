import { defineStore } from 'pinia'
import { DEBUG_PANEL_ENABLED } from '../services/env'

const HISTORY_LIMIT = 10

const createEntry = (payload) => ({
  id:
    typeof globalThis !== 'undefined' && globalThis.crypto?.randomUUID
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`,
  timestamp: Date.now(),
  payload,
})

export const useDebugStore = defineStore('debug', {
  state: () => ({
    isPanelOpen: false,
    history: [],
    selectedId: null,
  }),

  getters: {
    entries(state) {
      return state.history
    },
    activeEntry(state) {
      if (!state.history.length) return null
      if (state.selectedId) {
        return (
          state.history.find((entry) => entry.id === state.selectedId) ?? null
        )
      }
      return state.history[0]
    },
  },

  actions: {
    recordRequest(payload) {
      if (!DEBUG_PANEL_ENABLED) return
      try {
        const snapshot = JSON.parse(JSON.stringify(payload))
        const entry = createEntry(snapshot)
        this.history.unshift(entry)
        if (this.history.length > HISTORY_LIMIT) {
          this.history.length = HISTORY_LIMIT
        }
        this.selectedId = entry.id
      } catch (error) {
        console.error('Failed to record debug request:', error)
      }
    },

    setSelected(id) {
      if (!DEBUG_PANEL_ENABLED) return
      this.selectedId = id
    },

    togglePanel(force) {
      if (!DEBUG_PANEL_ENABLED) return
      if (typeof force === 'boolean') {
        this.isPanelOpen = force
      } else {
        this.isPanelOpen = !this.isPanelOpen
      }
    },

    closePanel() {
      if (!DEBUG_PANEL_ENABLED) return
      this.isPanelOpen = false
    },
  },
})
