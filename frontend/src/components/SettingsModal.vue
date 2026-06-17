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
              :value="selectedModel"
              class="select-input"
              @change="onModelChange"
            >
              <optgroup
                v-for="group in availableModels"
                :key="group.provider"
                :label="group.label"
              >
                <option
                  v-for="model in group.models"
                  :key="model"
                  :value="model"
                  :data-provider-id="group.provider"
                >
                  {{ model }}
                </option>
              </optgroup>
            </select>
          </fieldset>

          <fieldset v-if="supportsProviderRouting" class="form-section">
            <legend class="field-legend">Provider Routing</legend>
            <div class="settings-grid">
              <div class="form-field">
                <label class="form-label" for="provider-routing-select"
                  >Provider</label
                >
                <select
                  id="provider-routing-select"
                  v-model="currentSettings.routing.providerChoice"
                  class="select-input"
                >
                  <option value="">Auto</option>
                  <option
                    v-for="option in providerRoutingOptions"
                    :key="option.id"
                    :value="option.id"
                  >
                    {{ option.label }}
                  </option>
                </select>
              </div>

              <label class="checkbox-field provider-routing-checkbox">
                <input v-model="allowFallbacksModel" type="checkbox" />
                <span>Allow fallback providers</span>
              </label>
            </div>

            <div class="provider-details">
              <div class="provider-detail-row">
                <span>Provider</span>
                <strong>{{ selectedProviderDetails.label }}</strong>
              </div>
              <div class="provider-detail-row">
                <span>Precision</span>
                <strong>{{ selectedProviderDetails.precision }}</strong>
              </div>
              <div class="provider-detail-row">
                <span>Input $/1M tok</span>
                <strong>{{ selectedProviderDetails.inputPricePerMtok }}</strong>
              </div>
              <div class="provider-detail-row">
                <span>Output $/1M tok</span>
                <strong>{{
                  selectedProviderDetails.outputPricePerMtok
                }}</strong>
              </div>
              <div class="provider-detail-row">
                <span>Context</span>
                <strong>{{ selectedProviderDetails.contextLength }}</strong>
              </div>
              <div class="provider-detail-row">
                <span>Max output</span>
                <strong>{{
                  selectedProviderDetails.maxCompletionTokens
                }}</strong>
              </div>
            </div>
          </fieldset>

          <fieldset v-if="dynamicParameters.length" class="form-section">
            <legend class="field-legend">Generation Parameters</legend>
            <div class="settings-grid">
              <div
                v-for="param in dynamicParameters"
                :key="param.key"
                class="form-field"
                :class="{ 'form-field--checkbox': param.type === 'boolean' }"
              >
                <label
                  v-if="param.type !== 'boolean'"
                  class="form-label"
                  :for="param.key"
                >
                  {{ param.label || param.key }}
                  <span v-if="param.hint" class="form-hint"
                    >({{ param.hint }})</span
                  >
                </label>

                <!-- Numeric Input -->
                <input
                  v-if="param.type === 'number' || param.type === 'integer'"
                  :id="param.key"
                  v-model.number.lazy="currentSettings.parameters[param.key]"
                  type="number"
                  class="text-input"
                  :placeholder="
                    param.default !== undefined
                      ? String(param.default)
                      : 'Not specified'
                  "
                  :step="param.step"
                  :min="param.min"
                  :max="param.max"
                  :disabled="param.disabled"
                />

                <!-- String Input -->
                <input
                  v-else-if="param.type === 'string'"
                  :id="param.key"
                  v-model="currentSettings.parameters[param.key]"
                  type="text"
                  class="text-input"
                  :placeholder="param.label"
                />

                <!-- Boolean Checkbox -->
                <label
                  v-else-if="param.type === 'boolean'"
                  class="checkbox-field"
                  :for="param.key"
                >
                  <input
                    :id="param.key"
                    v-model="currentSettings.parameters[param.key]"
                    type="checkbox"
                  />
                  <span>{{ param.label || param.key }}</span>
                </label>

                <!-- Enum Select -->
                <select
                  v-else-if="param.type === 'enum'"
                  :id="param.key"
                  v-model="currentSettings.parameters[param.key]"
                  class="select-input"
                >
                  <option :value="undefined">
                    {{ parameterDefaultOptionLabel(param) }}
                    <template v-if="param.default !== undefined">
                      ({{
                        param.options?.find((o) => o.value === param.default)
                          ?.label || param.default
                      }})
                    </template>
                  </option>
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
          </fieldset>

          <fieldset v-if="supportsSystemInstruction" class="form-section">
            <legend class="field-legend">System Prompt</legend>
            <label class="form-label" for="system-prompt">System Prompt</label>
            <textarea
              id="system-prompt"
              v-model="currentSettings.systemPrompt"
              class="textarea-input"
              rows="6"
              placeholder="Enter a system prompt..."
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
import { showSuccessToast } from '../services/notification'
import * as db from '../services/db'
import {
  createEmptySettings,
  normalizeSettingsEntry,
  cloneSettings,
  serializeSettings,
} from '../services/modelConfig'
import { normalizeDynamicParameters } from '../services/modelCapabilities'
const emit = defineEmits(['close'])
const store = useChatStore()

const availableModels = computed(() => store.availableModels)
const allModelSettings = ref({})
const selectedModel = ref('')
const selectedProviderId = ref(null)
const modelCapabilities = ref({})
const currentSettings = ref(createEmptySettings())

const isOverlayMouseDown = ref(false)
const shouldCancelOverlayClose = ref(false)

const handleGlobalMouseUp = () => {
  if (!isOverlayMouseDown.value) return
  isOverlayMouseDown.value = false
  shouldCancelOverlayClose.value = false
}

