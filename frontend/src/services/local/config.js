import { openDB } from 'idb'

// Configuration for the browser-only build: what the server keeps in `key`,
// `.env`, system_instruction.txt and openai-endpoints.json. It lives in its
// own database so chat exports, the storage inspector and "clear data" never
// touch API keys.
//
// Defaults are baked in at build time. A blank field or an unedited file
// follows the defaults, so new builds are picked up; once the user saves their
// own text it is used as-is until they explicitly reset it.

const DB_NAME = 'ChatbotLocalConfig'
const STORE_NAME = 'config'
const CONFIG_KEY = 'config'

/**
 * @typedef {object} LocalConfig
 * @property {Record<string, string>} keys API keys by provider.
 * @property {Record<string, string>} settings Only the fields the user set.
 * @property {Record<string, { text: string, baseHash: string }>} files
 *   User-edited files; `baseHash` is the default they started from.
 */

/** @type {{ settings: Record<string, string>, systemInstruction: string }} */
const BUILD_DEFAULTS = __LOCAL_DEFAULTS__

export const PROVIDER_KEYS = [
  { key: 'gemini', label: 'Gemini' },
  { key: 'claude', label: 'Claude' },
  { key: 'openrouter', label: 'OpenRouter' },
]

export const SYSTEM_INSTRUCTION_MODES = [
  'frontend_first',
  'default_first',
  'merge',
]

export const SETTING_FIELDS = [
  {
    key: 'defaultModel',
    name: 'DEFAULT_MODEL',
    hint: 'Model selected when the app starts.',
  },
  {
    key: 'geminiModelFilter',
    name: 'GEMINI_MODEL_FILTER',
    hint: 'Comma-separated keywords; only matching Gemini models are listed.',
  },
  {
    key: 'claudeModelFilter',
    name: 'CLAUDE_MODEL_FILTER',
    hint: 'Comma-separated keywords; only matching Claude models are listed.',
  },
  {
    key: 'systemInstructionMode',
    name: 'SYSTEM_INSTRUCTION_MODE',
    hint: 'How the default system prompt combines with the chat’s own.',
    options: SYSTEM_INSTRUCTION_MODES,
  },
  {
    key: 'openrouterModels',
    name: 'OPENROUTER_MODELS',
    hint: 'Comma-separated OpenRouter model IDs to list.',
  },
  {
    key: 'openrouterAppUrl',
    name: 'OPENROUTER_APP_URL',
    hint: 'App URL sent to OpenRouter for attribution (HTTP-Referer).',
  },
  {
    key: 'openrouterAppTitle',
    name: 'OPENROUTER_APP_TITLE',
    hint: 'App name sent to OpenRouter for attribution.',
  },
]

export const ENDPOINTS_EXAMPLE = `[
  {
    "label": "vLLM",
    "baseUrl": "https://vllm.example.com/v1",
    "apiKey": "EMPTY",
    "models": [],
    "request": { "chat_template_kwargs": { "reasoning_effort": "high" } }
  }
]`

export const TEXT_FILES = [
  {
    key: 'systemInstruction',
    name: 'system_instruction.txt',
    defaultText: BUILD_DEFAULTS.systemInstruction || '',
  },
  {
    key: 'openaiEndpoints',
    name: 'openai-endpoints.json',
    defaultText: '[]\n',
  },
]

export function defaultSettingValue(key) {
  return BUILD_DEFAULTS.settings?.[key] || ''
}

export function defaultFileText(key) {
  return TEXT_FILES.find((file) => file.key === key)?.defaultText ?? ''
}

// FNV-1a; only needs to tell whether the shipped default changed.
export function hashText(text) {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** @returns {LocalConfig} */
export function emptyConfig() {
  return { keys: {}, settings: {}, files: {} }
}

const dbPromise =
  typeof indexedDB === 'undefined'
    ? null
    : openDB(DB_NAME, 1, {
        upgrade(db) {
          db.createObjectStore(STORE_NAME)
        },
      })

/** @returns {Promise<LocalConfig>} */
export async function loadConfig() {
  if (!dbPromise) return emptyConfig()
  const stored = await (await dbPromise).get(STORE_NAME, CONFIG_KEY)
  return { ...emptyConfig(), ...(stored || {}) }
}

/** @param {LocalConfig} config */
export async function saveConfig(config) {
  if (!dbPromise) throw new Error('IndexedDB is not available.')
  await (await dbPromise).put(STORE_NAME, config, CONFIG_KEY)
}

/** Returns an error message, or null when the text is usable. */
export function validateFile(key, text) {
  if (key !== 'openaiEndpoints') return null
  if (!text.trim()) return null
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return `Invalid JSON: ${error.message}`
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed]
  for (const [index, entry] of entries.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return `Entry ${index + 1} must be an object.`
    }
    if (!String(entry.baseUrl || entry.base_url || '').trim()) {
      return `Entry ${index + 1} needs a "baseUrl".`
    }
  }
  return null
}

/** @param {LocalConfig} config */
export function fileText(config, key) {
  return config.files?.[key]?.text ?? defaultFileText(key)
}

/** @param {LocalConfig} config */
export function isFileOutdated(config, key) {
  const file = config.files?.[key]
  return Boolean(file) && file.baseHash !== hashText(defaultFileText(key))
}

/**
 * Turns the stored config into createRuntime() options.
 * @param {LocalConfig} config
 */
export function resolveConfig(config) {
  const settings = {}
  for (const field of SETTING_FIELDS) {
    settings[field.key] =
      config.settings?.[field.key]?.trim() || defaultSettingValue(field.key)
  }
  let openaiCompatConfig = null
  const endpoints = fileText(config, 'openaiEndpoints')
  if (endpoints.trim()) {
    try {
      openaiCompatConfig = JSON.parse(endpoints)
    } catch (error) {
      console.warn('Ignoring invalid openai-endpoints.json:', error.message)
    }
  }
  return {
    keys: { ...config.keys },
    settings,
    defaultSystemInstruction: fileText(config, 'systemInstruction'),
    openaiCompatConfig,
  }
}
