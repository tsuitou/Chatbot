<template>
  <div class="import-export-panel">
    <div class="section">
      <h3>Export</h3>
      <p>Export all your chat history into a single Zip file.</p>
      <button class="action-btn" @click="handleExport">Export All Data</button>
    </div>

    <div class="section">
      <h3>Import</h3>
      <p>Import chats from a previously exported Zip file.</p>
      <input
        ref="importFile"
        type="file"
        style="display: none"
        accept=".zip,application/zip"
        :disabled="isImporting"
        @change="handleFileSelected"
      />
      <button class="action-btn" :disabled="isImporting" @click="triggerImport">
        {{ isImporting ? 'Importing...' : 'Import from File' }}
      </button>
      <div v-if="isImporting" class="progress-container">
        <progress :value="importProgress" max="100"></progress>
        <span>{{ importProgress.toFixed(2) }}%</span>
        <p>{{ importStatusText }}</p>
      </div>
    </div>
    <div class="section danger-zone">
      <h3>Danger Zone</h3>
      <p>
        Permanently delete all chats, attachments, and settings. This action
        cannot be undone.
      </p>
      <button class="danger-btn" @click="handleDeleteAll">
        Delete All Data
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import * as dataManager from '../services/dataManager'
import { showErrorToast, showSuccessToast } from '../services/notification'
import { useChatStore } from '../stores/chat'

const importFile = ref(null)
const isImporting = ref(false)
const importProgress = ref(0)
const importStatusText = ref('')
const chatStore = useChatStore()

const handleExport = async () => {
  try {
    const blob = await dataManager.exportAllChats()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `gemini-chat-export-${new Date().toISOString()}.zip`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
    showSuccessToast('Export successful!')
  } catch (error) {
    console.error('Export failed:', error)
    showErrorToast('Could not export data.')
  }
}

const triggerImport = () => {
  importFile.value.click()
}

const handleFileSelected = async (event) => {
  const file = event.target.files[0]
  if (!file) return

  isImporting.value = true
  importProgress.value = 0
  importStatusText.value = 'Starting import...'

  let totalItems = 0
  let processedItems = 0

  try {
    const onProgress = (progress) => {
      if (progress.phase === 'analyzing') {
        importStatusText.value = 'Analyzing archive...'
        const {
          chats = 0,
          messages = 0,
          attachments = 0,
        } = progress.totals || {}
        totalItems = chats + messages + attachments * 2 // attachments are read and then written
        return
      }

      processedItems++
      importProgress.value =
        totalItems > 0 ? (processedItems / totalItems) * 100 : 0
      importStatusText.value = `Importing ${progress.phase}: ${progress.current}/${progress.total}`
    }

    await dataManager.importFromArchive(file, { onProgress })

    await chatStore.refreshChatList()
    await chatStore.prepareNewChat()

    importProgress.value = 100
    importStatusText.value = 'Import complete!'
    showSuccessToast('Import successful! Your chat list has been updated.')
  } catch (error) {
    console.error('Import failed:', error)
    showErrorToast(`Import failed: ${error.message}`)
    importStatusText.value = 'Import failed.'
  } finally {
    isImporting.value = false
    setTimeout(() => {
      if (importStatusText.value !== 'Import failed.') {
        importProgress.value = 0
        importStatusText.value = ''
      }
    }, 5000)
    event.target.value = ''
  }
}

const handleDeleteAll = async () => {
  if (
    confirm(
      'ARE YOU SURE you want to delete ALL data? This includes all chats, attachments, and settings. This is irreversible.'
    )
  ) {
    try {
      await dataManager.deleteAllData()
      await chatStore.refreshChatList()
      await chatStore.prepareNewChat()
      showSuccessToast('All data has been deleted.')
    } catch (error) {
      console.error('Failed to delete all data:', error)
      showErrorToast('Could not delete all data.')
    }
  }
}
</script>

<style scoped>
.import-export-panel {
  padding: 24px;
}
.section {
  margin-bottom: 24px;
  padding-bottom: 24px;
  border-bottom: 1px solid var(--border-color);
}
.section:last-child {
  border-bottom: none;
  margin-bottom: 6px;
  padding-bottom: 6px;
}
h3 {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-color);
}
p {
  font-size: 14px;
  color: var(--text-light);
  margin-bottom: 12px;
}
.action-btn {
  background-color: var(--primary-color);
  color: white;
  border: none;
  padding: 8px 16px;
  border-radius: var(--border-radius);
  cursor: pointer;
  transition: var(--transition);
}
.action-btn:hover {
  background-color: var(--primary-dark);
}
.danger-zone {
  margin-bottom: 24px;
  padding-bottom: 24px;
  border-bottom: 1px solid var(--border-color);
}
.danger-btn {
  background-color: var(--danger-color);
  color: white;
  border: none;
  padding: 8px 16px;
  border-radius: var(--border-radius);
  cursor: pointer;
  transition: var(--transition);
}
.danger-btn:hover {
  background-color: var(--danger-dark);
}
.progress-container {
  margin-top: 16px;
}
.progress-container progress {
  width: 100%;
}
</style>
