<template>
  <div
    class="modal-overlay"
    @mousedown.self="handleOverlayMouseDown"
    @mouseup.self="handleOverlayMouseUp"
    @mouseleave="handleOverlayMouseLeave"
  >
    <div class="modal-content">
      <div class="modal-header">
        <h2>Settings</h2>
        <button class="close-button" @click="closeModal">
          <font-awesome-icon icon="times" />
        </button>
      </div>
      <div class="modal-body">
        <form class="settings-form" @submit.prevent>
          <fieldset class="form-section">
            <legend class="field-legend">Model Selection</legend>
            <label class="form-label" for="model-select-modal"
              >Configuration for Model</label
            >
            <select
              id="model-select-modal"
              v-model="selectedModel"
              class="select-input"
            >
              <option
                v-for="model in availableModels"
                :key="model"
                :value="model"
              >
                {{ model }}
              </option>
            </select>
          </fieldset>

          <fieldset class="form-section">
            <legend class="field-legend">Generation Parameters</legend>
            <div class="settings-grid">
              <div class="form-field">
                <label class="form-label" for="temperature">Temperature</label>
                <input
                  id="temperature"
                  v-model.number.lazy="currentSettings.parameters.temperature"
                  type="number"
                  class="text-input"
                  placeholder="Default"
                  step="any"
                />
              </div>
              <div class="form-field">
                <label class="form-label" for="top-p">Top-P</label>
                <input
                  id="top-p"
                  v-model.number.lazy="currentSettings.parameters.topP"
                  type="number"
                  class="text-input"
                  placeholder="Default"
                  step="any"
                />
              </div>
              <div class="form-field">
                <label class="form-label" for="max-output-tokens">
                  Max Output Tokens
                  <span class="form-hint"
                    >(1 ~ {{ configRanges.maxOutputTokens?.max }})</span
                  >
                </label>
                <input
                  id="max-output-tokens"
                  v-model.number.lazy="
                    currentSettings.parameters.maxOutputTokens
                  "
                  type="number"
                  class="text-input"
                  placeholder="Default"
                />
              </div>
              <div class="form-field">
                <label class="form-label" for="thinking-budget">
                  Thinking Budget
                  <span class="form-hint">( {{ thinkingBudgetRange }} )</span>
                </label>
                <input
                  id="thinking-budget"
                  v-model.number.lazy="
                    currentSettings.parameters.thinkingBudget
                  "
                  type="number"
                  class="text-input"
                  placeholder="Default"
                  :disabled="thinkingBudgetRange === '(N/A)'"
                />
              </div>
            </div>
            <label v-if="thinkingBudgetRange !== '(N/A)'" class="form-option">
              <input
                v-model="currentSettings.options.includeThoughts"
                type="checkbox"
              />
              Include Thoughts
            </label>
          </fieldset>

          <fieldset class="form-section">
            <legend class="field-legend">System Prompt</legend>
            <label class="form-label" for="system-prompt"
              >Custom Instruction</label
            >
            <textarea
              id="system-prompt"
              v-model="currentSettings.systemPrompt"
              class="textarea-input"
              rows="6"
              placeholder="Enter custom system instructions..."
            ></textarea>
          </fieldset>
        </form>
      </div>
      <div class="modal-footer">
        <button class="secondary-button" type="button" @click="reset">
          Reset
        </button>
        <button class="primary-button" type="button" @click="save">Save</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, onMounted, onBeforeUnmount, computed } from 'vue'
import { useChatStore } from '../stores/chat'
import { getConfigRanges } from '../services/api'
import { showSuccessToast } from '../services/notification'
import {
  createEmptySettings,
  normalizeSettingsEntry,
  cloneSettings,
  serializeSettings,
} from '../services/modelConfig'
import { getDefaultProviderId } from '../services/providers'
const emit = defineEmits(['close'])
const store = useChatStore()

const availableModels = computed(() => store.availableModels)
const allModelSettings = ref({})
const selectedModel = ref('')
const configRanges = ref({})
const thinkingBudgetRange = ref('(N/A)')
const isLoadingRanges = ref(false)
const currentSettings = ref(createEmptySettings())

const isOverlayMouseDown = ref(false)
const shouldCancelOverlayClose = ref(false)

const handleGlobalMouseUp = () => {
  if (!isOverlayMouseDown.value) return
  isOverlayMouseDown.value = false
  shouldCancelOverlayClose.value = false
}

const fallbackProviderId = () =>
  store.composerState.providerId || getDefaultProviderId()

const ensureProvider = (settings) => {
  const next = cloneSettings(settings)
  if (!next.providerId) {
    next.providerId = fallbackProviderId()
  }
  return next
}

const patchParameters = (updates) => {
  currentSettings.value = {
    ...currentSettings.value,
    parameters: {
      ...currentSettings.value.parameters,
      ...updates,
    },
  }
}

const persistCurrentSettings = (modelName) => {
  if (!modelName) return
  allModelSettings.value = {
    ...allModelSettings.value,
    [modelName]: cloneSettings(currentSettings.value),
  }
}

