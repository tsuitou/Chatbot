<template>
  <aside class="side-panel">
    <div class="side-panel-content">
      <div class="top-section">
        <div class="header">
          <div class="header-actions">
            <div class="action-buttons">
              <button
                class="header-button"
                title="Settings"
                @click="emit('open-settings')"
              >
                <font-awesome-icon icon="cog" />
              </button>
              <button
                class="header-button"
                title="Data Management"
                @click="emit('open-data-modal')"
              >
                <font-awesome-icon icon="database" />
              </button>
            </div>
            <div class="action-buttons">
              <span class="toggle-label">Stream</span>
              <label class="toggle-switch">
                <input v-model="streamingEnabled" type="checkbox" />
                <span class="toggle-slider" title="Streaming"></span>
              </label>
            </div>
          </div>
        </div>
        <select v-model="selectedModel" class="model-select">
          <option v-for="model in availableModels" :key="model" :value="model">
            {{ model }}
          </option>
        </select>
        <button class="new-chat-button" @click="prepareNewChat">
          <font-awesome-icon icon="plus" />
          <span>New chat</span>
        </button>
        <div class="search-box">
          <font-awesome-icon icon="search" class="search-icon" />
          <input
            v-model="searchQuery"
            type="text"
            placeholder="Search history..."
            class="search-input"
          />
        </div>
      </div>

      <div class="history-section">
        <div v-if="bookmarkedChats.length > 0" class="history-group">
          <h2 class="history-title">Bookmarks</h2>
          <ul class="history-list">
            <li
              v-for="chat in bookmarkedChats"
              :key="chat.id"
              class="history-item"
              :class="{ active: chat.id === activeChatId }"
              @click="loadChat(chat.id)"
            >
              <font-awesome-icon
                :icon="['fas', 'bookmark']"
                class="bookmark-icon"
              />
              <span class="history-item-title">{{ chat.title }}</span>
              <div class="sidebar-actions">
                <button
                  class="sidebar-action-btn"
                  @click.stop="deleteChat(chat.id)"
                >
                  <font-awesome-icon icon="trash-alt" />
                </button>
              </div>
            </li>
          </ul>
        </div>
        <div class="history-group">
          <h2 class="history-title">History</h2>
          <ul class="history-list">
            <li
              v-for="chat in historyChats"
              :key="chat.id"
              class="history-item"
              :class="{ active: chat.id === activeChatId }"
              @click="loadChat(chat.id)"
            >
              <font-awesome-icon
                :icon="['far', 'comment-dots']"
                class="history-icon"
              />
              <span class="history-item-title">{{ chat.title }}</span>
              <div class="sidebar-actions">
                <button
                  class="sidebar-action-btn"
                  @click.stop="deleteChat(chat.id)"
                >
                  <font-awesome-icon icon="trash-alt" />
                </button>
              </div>
            </li>
          </ul>
        </div>
      </div>
    </div>
  </aside>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useChatStore } from '../stores/chat'
const emit = defineEmits(['open-settings', 'open-data-modal'])
const store = useChatStore()
const searchQuery = ref('')

// --- Computed properties ---
const availableModels = computed(() => store.availableModels)
const sortedChats = computed(() =>
  [...store.chatList].sort(
    (a, b) => (b.lastModified || 0) - (a.lastModified || 0)
  )
)
const bookmarkedChats = computed(() =>
  sortedChats.value.filter(
    (c) =>
      c.isBookmarked &&
      c.title.toLowerCase().includes(searchQuery.value.toLowerCase())
  )
)
const historyChats = computed(() =>
  sortedChats.value.filter(
    (c) =>
      !c.isBookmarked &&
      c.title.toLowerCase().includes(searchQuery.value.toLowerCase())
  )
)
const activeChatId = computed(() => store.activeChat?.id)

const selectedModel = computed({
  get: () => store.composerState.model,
  set: (value) => {
    store.setActiveModel(value)
  },
})

const streamingEnabled = computed({
  get: () => store.composerState.streamingEnabled,
  set: (val) => {
    store.setStreamingEnabled(val)
  },
})

