<template>
  <main class="chat-window">
    <div class="chat-header">
      <h2
        class="chat-title"
        :class="{ editing: isEditingTitle, disabled: !isChatOpen }"
        @click="startEditingTitle"
      >
        <span v-if="!isEditingTitle" :class="{ placeholder: !isChatOpen }">
          {{ headerTitle }}
        </span>
        <input
          v-else
          ref="titleInput"
          v-model="editingTitle"
          class="title-input"
          @blur="saveTitle"
          @keydown.enter="saveTitle"
          @keydown.esc="cancelEditingTitle"
        />
        <font-awesome-icon
          v-if="isChatOpen && !isEditingTitle"
          icon="pen-to-square"
          class="edit-icon"
        />
      </h2>
      <div class="chat-actions">
        <button
          class="action-button"
          :class="{
            'bookmark-button': isChatOpen && activeChat?.isBookmarked,
            disabled: !isChatOpen,
          }"
          :title="bookmarkTitle"
          :disabled="!isChatOpen"
          @click="toggleBookmark"
        >
          <font-awesome-icon
            :icon="
              isChatOpen && activeChat?.isBookmarked
                ? 'bookmark'
                : ['far', 'bookmark']
            "
          />
        </button>
        <button
          class="action-button"
          :title="chatSettingsTitle"
          @click="openChatSettings"
        >
          <font-awesome-icon icon="sliders" />
        </button>
        <button
          class="action-button"
          :class="{ disabled: !isChatOpen }"
          :title="duplicateTitle"
          :disabled="!isChatOpen"
          @click="duplicateChat"
        >
          <font-awesome-icon icon="copy" />
        </button>
        <button
          class="action-button"
          :class="{ disabled: !isChatOpen }"
          :title="downloadTitle"
          :disabled="!isChatOpen"
          @click="downloadChat"
        >
          <font-awesome-icon icon="download" />
        </button>
      </div>
    </div>
    <div v-if="isChatOpen" class="chat-body">
      <div ref="messageList" class="message-list">
        <Message
          v-for="group in messageGroups"
          :key="group.id"
          :group="group"
          @edit="handleEdit"
          @delete="handleDelete"
          @resend="handleResend"
        />
      </div>
      <PreviewPanel v-if="isPreviewOpen" />
    </div>
    <div v-else class="welcome-view">
      <div class="logo">
        <font-awesome-icon icon="comments" />
      </div>
      <h1>Chatbot</h1>
      <p>Send a message to start a new chat.</p>
    </div>
    <ChatSettingsModal
      v-if="isChatSettingsOpen"
      :has-active-chat="isChatOpen"
      :initial-title="isChatOpen ? (activeChat?.title ?? '') : ''"
      @close="closeChatSettings"
    />
  </main>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted } from 'vue'
import { useChatStore } from '../stores/chat'
import { useDisplayStore } from '../stores/display'
import Message from './Message.vue'
import PreviewPanel from './PreviewPanel.vue'
import ChatSettingsModal from './ChatSettingsModal.vue'
const chatStore = useChatStore()
const displayStore = useDisplayStore()

const messageList = ref(null)
const titleInput = ref(null)
const isEditingTitle = ref(false)
const editingTitle = ref('')
const isChatSettingsOpen = ref(false)

const activeChat = computed(() => chatStore.activeChat)
const isChatOpen = computed(() => chatStore.isChatOpen)
const messageGroups = computed(() => displayStore.messageGroups)
const isPreviewOpen = computed(() => displayStore.isPreviewOpen)
const scrollSignal = computed(() => chatStore.scrollSignal)
const headerTitle = computed(
  () => activeChat.value?.title?.trim() || 'New Chat'
)
const bookmarkTitle = computed(() =>
  isChatOpen.value
    ? activeChat.value?.isBookmarked
      ? 'Remove Bookmark'
      : 'Bookmark'
    : 'Bookmark (available after chat is saved)'
)
const duplicateTitle = computed(() =>
  isChatOpen.value
    ? 'Duplicate Chat'
    : 'Duplicate Chat (available after chat is saved)'
)
const downloadTitle = computed(() =>
  isChatOpen.value
    ? 'Download Chat'
    : 'Download Chat (available after chat is saved)'
)
const chatSettingsTitle = 'Chat Settings'

