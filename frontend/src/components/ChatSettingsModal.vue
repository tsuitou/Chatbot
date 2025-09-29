<template>
  <div
    class="modal-overlay"
    @mousedown.self="handleOverlayMouseDown"
    @mouseup.self="handleOverlayMouseUp"
    @mouseleave="handleOverlayMouseLeave"
  >
    <div class="modal-content">
      <div class="modal-header">
        <h2>Chat Settings</h2>
        <button class="close-button" type="button" @click="closeModal">
          <font-awesome-icon icon="times" />
        </button>
      </div>
      <div class="modal-body">
        <section v-if="!hasActiveChat" class="info-banner">
          <font-awesome-icon icon="circle-info" />
          <p>
            Settings will be saved together with the chat after the first
            message is sent. Until then they remain local to this page.
          </p>
        </section>
        <form class="settings-form" @submit.prevent="handleSave">
          <div class="settings-grid">
            <div class="settings-column">
              <fieldset class="form-section">
                <legend class="field-legend">System Instruction</legend>
                <label class="form-label" for="chat-system-prompt"
                  >System Prompt</label
                >
                <textarea
                  id="chat-system-prompt"
                  v-model="form.systemPrompt"
                  class="textarea-input"
                  rows="6"
                  placeholder="Custom instructions for the assistant"
                ></textarea>
              </fieldset>
              <fieldset class="form-section">
                <legend class="field-legend">Response Transforms</legend>
                <div class="transform-header">
                  <label class="form-label" for="response-transforms"
                    >Replacement / Removal Rules</label
                  >
                  <p class="form-hint">
                    One rule per line. Quotes are required around the target
                    text.
                  </p>
                </div>
                <textarea
                  id="response-transforms"
                  v-model="form.transformScript"
                  class="textarea-input"
                  rows="6"
                  placeholder='replace "from" -> "to"&#10;remove "literal"'
                ></textarea>
                <span
                  class="transform-status"
                  :class="`is-${transformStatus.state}`"
                  role="status"
                  aria-live="polite"
                >
                  <font-awesome-icon :icon="transformStatus.icon" />
                  <span class="transform-status-text">
                    {{ transformStatus.message }}
                    <span
                      v-if="transformStatus.hint"
                      class="transform-status-hint"
                    >
                      {{ transformStatus.hint }}
                    </span>
                  </span>
                </span>
                <ul v-if="transformErrors.length" class="error-list">
                  <li v-for="error in transformErrors" :key="error.line">
                    Line {{ error.line }}: {{ error.content }}
                  </li>
                </ul>
              </fieldset>
            </div>
            <div class="settings-column">
              <fieldset class="form-section auto-message-section">
                <legend>Auto Inserted Messages</legend>
                <p class="form-hint auto-message-hint">
                  Configure helper messages that are injected before or after
                  the prompt when sending. Each slot supports up to two
                  messages, including optional attachments.
                </p>
                <div
                  v-for="group in autoMessageGroups"
                  :key="group.location"
                  class="auto-group"
                >
                  <div class="auto-group-header">
                    <h4>{{ group.title }}</h4>
                    <button
                      type="button"
                      class="text-button"
                      :disabled="autoMessages[group.location].length >= 2"
                      @click="addAutoMessage(group.location)"
                    >
                      <font-awesome-icon icon="plus" />
                      Add Message
                    </button>
                  </div>
                  <p
                    v-if="autoMessages[group.location].length === 0"
                    class="auto-empty"
                  >
                    No messages configured.
                  </p>
                  <div
                    v-for="(entry, index) in autoMessages[group.location]"
                    :key="entry.id"
                    class="auto-message-card"
                  >
                    <div class="auto-message-header">
                      <button
                        type="button"
                        class="collapse-button"
                        @click="toggleAutoMessage(entry)"
                      >
                        <font-awesome-icon
                          :icon="
                            entry.isExpanded ? 'chevron-up' : 'chevron-down'
                          "
                        />
                      </button>
                      <span class="auto-message-summary"
                        >Message {{ index + 1 }} -
                        {{ entry.role || 'user' }}</span
                      >
                      <button
                        type="button"
                        class="icon-button"
                        title="Remove message"
                        @click="removeAutoMessage(group.location, index)"
                      >
                        <font-awesome-icon icon="trash" />
                      </button>
                    </div>
                    <div v-if="entry.isExpanded" class="auto-message-body">
                      <label
                        class="form-label"
                        :for="`auto-role-${group.location}-${entry.id}`"
                        >Role</label
                      >
                      <select
                        :id="`auto-role-${group.location}-${entry.id}`"
                        v-model="entry.role"
                        class="select-input"
                      >
                        <option
                          v-for="role in AUTO_ROLES"
                          :key="role"
                          :value="role"
                        >
                          {{ role }}
                        </option>
                      </select>
                      <label
                        class="form-label"
                        :for="`auto-text-${group.location}-${entry.id}`"
                        >Message</label
                      >
                      <textarea
                        :id="`auto-text-${group.location}-${entry.id}`"
                        v-model="entry.text"
                        class="textarea-input"
                        rows="4"
                        placeholder="Enter message contents"
                      ></textarea>
                      <div
                        class="auto-attachments"
                        :class="{ 'is-dragging': entry.dragCounter > 0 }"
                        @dragenter.prevent="onAutoDragEnter(entry)"
                        @dragover.prevent
                        @dragleave.prevent="onAutoDragLeave(entry)"
                        @drop.prevent="onAutoDrop(entry, $event)"
                      >
                        <div
                          v-if="entry.dragCounter > 0"
                          class="auto-attachments-overlay"
                        >
                          Drop files here
                        </div>
                        <template v-if="entry.bucket.items.length">
                          <div
                            v-for="file in entry.bucket.items"
                            :key="file.id"
                            class="attachment-row"
                          >
                            <font-awesome-icon icon="paperclip" />
                            <div class="attachment-info">
                              <span class="attachment-name">{{
                                file.name
                              }}</span>
                              <span class="attachment-size">{{
                                formatSize(file.size)
                              }}</span>
                            </div>
                            <button
                              type="button"
                              class="icon-button"
                              title="Remove attachment"
                              @click="entry.bucket.remove(file.id)"
                            >
                              <font-awesome-icon icon="times" />
                            </button>
                          </div>
                        </template>
                        <p v-else class="auto-empty-attachments">
                          No attachments.
                        </p>
                        <p class="auto-attachments-note">
                          Drag & drop files (max {{ autoAttachmentLimitLabel }})
                        </p>
                      </div>
                      <div class="attachment-actions">
                        <input
                          :id="`auto-upload-${group.location}-${entry.id}`"
                          class="sr-only"
                          type="file"
                          multiple
                          @change="
                            onAutoAttachmentChange(
                              group.location,
                              entry,
                              $event
                            )
                          "
                        />
                        <label
                          class="attachment-upload-button"
                          :for="`auto-upload-${group.location}-${entry.id}`"
                        >
                          <font-awesome-icon icon="paperclip" />
                          Add Attachment
                        </label>
                      </div>
                    </div>
                  </div>
                </div>
              </fieldset>
            </div>
          </div>
        </form>
      </div>
      <div class="modal-footer">
        <button class="secondary-button" type="button" @click="closeModal">
          Cancel
        </button>
        <button class="primary-button" type="button" @click="handleSave">
          Save
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, reactive, ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { v4 as uuidv4 } from 'uuid'