// --- Methods ---
const prepareNewChat = () => store.prepareNewChat()
const loadChat = (chatId) => store.loadChat(chatId)
const deleteChat = (chatId) => {
  if (confirm('Are you sure you want to delete this chat?')) {
    store.deleteChat(chatId)
  }
}
</script>

<style scoped>
.side-panel {
  width: var(--sidebar-width);
  background-color: var(--bg-color);
  border-right: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
}

.side-panel-content {
  padding: 12px;
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow-y: auto;
}

.top-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border-color);
}

.header {
  display: flex;
}

.header-button {
  background: none;
  border: none;
  font-size: 18px;
  color: var(--text-light);
  cursor: pointer;
  padding: 4px;
}

.header-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
}

.action-buttons {
  display: flex;
  gap: 8px;
}

.toggle-label {
  color: var(--text-light);
  font-size: 12px;
  font-weight: normal;
}

.toggle-switch {
  position: relative;
  display: inline-block;
  width: 32px;
  height: 18px;
}

.toggle-switch input {
  opacity: 0;
  width: 0;
  height: 0;
}

.toggle-slider {
  position: absolute;
  cursor: pointer;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: var(--text-light);
  transition: 0.4s;
  border-radius: 20px;
}

.toggle-slider:before {
  position: absolute;
  content: '';
  height: 14px;
  width: 14px;
  left: 2px;
  bottom: 2px;
  background-color: white;
  transition: 0.4s;
  border-radius: 50%;
}

input:checked + .toggle-slider {
  background-color: var(--primary-color);
}

input:focus + .toggle-slider {
  box-shadow: 0 0 1px var(--primary-color);
}

input:checked + .toggle-slider:before {
  transform: translateX(14px);
}

.model-select {
  width: 100%;
  padding: 10px;
  border-radius: var(--border-radius);
  border: 1px solid var(--border-color);
  background-color: var(--bg-color);
  font-size: 15px;
  box-sizing: border-box;
  color: var(--text-color);
}

.new-chat-button {
  width: 100%;
  padding: 8px;
  border-radius: var(--border-radius);
  background-color: var(--primary-color);
  color: white;
  border: none;
  cursor: pointer;
  font-size: 15px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  transition: var(--transition);
}
.new-chat-button:hover {
  background-color: var(--primary-dark);
}

.search-box {
  position: relative;
}

.search-icon {
  position: absolute;
  left: 12px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-light);
}

.search-input {
  width: 100%;
  padding: 10px 10px 10px 36px;
  border-radius: var(--border-radius);
  border: 1px solid var(--border-color);
  background-color: var(--bg-color);
  box-sizing: border-box;
  color: var(--text-color);
}

.history-section {
  flex-grow: 1;
  overflow-y: auto;
  margin-top: 12px;
  display: flex;
  flex-direction: column;
}

.history-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-light);
  padding: 0 8px 4px;
  text-transform: uppercase;
}

.history-list {
  list-style: none;
  padding: 0;
  margin: 0;
}

.history-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 8px;
  border-radius: var(--border-radius);
  cursor: pointer;
  font-size: 14px;
  position: relative;
  color: var(--text-color);
}
.history-item:hover {
  background-color: var(--bg-gray);
}
.history-item.active {
  background-color: var(--primary-light);
  font-weight: 500;
  color: var(--primary-dark);
}

.history-item-title {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sidebar-actions {
  display: none;
  align-items: center;
  gap: 4px;
}

.sidebar-action-btn {
  background: none;
  border: none;
  color: var(--text-light);
  cursor: pointer;
  font-size: 14px;
  transition: var(--transition);
}

.history-item:hover .sidebar-actions {
  display: flex;
}

.sidebar-action-btn:hover {
  color: var(--text-color);
}

.history-icon {
  color: var(--text-light);
}
.bookmark-icon {
  color: var(--warning-color);
}
.history-item.active .history-icon {
  color: var(--primary-dark);
}
</style>
