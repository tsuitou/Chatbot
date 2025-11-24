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

          <fieldset v-if="dynamicParameters.length" class="form-section">
            <legend class="field-legend">Generation Parameters</legend>
            <div class="settings-grid">
              <div
                v-for="param in dynamicParameters"
                :key="param.key"
                class="form-field"
              >
                <label class="form-label" :for="param.key">
                  {{ param.label || param.key }}
                  <span v-if="param.hint" class="form-hint"
                    >({{ param.hint }})</span
                  >
                </label>

                <!-- Numeric Input -->
                <input
                  v-if="param.type === 'number'"
                  :id="param.key"
                  v-model.number.lazy="currentSettings.parameters[param.key]"
                  type="number"
                  class="text-input"
                  :placeholder="
                    param.default !== undefined
                      ? String(param.default)
                      : 'Default'
                  "
                  :step="param.step"
                  :min="param.min"
                  :max="param.max"
                  :disabled="param.disabled"
                />

                <!-- Enum Select -->
                <select
                  v-else-if="param.type === 'enum'"
                  :id="param.key"
                  v-model="currentSettings.parameters[param.key]"
                  class="select-input"
                >
                  <option :value="undefined">Default</option>
                  <option
                    v-for="opt in param.options"
                    :key="opt.value"
                    :value="opt.value"
                  >
                    {{ opt.label }}
                  </option>
                </select>
              </div>
            </div>

            <!-- Explicitly handle 'includeThoughts' if any thinking parameter is present -->
            <label v-if="hasThinkingParameter" class="form-option">
              <input
                v-model="currentSettings.options.includeThoughts"
                type="checkbox"
              />
              Include Thoughts
            </label>
          </fieldset>

          <fieldset v-if="supportsSystemInstruction" class="form-section">
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
    return
  }
  isLoadingRanges.value = true
  try {
    configRanges.value = await getConfigRanges(modelName)
  } catch (error) {
    console.error('Failed to fetch config ranges:', error)
    configRanges.value = {}
  } finally {
    isLoadingRanges.value = false
  }
}

// --- Dynamic Parameters Logic ---

const dynamicParameters = computed(() => {
  const ranges = configRanges.value || {}
  const params = []

  if (ranges.temperature) {
    params.push({
      key: 'temperature',
      label: 'Temperature',
      type: 'number',
      min: ranges.temperature.min,
      max: ranges.temperature.max,
      step: ranges.temperature.step || 0.1,
      hint: `${ranges.temperature.min} - ${ranges.temperature.max}`,
    })
  }

  if (ranges.topP) {
    params.push({
      key: 'topP',
      label: 'Top P',
      type: 'number',
      min: ranges.topP.min,
      max: ranges.topP.max,
      step: ranges.topP.step || 0.01,
      hint: `${ranges.topP.min} - ${ranges.topP.max}`,
    })
  }

  if (ranges.maxOutputTokens) {
    params.push({
      key: 'maxOutputTokens',
      label: 'Max Output Tokens',
      type: 'number',
      min: 1,
      max: ranges.maxOutputTokens.max,
      hint: `1 - ${ranges.maxOutputTokens.max}`,
    })
  }

  if (ranges.thinkingBudget) {
    const r = ranges.thinkingBudget
    let rangeStr = '(N/A)'
    if (r.ranges && Array.isArray(r.ranges)) {
      rangeStr = r.ranges
        .map((x) => (typeof x === 'object' ? `${x.min}-${x.max}` : x))
        .join(', ')
    } else if (r.min !== undefined && r.max !== undefined) {
      const parts = []
      if (r.specialValues && Array.isArray(r.specialValues)) {
        parts.push(...r.specialValues.map((v) => `${v.label} (${v.value})`))
      }
      parts.push(`${r.min} - ${r.max}`)
      rangeStr = parts.join(', ')
    }

    params.push({
      key: 'thinkingBudget',
      label: 'Thinking Budget',
      type: 'number',
      hint: rangeStr,
      disabled: rangeStr === '(N/A)',
    })
  }

  // Check specific keys known to be Enums
  ;['thinkingLevel'].forEach((key) => {
    if (ranges[key] && ranges[key].options) {
      params.push({
        key: key,
        label: 'Thinking Level',
        type: 'enum',
        options: ranges[key].options,
      })
    }
  })

  return params
})

const hasThinkingParameter = computed(() => {
  const ranges = configRanges.value || {}
  return !!(ranges.thinkingBudget || ranges.thinkingLevel)
})

const supportsSystemInstruction = computed(() => {
  const features = configRanges.value?.features
  // Default to true if features not loaded yet or undefined, unless explicitly false
  return features?.systemInstruction !== false
})

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

// Watchers for numeric validation are tricky with dynamic params.
// We can genericize them or just trust v-model.number for now.
// Or iterate dynamicParameters to setup watchers? Vue's watchEffect might be better but complexity increases.
// For now, we rely on v-model.number modifiers and basic input constraints.

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
  flex-direction: row;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 8px;
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