import { useChatConfigStore } from '../stores/chatConfig'
import { useChatStore } from '../stores/chat'
import {
  createAttachmentBucket,
  cloneAttachment,
} from '../services/attachments'
import { parseTransformScript } from '../services/responseTransforms'
import { showSuccessToast, showErrorToast } from '../services/notification'

const emit = defineEmits(['close', 'save'])

const props = defineProps({
  hasActiveChat: {
    type: Boolean,
    default: false,
  },
  initialTitle: {
    type: String,
    default: '',
  },
})

const chatConfigStore = useChatConfigStore()
const chatStore = useChatStore()

const activeSettings = computed(() => chatConfigStore.activeSettings)

const form = reactive({
  title: props.initialTitle,
  systemPrompt: '',
  transformScript: '',
})

const transformAnalysis = computed(() => {
  const source =
    typeof form.transformScript === 'string' ? form.transformScript : ''
  const trimmed = source.trim()
  if (!trimmed) {
    return {
      state: 'neutral',
      rules: [],
      errors: [],
    }
  }
  const { rules, errors } = parseTransformScript(source)
  return {
    state: errors.length ? 'invalid' : 'valid',
    rules,
    errors,
  }
})

const transformStatus = computed(() => {
  const analysis = transformAnalysis.value
  if (analysis.state === 'neutral') {
    return {
      state: 'neutral',
      icon: 'circle-info',
      message: 'No rules defined',
      hint: 'Add replace/remove lines to preview the outcome.',
    }
  }
  if (analysis.state === 'invalid') {
    const issueCount = analysis.errors.length
    const firstLine = analysis.errors[0]?.line
    return {
      state: 'invalid',
      icon: 'triangle-exclamation',
      message:
        issueCount === 1 ? '1 issue detected' : `${issueCount} issues detected`,
      hint: firstLine ? `First issue on line ${firstLine}` : '',
    }
  }
  const ruleCount = analysis.rules.length
  const ruleLabel = ruleCount === 1 ? '1 rule' : `${ruleCount} rules`
  return {
    state: 'valid',
    icon: 'circle-check',
    message: `Valid DSL (${ruleLabel})`,
    hint: 'Transforms apply in listed order.',
  }
})