const ensureProvider = (settings, modelName = selectedModel.value) => {
  const next = cloneSettings(settings)
  next.providerId = modelName ? selectedProviderId.value : null
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
    currentSettings.value = ensureProvider(createEmptySettings(), modelName)
    return
  }
  const stored = allModelSettings.value[modelName]
  if (stored) {
    currentSettings.value = ensureProvider(stored, modelName)
  } else {
    currentSettings.value = ensureProvider(createEmptySettings(), modelName)
  }
}

const fetchCapabilitiesForModel = async (modelName) => {
  if (!modelName) {
    modelCapabilities.value = {}
    return
  }
  try {
    modelCapabilities.value = await store.ensureModelCapabilities(
      modelName,
      selectedProviderId.value
    )
  } catch (error) {
    console.error('Failed to fetch model capabilities:', error)
    modelCapabilities.value = {}
  }
}

// --- Dynamic Parameters Logic ---

const dynamicParameters = computed(() => {
  return normalizeDynamicParameters(modelCapabilities.value)
})

const parameterDefaultOptionLabel = (param) => {
  return param?.default !== undefined ? 'Default' : 'Not specified'
}

const providerRoutingOptions = computed(() => {
  const options =
    modelCapabilities.value?.routing?.providerSelection?.options || []
  return Array.isArray(options)
    ? options.filter((option) => option?.id && option?.label)
    : []
})

const supportsProviderRouting = computed(() => {
  return providerRoutingOptions.value.length > 0
})

const allowFallbacksModel = computed({
  get() {
    return currentSettings.value.routing?.allowFallbacks !== false
  },
  set(value) {
    currentSettings.value.routing = {
      ...(currentSettings.value.routing || {}),
      allowFallbacks: Boolean(value),
    }
  },
})

const selectedProviderOption = computed(() => {
  const selected = currentSettings.value.routing?.providerChoice || ''
  if (!selected) return null
  return (
    providerRoutingOptions.value.find((option) => option.id === selected) ||
    null
  )
})

const formatNumber = (value) => {
  const number = Number(value)
  if (!Number.isFinite(number)) return 'Default'
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 8,
  }).format(number)
}

const formatPrice = (value) => {
  const number = Number(value)
  if (!Number.isFinite(number)) return 'Default'
  const perMillion = number * 1_000_000
  return `$${new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 4,
  }).format(perMillion)}`
}

const selectedProviderDetails = computed(() => {
  const option = selectedProviderOption.value
  if (!option) {
    return {
      label: 'Auto',
      inputPricePerMtok: 'OpenRouter default',
      outputPricePerMtok: 'OpenRouter default',
      contextLength: 'Model default',
      maxCompletionTokens: 'Model default',
      precision: 'Provider default',
    }
  }
  return {
    label: option.label || option.id,
    inputPricePerMtok: formatPrice(option.pricing?.prompt),
    outputPricePerMtok: formatPrice(option.pricing?.completion),
    contextLength: formatNumber(option.contextLength),
    maxCompletionTokens: formatNumber(option.maxCompletionTokens),
    precision: option.precision || 'Default',
  }
})

const supportsSystemInstruction = computed(() => {
  const features = modelCapabilities.value?.features
  // Default to true if features not loaded yet or undefined, unless explicitly false
  return features?.systemInstruction !== false
})

onMounted(async () => {
  window.addEventListener('mouseup', handleGlobalMouseUp)
  const stored = await db.getModelSettings()
  const normalized = {}
  for (const [modelName, entry] of Object.entries(stored)) {
    normalized[modelName] = normalizeSettingsEntry(entry)
  }
  allModelSettings.value = normalized

  const firstGroup =
    availableModels.value.find((group) => group.provider !== 'virtual') ||
    availableModels.value[0]
  const modelToShow = store.composerState.model || firstGroup?.models?.[0] || ''
  selectedModel.value = modelToShow
  selectedProviderId.value = store.composerState.model
    ? store.composerState.providerId
    : firstGroup?.provider || null
  loadSettingsForModel(modelToShow)
  fetchCapabilitiesForModel(modelToShow)
})

watch(selectedModel, (newModel, oldModel) => {
  if (oldModel && oldModel !== newModel) {
    persistCurrentSettings(oldModel)
  }
  loadSettingsForModel(newModel)
  fetchCapabilitiesForModel(newModel)
})

const onModelChange = (event) => {
  selectedModel.value = event.target.value
  selectedProviderId.value =
    event.target.selectedOptions?.[0]?.dataset?.providerId || null
}

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

const save = async () => {
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

  await db.putModelSettings(serialized)
  store.setModelSettings(serialized)
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

.form-field--checkbox {
  justify-content: center;
}

.checkbox-field {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-color);
  cursor: pointer;
}

.checkbox-field input {
  width: 16px;
  height: 16px;
  margin: 0;
  flex: none;
  accent-color: var(--primary-color);
}

.provider-routing-checkbox {
  align-self: end;
  min-height: 40px;
}

.provider-details {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0;
  border: 1px solid var(--border-color);
  border-radius: var(--border-radius);
  overflow: hidden;
  background-color: var(--bg-light);
}

.provider-detail-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-color);
  font-size: 13px;
}

.provider-detail-row:last-child {
  border-bottom: none;
}

.provider-detail-row span {
  color: var(--text-light);
}

.provider-detail-row strong {
  color: var(--text-color);
  font-weight: 600;
  text-align: right;
  overflow-wrap: anywhere;
}

@media (max-width: 767px) {
  .provider-details {
    grid-template-columns: 1fr;
  }
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
