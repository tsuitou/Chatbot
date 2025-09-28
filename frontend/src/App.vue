<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import SidePanel from './components/SidePanel.vue'
import ChatWindow from './components/ChatWindow.vue'
import InputArea from './components/InputArea.vue'
import SettingsModal from './components/SettingsModal.vue'
import DataManagementModal from './components/DataManagementModal.vue'
import DebugPanel from './components/DebugPanel.vue'
import { useChatStore } from './stores/chat'
import { useChatConfigStore } from './stores/chatConfig'
import { getModels, getDefaultModel } from './services/api'
import { connectSocket } from './services/socket'
import { showErrorToast } from './services/notification'
import { DEBUG_PANEL_ENABLED } from './services/env'

const chatStore = useChatStore()
const chatConfigStore = useChatConfigStore()

const isSettingsModalOpen = ref(false)
const isDataModalOpen = ref(false)
const isDebugPanelEnabled = DEBUG_PANEL_ENABLED

const handleBeforeUnload = () => {
  if (chatStore.isGenerating) {
    void chatStore.cancelGeneration()
  }
}

onMounted(async () => {
  window.addEventListener('beforeunload', handleBeforeUnload)
  connectSocket()
  try {
    await chatStore.initializeApp()
    const availableModels = await getModels()
    if (!availableModels || availableModels.length === 0) {
      throw new Error('No available models found.')
    }
    chatStore.setAvailableModels(availableModels)
    const preferredDefaultModel = await getDefaultModel()
    let defaultModel = availableModels[0]
    if (availableModels.includes(preferredDefaultModel)) {
      defaultModel = preferredDefaultModel
    }
    chatStore.setDefaultModel(defaultModel)
    chatStore.setActiveModel(defaultModel)
    chatConfigStore.prepareForNewChat({
      systemPrompt: chatStore.currentRequestConfig.systemInstruction || '',
    })
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
