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

function coerceSettingValue(value) {
  if (value === '' || value === null || value === undefined) return undefined
  const num = Number(value)
  return Number.isFinite(num) ? num : value
}

function normalizeParameters(raw) {
  const params =
    raw?.parameters && typeof raw.parameters === 'object' ? raw.parameters : {}
  const next = {}
  for (const [key, value] of Object.entries(params)) {
    const coerced = coerceSettingValue(value)
    if (coerced !== undefined) next[key] = coerced
  }
  return next
}

function normalizeOptions(raw) {
  if (raw?.options && typeof raw.options === 'object') {
    return { ...raw.options }
  }
  return {}
}

/**
 * Normalize a settings entry loaded from storage into the canonical structure.
 * Falls back to empty settings if the input is invalid.
 */
export function normalizeSettingsEntry(raw) {
  if (!raw || typeof raw !== 'object') {
    return createEmptySettings()
  }

  const normalized = createEmptySettings()

  normalized.providerId = raw.providerId ?? null
  normalized.parameters = normalizeParameters(raw)
  normalized.options = normalizeOptions(raw)
  normalized.systemPrompt =
    typeof raw.systemPrompt === 'string' ? raw.systemPrompt : ''

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
