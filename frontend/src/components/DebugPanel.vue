<template>
  <div class="debug-container">
    <button class="debug-toggle" type="button" @click="togglePanel">
      Debug
    </button>
    <div v-if="isPanelOpen" class="debug-panel">
      <div class="debug-header">
        <h3>Last API Request</h3>
        <div class="debug-actions">
          <select
            v-if="entries.length > 1"
            v-model="selectedId"
            class="debug-select"
          >
            <option v-for="entry in entries" :key="entry.id" :value="entry.id">
              {{ formatTimestamp(entry.timestamp) }}
            </option>
          </select>
          <button class="debug-close" type="button" @click="closePanel">
            Close
          </button>
        </div>
      </div>
      <pre class="debug-body">{{ formattedPayload }}</pre>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { useDebugStore } from '../stores/debug'

const debugStore = useDebugStore()

const isPanelOpen = computed(() => debugStore.isPanelOpen)
const entries = computed(() => debugStore.entries)
const activeEntry = computed(() => debugStore.activeEntry)

const selectedId = ref(debugStore.selectedId)

watch(
  () => debugStore.selectedId,
  (next) => {
    selectedId.value = next
  }
)

watch(selectedId, (next) => {
  if (next) {
    debugStore.setSelected(next)
  }
})

watch(entries, (next) => {
  if (!next.length) {
    selectedId.value = null
    debugStore.setSelected(null)
    return
  }
  if (
    !selectedId.value ||
    !next.some((entry) => entry.id === selectedId.value)
  ) {
    selectedId.value = next[0].id
    debugStore.setSelected(selectedId.value)
  }
})

const formattedPayload = computed(() => {
  if (!activeEntry.value) return 'No requests captured yet.'
  try {
    return JSON.stringify(activeEntry.value.payload, null, 2)
  } catch (error) {
    console.error('Failed to render payload:', error)
    return 'Failed to render payload.'
  }
})

const togglePanel = () => {
  debugStore.togglePanel()
}

const closePanel = () => {
  debugStore.closePanel()
}

const formatTimestamp = (ts) => {
  const date = new Date(ts)
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`
}
</script>

<style scoped>
.debug-container {
  position: fixed;
  bottom: 16px;
  right: 16px;
  z-index: 1200;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
}

.debug-toggle {
  padding: 6px 12px;
  border: 1px solid var(--border-color);
  border-radius: var(--border-radius);
  background-color: var(--bg-color);
  cursor: pointer;
  font-size: 13px;
  color: var(--text-light);
  box-shadow: var(--shadow);
}

.debug-panel {
  width: min(480px, 90vw);
  max-height: 50vh;
  display: flex;
  flex-direction: column;
  border-radius: var(--border-radius);
  background-color: var(--bg-color);
  box-shadow: var(--shadow-lg);
  border: 1px solid var(--border-color);
  overflow: hidden;
}

.debug-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px;
  border-bottom: 1px solid var(--border-color);
  background-color: var(--bg-light);
}

.debug-header h3 {
  margin: 0;
  font-size: 14px;
  color: var(--text-color);
}

.debug-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.debug-select {
  font-size: 13px;
  padding: 4px 8px;
  border-radius: var(--border-radius);
  border: 1px solid var(--border-color);
  background-color: var(--bg-color);
}

.debug-close {
  background: none;
  border: none;
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  color: var(--text-light);
}

.debug-body {
  margin: 0;
  padding: 12px;
  overflow: auto;
  font-size: 12px;
  line-height: 1.5;
  background-color: var(--bg-gray);
  color: var(--text-color);
}
</style>
