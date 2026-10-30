<template>
  <div
    class="modal-overlay"
    @mousedown.self="handleOverlayMouseDown"
    @mouseup.self="handleOverlayMouseUp"
    @mouseleave="handleOverlayMouseLeave"
  >
    <div
      ref="dialog"
      class="modal-content"
      role="dialog"
      aria-modal="true"
      aria-labelledby="data-management-modal-title"
      tabindex="-1"
    >
      <div class="modal-header">
        <h2 id="data-management-modal-title">Data Management</h2>
        <IconButton class="close-button" label="Close" @click="closeModal">
          <font-awesome-icon icon="times" />
        </IconButton>
      </div>
      <div class="modal-body">
        <div class="modal-section">
          <div class="tabs">
            <button
              v-if="IS_LOCAL_MODE"
              class="tab-button"
              :class="{ active: activeTab === 'configuration' }"
              @click="activeTab = 'configuration'"
            >
              Configuration
            </button>
            <button
              class="tab-button"
              :class="{ active: activeTab === 'importExport' }"
              @click="activeTab = 'importExport'"
            >
              Import / Export
            </button>
            <button
              class="tab-button"
              :class="{ active: activeTab === 'inspector' }"
              @click="activeTab = 'inspector'"
            >
              Storage Inspector
            </button>
          </div>
          <div class="tab-content">
            <ConfigurationPanel v-if="activeTab === 'configuration'" />
            <ImportExportPanel v-if="activeTab === 'importExport'" />
            <StorageInspector v-if="activeTab === 'inspector'" />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { useModalDialog } from '../composables/useModalDialog'
import IconButton from './IconButton.vue'
import { ref, onMounted, onBeforeUnmount } from 'vue'
import ImportExportPanel from './ImportExportPanel.vue'
import StorageInspector from './StorageInspector.vue'
import ConfigurationPanel from './ConfigurationPanel.vue'
import { IS_LOCAL_MODE } from '../services/env'
const emit = defineEmits(['close'])
// The browser-only build has no server config, so its settings live here.
const activeTab = ref(IS_LOCAL_MODE ? 'configuration' : 'importExport')

const isOverlayMouseDown = ref(false)
const shouldCancelOverlayClose = ref(false)

const handleGlobalMouseUp = () => {
  if (!isOverlayMouseDown.value) return
  isOverlayMouseDown.value = false
  shouldCancelOverlayClose.value = false
}

onMounted(() => {
  window.addEventListener('mouseup', handleGlobalMouseUp)
})

onBeforeUnmount(() => {
  window.removeEventListener('mouseup', handleGlobalMouseUp)
})

const closeModal = () => {
  emit('close')
}

const dialog = ref(null)
useModalDialog(dialog, closeModal)

const handleOverlayMouseDown = (event) => {
  if (event.target !== event.currentTarget) return
  isOverlayMouseDown.value = true
  shouldCancelOverlayClose.value = false
}

const handleOverlayMouseUp = (event) => {
  if (event.target !== event.currentTarget) return
  if (!isOverlayMouseDown.value) return
  const shouldClose = !shouldCancelOverlayClose.value
  isOverlayMouseDown.value = false
  shouldCancelOverlayClose.value = false
  if (shouldClose) {
    closeModal()
  }
}

const handleOverlayMouseLeave = (event) => {
  if (!isOverlayMouseDown.value) return
  const next = event.relatedTarget
  if (next && event.currentTarget.contains(next)) {
    return
  }
  shouldCancelOverlayClose.value = true
}
</script>

<style scoped>
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background-color: var(--overlay-bg);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 1000;
}

.modal-content {
  background-color: var(--bg-color);
  border-radius: var(--border-radius);
  box-shadow: var(--shadow-lg);
  width: 95%;
  max-width: 980px;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 24px;
  border-bottom: 1px solid var(--border-color);
}

.modal-header h2 {
  font-size: 18px;
  font-weight: 600;
  color: var(--text-color);
}

.close-button {
  background: none;
  border: none;
  font-size: 20px;
  cursor: pointer;
  color: var(--text-light);
}

.modal-body {
  padding: 24px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}

.modal-section {
  border: 1px solid var(--border-color);
  border-radius: var(--border-radius);
  background-color: var(--bg-light);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.tabs {
  display: flex;
  border-bottom: 1px solid var(--border-color);
  background-color: var(--bg-color);
  gap: 4px;
  padding: 0 16px;
}

.tab-button {
  padding: 12px 16px;
  border: none;
  background: none;
  cursor: pointer;
  font-size: 15px;
  font-weight: 500;
  color: var(--text-light);
  border-bottom: 2px solid transparent;
  transition:
    color 0.2s ease,
    border-color 0.2s ease;
}

.tab-button:hover {
  color: var(--text-color);
}

.tab-button.active {
  border-bottom-color: var(--primary-color);
  color: var(--primary-color);
}

.tab-content {
  padding: 24px;
  background-color: var(--bg-light);
  max-height: 60vh;
  overflow-y: auto;
}
</style>