const updateDocumentTitle = () => {
  const title =
    isChatOpen.value && activeChat.value?.title?.trim()
      ? activeChat.value.title.trim()
      : 'Chatbot'
  document.title = title
}

watch(
  () => [isChatOpen.value, activeChat.value?.title],
  () => {
    updateDocumentTitle()
  },
  { immediate: true }
)

onMounted(() => {
  displayStore.initializeWatcher()
})

watch(scrollSignal, () => {
  nextTick(() => {
    scrollToBottom()
  })
})

const scrollToBottom = () => {
  if (messageList.value) {
    const el = messageList.value
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight
      el.scrollTo({
        top: el.scrollHeight,
        behavior: 'auto',
      })
    })
  }
}

const startEditingTitle = () => {
  if (!activeChat.value) return
  isEditingTitle.value = true
  editingTitle.value = activeChat.value.title
  nextTick(() => {
    titleInput.value?.focus()
  })
}

const saveTitle = () => {
  if (isEditingTitle.value && activeChat.value) {
    if (
      editingTitle.value.trim() &&
      editingTitle.value !== activeChat.value.title
    ) {
      chatStore.updateTitle(editingTitle.value)
    }
  }
  isEditingTitle.value = false
}

const cancelEditingTitle = () => {
  isEditingTitle.value = false
}

const toggleBookmark = () => {
  if (activeChat.value) {
    chatStore.toggleBookmark(activeChat.value.id)
  }
}

const duplicateChat = () => {
  if (activeChat.value) {
    chatStore.duplicateChat(activeChat.value.id)
  }
}

const downloadChat = async () => {
  if (activeChat.value) {
    await chatStore.downloadChatAsHTML()
  }
}

const openChatSettings = () => {
  isChatSettingsOpen.value = true
}

const closeChatSettings = () => {
  isChatSettingsOpen.value = false
}

const handleEdit = (messageId) => {
  if (!messageId) return
  chatStore.startEditing(messageId)
}

const handleDelete = (messageId) => {
  if (!messageId) return
  chatStore.deleteMessage(messageId)
}

const handleResend = (messageId) => {
  if (!messageId) return
  chatStore.resendMessage(messageId)
}
</script>

<style scoped>
.chat-window {
  flex-grow: 1;
  display: flex;
  flex-direction: column;
  background-color: var(--bg-color);
  min-height: 0;
}

.chat-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 24px;
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
}

.chat-title {
  font-size: 16px;
  font-weight: 500;
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  flex-grow: 1;
  color: var(--text-color);
}

.chat-title.disabled {
  cursor: default;
  color: var(--text-light);
}

.chat-title span {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  height: 22px;
}

.chat-title .placeholder {
  color: var(--text-light);
}

.title-input {
  font-family: inherit;
  font-size: inherit;
  font-weight: inherit;
  white-space: nowrap;
  color: inherit;
  border: none;
  outline: none;
  background-color: transparent;
  width: 100%;
  height: 22px;
}

.edit-icon {
  color: var(--text-light);
  cursor: pointer;
  font-size: 14px;
  margin-left: 4px;
}

.chat-actions {
  display: flex;
  gap: 16px;
}

.action-button {
  background: none;
  border: none;
  font-size: 18px;
  color: var(--text-light);
  cursor: pointer;
}

.action-button.disabled,
.action-button:disabled,
.bookmark-button.disabled,
.bookmark-button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.bookmark-button {
  background: none;
  border: none;
  font-size: 18px;
  color: var(--warning-color);
  cursor: pointer;
}

.chat-body {
  flex-grow: 1;
  display: flex;
  min-height: 0;
}

.message-list {
  flex-grow: 1;
  padding: 24px;
  overflow-y: auto;
  overflow-x: hidden;
  display: flex;
  flex-direction: column;
  gap: 24px;
  background-color: var(--bg-gray);
}

.welcome-view {
  flex-grow: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  background-color: var(--bg-gray);
  padding: 24px;
  text-align: center;
}

.logo {
  font-size: 48px;
  color: var(--text-light);
  margin-bottom: 16px;
}

.welcome-view h1 {
  font-size: 24px;
  font-weight: 600;
  margin-bottom: 8px;
  color: var(--text-color);
}

.welcome-view p {
  font-size: 16px;
}
</style>