const transformErrors = computed(() => transformAnalysis.value.errors)

const autoMessages = reactive({
  pre: [],
  post: [],
})

const autoMessageGroups = computed(() => [
  { location: 'pre', title: 'Before Prompt' },
  { location: 'post', title: 'After Prompt' },
])

const AUTO_ROLES = Object.freeze(['user', 'model'])
const AUTO_ATTACHMENT_MAX_FILE_SIZE = 8 * 1024 * 1024

const isOverlayMouseDown = ref(false)
const shouldCancelOverlayClose = ref(false)

const handleGlobalMouseUp = () => {
  if (!isOverlayMouseDown.value) return
  isOverlayMouseDown.value = false
  shouldCancelOverlayClose.value = false
}

function createAutoMessageEntry(initial = {}) {
  const bucket = createAttachmentBucket({
    defaultProviderId: () => chatStore.composerState.providerId,
    allowRemoteUpload: false,
    maxFileSize: AUTO_ATTACHMENT_MAX_FILE_SIZE,
  })
  const attachments = Array.isArray(initial.attachments)
    ? initial.attachments.map(cloneAttachment)
    : []
  bucket.replaceAll(attachments)
  return reactive({
    id: initial.id || uuidv4(),
    role: AUTO_ROLES.includes((initial.role || '').toLowerCase())
      ? initial.role.toLowerCase()
      : 'user',
    text: initial.text || '',
    bucket,
    isExpanded: true,
    dragCounter: 0,
  })
}

function setAutoMessages(location, list) {
  const target = autoMessages[location]
  target.forEach((entry) => entry.bucket.clear())
  target.splice(0, target.length)
  ;(Array.isArray(list) ? list : []).forEach((item) => {
    target.push(createAutoMessageEntry(item))
  })
}

const hydrateFromStore = () => {
  form.systemPrompt = activeSettings.value.systemPrompt || ''
  form.transformScript =
    activeSettings.value.transformSource ||
    chatConfigStore.getTransformSource(chatConfigStore.activeChatId) ||
    ''

  const currentAuto = chatConfigStore.getAutoMessages(
    chatConfigStore.activeChatId
  )
  setAutoMessages('pre', currentAuto.pre)
  setAutoMessages('post', currentAuto.post)
}

onMounted(() => {
  hydrateFromStore()
  window.addEventListener('mouseup', handleGlobalMouseUp)
})

watch(
  activeSettings,
  () => {
    hydrateFromStore()
  },
  { deep: true }
)

watch(
  () => props.initialTitle,
  (next) => {
    form.title = next || ''
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  window.removeEventListener('mouseup', handleGlobalMouseUp)
})

const closeModal = () => {
  emit('close')
}

function collectAutoMessages(location) {
  return autoMessages[location].map((entry, index) => ({
    id: entry.id,
    role: AUTO_ROLES.includes((entry.role || '').toLowerCase())
      ? entry.role.toLowerCase()
      : 'user',
    text: entry.text || '',
    attachments: entry.bucket.list().map(cloneAttachment),
    position: index,
    location,
  }))
}

function addAutoMessage(location) {
  if (autoMessages[location].length >= 2) return
  autoMessages[location].push(createAutoMessageEntry())
}

