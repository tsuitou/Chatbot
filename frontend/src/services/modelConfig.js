const knownParameterKeys = [
  'temperature',
  'topP',
  'maxOutputTokens',
  'thinkingBudget',
  'thinkingLevel',
]

const numericParameterKeys = new Set([
  'temperature',
  'topP',
  'maxOutputTokens',
  'thinkingBudget',
])

/**
 * Create a deep-cloned, mutable copy of the default empty settings object.
 */
export function createEmptySettings() {
  return {
    providerId: null,
    parameters: {},
    options: {},
    systemPrompt: '',
  }
}

function coerceNumber(value) {
  if (value === '' || value === null || value === undefined) return undefined
  const num = Number(value)
  return Number.isFinite(num) ? num : undefined
}

function pickParametersFromLegacy(raw) {
  const next = {}
  for (const key of knownParameterKeys) {
    if (raw && raw[key] !== undefined) {
      next[key] = numericParameterKeys.has(key)
        ? coerceNumber(raw[key])
        : raw[key]
    }
  }
  if (raw?.parameters && typeof raw.parameters === 'object') {
    for (const [key, value] of Object.entries(raw.parameters)) {
      if (next[key] !== undefined) continue
      next[key] = numericParameterKeys.has(key) ? coerceNumber(value) : value
    }
  }
  return next
}

function pickOptionsFromLegacy(raw) {
  const options = {}
  const includeThoughts = raw?.includeThoughts
  if (includeThoughts !== undefined) {
    options.includeThoughts = !!includeThoughts
  }
  if (raw?.options && typeof raw.options === 'object') {
    for (const [key, value] of Object.entries(raw.options)) {
      if (options[key] !== undefined) continue
      options[key] = value
    }
  }
  return options
}

/**
 * Normalize a settings entry loaded from storage into the canonical structure.
 * Falls back to empty settings if the input is invalid.
 */
export function normalizeSettingsEntry(
  raw,
  { fallbackProviderId = null } = {}
) {
  if (!raw || typeof raw !== 'object') {
    return createEmptySettings()
  }

  const normalized = createEmptySettings()

  normalized.providerId = raw.providerId ?? fallbackProviderId ?? null
  normalized.parameters = pickParametersFromLegacy(raw)
  normalized.options = pickOptionsFromLegacy(raw)
  const prompt =
    raw.systemPrompt ?? raw.systemInstruction ?? raw.system ?? raw.systemMessage
  normalized.systemPrompt = typeof prompt === 'string' ? prompt : ''

  return normalized
}

/**
 * Deep clone a settings object so it can be safely mutated.
 */
export function cloneSettings(settings) {
  if (!settings) return createEmptySettings()
  return {
    providerId: settings.providerId ?? null,
    parameters: settings.parameters ? { ...settings.parameters } : {},
    options: settings.options ? { ...settings.options } : {},
    systemPrompt: settings.systemPrompt ?? '',
  }
}

/**
 * Prepare a settings object for persistence by removing undefined fields.
 */
export function serializeSettings(settings) {
  const normalized = cloneSettings(settings)
  const payload = {
    providerId: normalized.providerId ?? null,
    parameters: {},
    options: {},
    systemPrompt: normalized.systemPrompt ?? '',
  }

  for (const [key, value] of Object.entries(normalized.parameters || {})) {
    if (value === '' || value === undefined || value === null) continue
    payload.parameters[key] = value
  }

  for (const [key, value] of Object.entries(normalized.options || {})) {
    if (value === undefined) continue
    payload.options[key] = value
  }

  if (!payload.systemPrompt) {
    delete payload.systemPrompt
  }
  if (!Object.keys(payload.parameters).length) {
    delete payload.parameters
  }
  if (!Object.keys(payload.options).length) {
    delete payload.options
  }
  if (!payload.providerId) {
    delete payload.providerId
  }

  return payload
}
