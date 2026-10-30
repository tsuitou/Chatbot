<template>
  <div class="configuration-panel">
    <p v-if="isLoading" class="hint">Loading…</p>
    <form v-else @submit.prevent="save">
      <section class="section">
        <h3>API Keys</h3>
        <p class="hint">
          Stored only in this browser and sent directly to each provider. They
          are not included in exports.
        </p>
        <div
          v-for="provider in PROVIDER_KEYS"
          :key="provider.key"
          class="field"
        >
          <label class="form-label" :for="`api-key-${provider.key}`">
            {{ provider.label }}
          </label>
          <input
            :id="`api-key-${provider.key}`"
            v-model="draft.keys[provider.key]"
            class="text-input"
            type="password"
            autocomplete="off"
            spellcheck="false"
          />
        </div>
      </section>

      <section class="section">
        <h3>Settings</h3>
        <p class="hint">Leave a field blank to use the default shown.</p>
        <div v-for="field in SETTING_FIELDS" :key="field.key" class="field">
          <label class="form-label" :for="`setting-${field.key}`">
            <code>{{ field.name }}</code>
            <span class="hint">{{ field.hint }}</span>
          </label>
          <select
            v-if="field.options"
            :id="`setting-${field.key}`"
            v-model="draft.settings[field.key]"
            class="select-input"
          >
            <option value="">
              Default ({{ defaultSettingValue(field.key) || 'frontend_first' }})
            </option>
            <option
              v-for="option in field.options"
              :key="option"
              :value="option"
            >
              {{ option }}
            </option>
          </select>
          <input
            v-else
            :id="`setting-${field.key}`"
            v-model="draft.settings[field.key]"
            class="text-input"
            type="text"
            spellcheck="false"
            :placeholder="defaultSettingValue(field.key) || '(none)'"
          />
        </div>
      </section>

      <section v-for="file in TEXT_FILES" :key="file.key" class="section">
        <div class="file-header">
          <h3>
            <code>{{ file.name }}</code>
          </h3>
          <span class="badge" :class="{ custom: isCustom(file.key) }">
            {{ isCustom(file.key) ? 'Custom' : 'Default' }}
          </span>
        </div>
        <p v-if="file.key === 'openaiEndpoints'" class="hint">
          OpenAI-compatible endpoints; an empty list disables them. The page is
          served over HTTPS, so browsers block plain-HTTP servers on your
          network (<code>http://localhost</code> usually works).
        </p>
        <p v-if="isFileOutdated(stored, file.key)" class="notice" role="status">
          The default for this file has changed since you edited it. Compare
          with “Show Default” and copy over what you need.
        </p>
        <textarea
          v-model="draft.files[file.key]"
          class="textarea-input"
          :class="{ code: file.key === 'openaiEndpoints' }"
          rows="8"
          spellcheck="false"
          :aria-label="file.name"
          :placeholder="file.key === 'openaiEndpoints' ? ENDPOINTS_EXAMPLE : ''"
        ></textarea>
        <p v-if="fileErrors[file.key]" class="error" role="alert">
          {{ fileErrors[file.key] }}
        </p>
        <div class="button-row">
          <button
            class="secondary-button"
            type="button"
            @click="toggleDefault(file.key)"
          >
            {{ shownDefault === file.key ? 'Hide Default' : 'Show Default' }}
          </button>
          <button
            class="secondary-button"
            type="button"
            :disabled="!isCustom(file.key)"
            @click="resetFile(file.key)"
          >
            Reset to Default
          </button>
        </div>
        <pre v-if="shownDefault === file.key" class="default-text">{{
          defaultFileText(file.key) || '(empty)'
        }}</pre>
      </section>

      <div class="footer">
        <p class="hint">Saving reloads the app to apply the changes.</p>
        <button class="action-btn" type="submit" :disabled="isSaving">
          Save and Reload
        </button>
      </div>
    </form>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import {
  ENDPOINTS_EXAMPLE,
  PROVIDER_KEYS,
  SETTING_FIELDS,
  TEXT_FILES,
  defaultFileText,
  defaultSettingValue,
  emptyConfig,
  fileText,
  hashText,
  isFileOutdated,
  loadConfig,
  saveConfig,
  validateFile,
} from '../services/local/config'
import { showErrorToast } from '../services/notification'
import { useSessionStore } from '../stores/session'

const session = useSessionStore()
const isLoading = ref(true)
const isSaving = ref(false)
const shownDefault = ref(null)
/** @type {import('vue').Ref<import('../services/local/config').LocalConfig>} */
const stored = ref(emptyConfig())
const draft = reactive({ keys: {}, settings: {}, files: {} })
// Files the user reset to the default in this session.
const resetKeys = reactive(new Set())

const fileErrors = computed(() =>
  Object.fromEntries(
    TEXT_FILES.map((file) => [
      file.key,
      validateFile(file.key, draft.files[file.key] ?? ''),
    ])
  )
)

// A file is custom once its text differs from the default, or while it
// still carries an earlier saved version that was not reset.
const isCustom = (key) => {
  const text = draft.files[key] ?? ''
  if (text !== defaultFileText(key)) return true
  return Boolean(stored.value.files?.[key]) && !resetKeys.has(key)
}

onMounted(async () => {
  try {
    stored.value = await loadConfig()
  } catch (error) {
    console.error('Failed to load configuration:', error)
    showErrorToast('Could not load the configuration.')
  }
  for (const provider of PROVIDER_KEYS) {
    draft.keys[provider.key] = stored.value.keys?.[provider.key] || ''
  }
  for (const field of SETTING_FIELDS) {
    draft.settings[field.key] = stored.value.settings?.[field.key] || ''
  }
  for (const file of TEXT_FILES) {
    draft.files[file.key] = fileText(stored.value, file.key)
  }
  isLoading.value = false
})

const toggleDefault = (key) => {
  shownDefault.value = shownDefault.value === key ? null : key
}

const resetFile = (key) => {
  draft.files[key] = defaultFileText(key)
  resetKeys.add(key)
}

function buildConfig() {
  const config = emptyConfig()
  for (const provider of PROVIDER_KEYS) {
    const value = draft.keys[provider.key]?.trim()
    if (value) config.keys[provider.key] = value
  }
  for (const field of SETTING_FIELDS) {
    const value = draft.settings[field.key]?.trim()
    if (value) config.settings[field.key] = value
  }
  for (const file of TEXT_FILES) {
    const text = draft.files[file.key] ?? ''
    const previous = stored.value.files?.[file.key]
    if (
      text === defaultFileText(file.key) &&
      (!previous || resetKeys.has(file.key))
    ) {
      continue // follows the default
    }
    config.files[file.key] = {
      text,
      // The default this text is based on, which the "default has changed"
      // notice compares against. Saving an edit counts as having reviewed the
      // current default; an untouched file keeps the one it started from.
      baseHash:
        previous && previous.text === text
          ? previous.baseHash
          : hashText(defaultFileText(file.key)),
    }
  }
  return config
}

const save = async () => {
  const firstError = Object.values(fileErrors.value).find(Boolean)
  if (firstError) {
    showErrorToast(firstError)
    return
  }
  if (
    session.isGenerating &&
    !confirm('A response is still being generated. Stop it and reload?')
  ) {
    return
  }
  isSaving.value = true
  try {
    await saveConfig(buildConfig())
    window.location.reload()
  } catch (error) {
    console.error('Failed to save configuration:', error)
    showErrorToast('Could not save the configuration.')
    isSaving.value = false
  }
}
</script>

<style scoped>
.configuration-panel {
  padding: 24px;
}
.section {
  margin-bottom: 24px;
  padding-bottom: 24px;
  border-bottom: 1px solid var(--border-color);
}
h3 {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-color);
  margin-bottom: 4px;
}
.hint {
  font-size: 13px;
  color: var(--text-light);
  font-weight: normal;
}
.section > .hint {
  margin-bottom: 12px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 12px;
}
.form-label {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-color);
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
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
.textarea-input {
  resize: vertical;
  min-height: 140px;
  margin-bottom: 8px;
}
.textarea-input.code,
.default-text {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
}
.file-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.file-header h3 {
  margin-bottom: 0;
}
.badge {
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 999px;
  background-color: var(--bg-gray);
  color: var(--text-light);
}
.badge.custom {
  background-color: var(--primary-light);
  color: var(--primary-text);
}
.notice {
  font-size: 13px;
  color: var(--text-color);
  border-left: 3px solid var(--warning-color);
  background-color: var(--bg-light);
  padding: 8px 12px;
  margin-bottom: 8px;
}
.error {
  font-size: 13px;
  color: var(--danger-text);
  margin-bottom: 8px;
}
.default-text {
  margin-top: 8px;
  padding: 12px;
  max-height: 240px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  background-color: var(--bg-gray);
  border-radius: var(--border-radius);
  color: var(--text-color);
}
.button-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.secondary-button {
  background-color: var(--bg-light);
  color: var(--text-color);
  border: 1px solid var(--border-color);
  padding: 6px 12px;
  border-radius: var(--border-radius);
  cursor: pointer;
  transition: var(--transition);
}
.secondary-button:hover:not(:disabled) {
  background-color: var(--bg-hover);
}
.secondary-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.action-btn {
  background-color: var(--primary-color);
  color: var(--on-primary);
  border: none;
  padding: 8px 16px;
  border-radius: var(--border-radius);
  cursor: pointer;
  transition: var(--transition);
}
.action-btn:hover:not(:disabled) {
  background-color: var(--primary-dark);
}
.action-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