function removeAutoMessage(location, index) {
  const target = autoMessages[location]
  if (!target[index]) return
  target[index].bucket.clear()
  target.splice(index, 1)
}

function toggleAutoMessage(entry) {
  entry.isExpanded = !entry.isExpanded
}

function handleOverlayMouseDown(event) {
  if (event.target !== event.currentTarget) return
  isOverlayMouseDown.value = true
  shouldCancelOverlayClose.value = false
}

function handleOverlayMouseUp(event) {
  if (event.target !== event.currentTarget) return
  if (!isOverlayMouseDown.value) return
  const shouldClose = !shouldCancelOverlayClose.value
  isOverlayMouseDown.value = false
  shouldCancelOverlayClose.value = false
  if (shouldClose) {
    closeModal()
  }
}

function handleOverlayMouseLeave(event) {
  if (!isOverlayMouseDown.value) return
  const next = event.relatedTarget
  if (next && event.currentTarget.contains(next)) {
    return
  }
  shouldCancelOverlayClose.value = true
}

function onAutoAttachmentChange(location, entry, event) {
  const files = event.target.files
  if (!files || !files.length) return
  entry.bucket.addFiles(files, {
    providerId: chatStore.composerState.providerId,
  })
  event.target.value = ''
}

function onAutoDragEnter(entry) {
  entry.dragCounter += 1
}

function onAutoDragLeave(entry) {
  entry.dragCounter = Math.max(0, entry.dragCounter - 1)
}

function onAutoDrop(entry, event) {
  entry.dragCounter = 0
  const files = event.dataTransfer?.files
  if (!files || !files.length) return
  entry.bucket.addFiles(files, {
    providerId: chatStore.composerState.providerId,
  })
}

function formatSize(bytes) {
  if (!bytes) return '0 KB'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const autoAttachmentLimitLabel = computed(() =>
  formatSize(AUTO_ATTACHMENT_MAX_FILE_SIZE)
)

const handleSave = async () => {
  chatConfigStore.updateSystemPrompt(form.systemPrompt)
  chatConfigStore.updateTransformSource(form.transformScript)

  const preDrafts = collectAutoMessages('pre')
  const postDrafts = collectAutoMessages('post')
  chatConfigStore.updateAutoMessages('pre', preDrafts)
  chatConfigStore.updateAutoMessages('post', postDrafts)

  try {
    if (chatConfigStore.activeChatId) {
      await chatConfigStore.persistSettings(chatConfigStore.activeChatId)
      await chatConfigStore.persistAutoMessages(chatConfigStore.activeChatId)
    }

    emit('save', {
      ...form,
      autoMessages: { pre: preDrafts, post: postDrafts },
      pendingPersistence: !props.hasActiveChat,
    })
    showSuccessToast('Changes saved.')
    emit('close')
  } catch (error) {
    console.error('Failed to save chat settings:', error)
    showErrorToast('Failed to save chat settings. Please try again.')
  }
}
</script>

<style scoped>
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background-color: rgba(0, 0, 0, 0.6);
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
  gap: 24px;
}

.info-banner {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  padding: 12px 16px;
  border-radius: var(--border-radius);
  background-color: var(--primary-light);
  color: var(--text-color);
  font-size: 14px;
}

.info-banner svg {
  font-size: 18px;
  color: var(--primary-color);
  margin-top: 2px;
}