const loadSettingsForModel = (modelName) => {
  if (!modelName) {
    currentSettings.value = ensureProvider(createEmptySettings())
    return
  }
  const stored = allModelSettings.value[modelName]
  if (stored) {
    currentSettings.value = ensureProvider(stored)
  } else {
    currentSettings.value = ensureProvider(createEmptySettings())
  }
}

const fetchConfigRangesForModel = async (modelName) => {
  if (!modelName) {
    configRanges.value = {}
    thinkingBudgetRange.value = '(N/A)'
    return
  }
  isLoadingRanges.value = true
  try {
    configRanges.value = await getConfigRanges(modelName)
    thinkingBudgetRange.value =
      configRanges.value.thinkingBudget?.ranges
        ?.map((range) =>
          typeof range === 'object' ? `${range.min} ~ ${range.max}` : range
        )
        .join(', ') ?? '(N/A)'
  } catch (error) {
    console.error('Failed to fetch config ranges:', error)
    configRanges.value = {}
    thinkingBudgetRange.value = '(N/A)'
  } finally {
    isLoadingRanges.value = false
  }
}

onMounted(() => {
  window.addEventListener('mouseup', handleGlobalMouseUp)
  const stored = JSON.parse(localStorage.getItem('modelSettings') || '{}')
  const normalized = {}
  for (const [modelName, entry] of Object.entries(stored)) {
    normalized[modelName] = normalizeSettingsEntry(entry, {
      fallbackProviderId: fallbackProviderId(),
    })
  }
  allModelSettings.value = normalized

  const modelToShow =
    store.composerState.model || availableModels.value[0] || ''
  selectedModel.value = modelToShow
  loadSettingsForModel(modelToShow)
  fetchConfigRangesForModel(modelToShow)
})

watch(selectedModel, (newModel, oldModel) => {
  if (oldModel && oldModel !== newModel) {
    persistCurrentSettings(oldModel)
  }
  loadSettingsForModel(newModel)
  fetchConfigRangesForModel(newModel)
})

onBeforeUnmount(() => {
  window.removeEventListener('mouseup', handleGlobalMouseUp)
})

watch(
  () => currentSettings.value.parameters.temperature,
  (value) => {
    if (value === undefined || value === null || value === '') return
    const rounded = Math.round(Number(value) * 10) / 10
    if (Number.isFinite(rounded) && rounded !== value) {
      patchParameters({ temperature: rounded })
    }
  }
)

watch(
  () => currentSettings.value.parameters.topP,
  (value) => {
    if (value === undefined || value === null || value === '') return
    const rounded = Math.round(Number(value) * 10) / 10
    if (Number.isFinite(rounded) && rounded !== value) {
      patchParameters({ topP: rounded })
    }
  }
)

watch(
  () => currentSettings.value.parameters.maxOutputTokens,
  (value) => {
    if (value === undefined || value === null || value === '') return
    const rounded = Math.round(Number(value))
    if (Number.isFinite(rounded) && rounded !== value) {
      patchParameters({ maxOutputTokens: rounded })
    }
  }
)

watch(
  () => currentSettings.value.parameters.thinkingBudget,
  (value) => {
    if (value === undefined || value === null || value === '') return
    const rounded = Math.round(Number(value))
    if (Number.isFinite(rounded) && rounded !== value) {
      patchParameters({ thinkingBudget: rounded })
    }
  }
)

const closeModal = () => {
  emit('close')
}

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

const save = () => {
  if (!selectedModel.value) {
    showSuccessToast('Changes saved.')
    emit('close')
    return
  }

  persistCurrentSettings(selectedModel.value)

  const serialized = {}
  for (const [modelName, entry] of Object.entries(allModelSettings.value)) {
    serialized[modelName] = serializeSettings(entry)
  }
  serialized[selectedModel.value] = serializeSettings(currentSettings.value)

  localStorage.setItem('modelSettings', JSON.stringify(serialized))
  store.refreshModelSettings()
  showSuccessToast('Changes saved.')
  emit('close')
}

const reset = () => {
  currentSettings.value = ensureProvider(createEmptySettings())
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
  max-width: 880px;
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
}

.settings-form {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.form-section {
  border: 1px solid var(--border-color);
  border-radius: var(--border-radius);
  padding: 18px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.field-legend {
  font-weight: 600;
  color: var(--text-color);
  padding: 0 6px;
}

.settings-grid {
  display: grid;
  gap: 16px;
}

@media (min-width: 768px) {
  .settings-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

.form-field {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.form-label {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-color);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.form-hint {
  font-size: 12px;
  color: var(--text-light);
  font-weight: 400;
}

.text-input,
.textarea-input,
.select-input {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--border-color);
  border-radius: var(--border-radius);
  font-size: 14px;
  color: var(--text-color);
  background-color: var(--bg-light);
  box-sizing: border-box;
}

.text-input:disabled {
  background-color: var(--bg-gray);
  cursor: not-allowed;
}

.textarea-input {
  resize: vertical;
  min-height: 120px;
}

.form-option {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  color: var(--text-color);
}

.form-option input {
  accent-color: var(--primary-color);
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
</style>
