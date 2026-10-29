<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import SidePanel from './components/SidePanel.vue'
import ChatWindow from './components/ChatWindow.vue'
import InputArea from './components/InputArea.vue'
import SettingsModal from './components/SettingsModal.vue'
import DataManagementModal from './components/DataManagementModal.vue'
import DebugPanel from './components/DebugPanel.vue'
import { useSessionStore } from './stores/session'
import { useModelsStore } from './stores/models'
import { useComposerStore } from './stores/composer'
import { useChatsStore } from './stores/chats'
import { getModels, getDefaultModel } from './services/api'
import { connectSocket } from './services/socket'
import { showErrorToast } from './services/notification'
import { DEBUG_PANEL_ENABLED } from './services/env'

const session = useSessionStore()
const models = useModelsStore()
const composer = useComposerStore()
const chats = useChatsStore()

const isSettingsModalOpen = ref(false)
const isDataModalOpen = ref(false)
const isDebugPanelEnabled = DEBUG_PANEL_ENABLED

const handleBeforeUnload = () => {
  if (session.isGenerating) {
    // IndexedDB cleanup is best-effort during unload; any unfinished model
    // records are reconciled next time the chat is loaded or used.
    void session.cancelGeneration()
  }
}

onMounted(async () => {
  window.addEventListener('beforeunload', handleBeforeUnload)
  connectSocket()
  try {
    await session.initialize()
    const availableModels = await getModels()
    if (!availableModels || availableModels.length === 0) {
      throw new Error('No available models found.')
    }
    models.setAvailableModels(availableModels)
    const preferredDefaultModel = await getDefaultModel()
    const groups = models.availableModels
    const allModels = models.allAvailableModels
    const firstRealGroup =
      groups.find((group) => group.provider !== 'virtual') || groups[0]
    const firstRealModel = firstRealGroup?.models?.[0] || allModels[0]
    const defaultModel = allModels.includes(preferredDefaultModel)
      ? preferredDefaultModel
      : firstRealModel
    const defaultGroup =
      groups.find((group) => group.models?.includes(defaultModel)) ||
      firstRealGroup
    const defaultProviderId = defaultGroup?.provider || null
    models.setDefaultModel(defaultModel)
    composer.applyDefaultModel(models.defaultModel, defaultProviderId)
    await composer.selectModel(defaultModel, defaultProviderId)
    // Same starting state as "New Chat", including the model's default
    // system prompt.
    chats.closeChat()
  } catch (error) {
    console.error('Failed to initialize app state:', error)
    showErrorToast(
      'Failed to initialize the application. Please refresh the page.'
    )
  }
})

onUnmounted(() => {
  window.removeEventListener('beforeunload', handleBeforeUnload)
})

const openSettingsModal = () => (isSettingsModalOpen.value = true)
const closeSettingsModal = () => (isSettingsModalOpen.value = false)
const openDataModal = () => (isDataModalOpen.value = true)
const closeDataModal = () => (isDataModalOpen.value = false)
</script>

<template>
  <div id="app-container">
    <SidePanel
      @open-settings="openSettingsModal"
      @open-data-modal="openDataModal"
    />
    <div class="main-view">
      <ChatWindow />
      <InputArea />
    </div>
    <SettingsModal v-if="isSettingsModalOpen" @close="closeSettingsModal" />
    <DataManagementModal v-if="isDataModalOpen" @close="closeDataModal" />
    <DebugPanel v-if="isDebugPanelEnabled" />
  </div>
</template>

<style scoped>
#app-container {
  display: flex;
  height: 100vh;
  width: 100vw;
  background-color: var(--bg-color);
}

.main-view {
  flex-grow: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
</style>