.settings-form {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.settings-grid {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

@media (min-width: 960px) {
  .settings-grid {
    flex-direction: row;
  }
}

.settings-column {
  display: flex;
  flex-direction: column;
  gap: 24px;
  flex: 1;
}

.form-section {
  border: 1px solid var(--border-color);
  border-radius: var(--border-radius);
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.form-section legend {
  font-weight: 600;
  color: var(--text-color);
}

.form-label {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-light);
}

.text-input,
.textarea-input,
.select-input {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--border-color);
  border-radius: var(--border-radius);
  font-family: inherit;
  font-size: 14px;
  line-height: 1.5;
  color: var(--text-color);
  background-color: var(--bg-light);
}

.select-input {
  padding: 8px 10px;
}

.textarea-input {
  resize: vertical;
  min-height: 120px;
}

.form-hint {
  font-size: 13px;
  color: var(--text-light);
}

.transform-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.transform-status {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid var(--border-color);
  background-color: var(--bg-light);
  color: var(--text-light);
  transition: var(--transition);
}

.transform-status.is-valid {
  border-color: rgba(16, 185, 129, 0.4);
  background-color: rgba(16, 185, 129, 0.12);
  color: var(--success-color);
}

.transform-status.is-invalid {
  border-color: rgba(239, 68, 68, 0.4);
  background-color: rgba(239, 68, 68, 0.12);
  color: var(--danger-dark);
}

.transform-status.is-neutral {
  border-color: var(--border-color);
  background-color: var(--bg-light);
  color: var(--text-light);
}

.transform-status-text {
  display: flex;
  flex-direction: column;
  line-height: 1.25;
}

.transform-status-hint {
  font-size: 12px;
  color: inherit;
  opacity: 0.85;
}

.error-list {
  list-style: disc;
  padding-left: 20px;
  color: var(--danger-color);
  font-size: 13px;
}

.field-legend {
  font-weight: 600;
  color: var(--text-color);
  padding: 0 6px;
}

.auto-message-section {
  gap: 18px;
}

.auto-message-hint {
  margin-bottom: 8px;
}

.auto-group {
  display: flex;
  flex-direction: column;
  gap: 12px;
  border-top: 1px dashed var(--border-color);
  padding-top: 12px;
}

.auto-group:first-of-type {
  border-top: none;
  padding-top: 0;
}

.auto-group-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.auto-group-header h4 {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-color);
}

.text-button {
  background: none;
  border: none;
  color: var(--primary-color);
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}

.text-button:disabled {
  color: var(--text-light);
  cursor: not-allowed;
}

.auto-empty {
  font-size: 13px;
  color: var(--text-light);
}

.auto-message-card {
  border: 1px solid var(--border-color);
  border-radius: var(--border-radius);
  overflow: hidden;
}

.auto-message-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  background-color: var(--bg-light);
  gap: 8px;
}

.collapse-button {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-light);
  display: flex;
  align-items: center;
}

.auto-message-summary {
  flex: 1;
  font-size: 14px;
  color: var(--text-color);
}

.icon-button {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-light);
  display: flex;
  align-items: center;
}

.auto-message-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
}

.auto-attachments {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px dashed var(--border-color);
  border-radius: var(--border-radius);
  background-color: var(--bg-light);
  transition:
    border-color 0.2s ease,
    background-color 0.2s ease;
}

.auto-attachments.is-dragging {
  border-color: var(--primary-color);
  background-color: rgba(33, 150, 243, 0.08);
}

.auto-attachments-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: rgba(0, 0, 0, 0.4);
  color: #fff;
  font-weight: 600;
  border-radius: inherit;
  pointer-events: none;
  z-index: 1;
}

.auto-empty-attachments {
  font-size: 13px;
  color: var(--text-light);
}

.auto-attachments-note {
  font-size: 12px;
  color: var(--text-light);
}

.attachment-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--border-color);
  border-radius: var(--border-radius);
  background-color: var(--bg-light);
}

.attachment-info {
  flex: 1;
  display: flex;
  flex-direction: column;
  font-size: 13px;
}

.attachment-name {
  color: var(--text-color);
}

.attachment-size {
  color: var(--text-light);
}

.attachment-actions {
  display: flex;
  justify-content: flex-start;
}

.attachment-upload-button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px dashed var(--border-color);
  border-radius: var(--border-radius);
  padding: 6px 12px;
  cursor: pointer;
  color: var(--primary-color);
  font-size: 13px;
}

.attachment-upload-button:hover {
  background-color: var(--primary-light);
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  padding: 16px 24px;
  border-top: 1px solid var(--border-color);
}

.primary-button {
  background-color: var(--primary-color);
  color: #ffffff;
  border: none;
  padding: 10px 18px;
  border-radius: var(--border-radius);
  cursor: pointer;
  font-weight: 600;
}

.primary-button:hover {
  background-color: var(--primary-dark);
}

.secondary-button {
  background: none;
  border: 1px solid var(--border-color);
  padding: 10px 18px;
  border-radius: var(--border-radius);
  cursor: pointer;
  color: var(--text-color);
}

.secondary-button:hover {
  background-color: var(--bg-light);
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
</style>
