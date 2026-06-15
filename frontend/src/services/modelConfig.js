/**
 * Create a deep-cloned, mutable copy of the default empty settings object.
 */
export function createEmptySettings() {
  return {
    providerId: null,
    parameters: {},
    routing: {},
    systemPrompt: '',
  }
}

function coerceSettingValue(value) {
  if (value === '' || value === null || value === undefined) return undefined
  if (typeof value === 'boolean') return value
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

function normalizeProviderRouting(raw) {
  const source =
    raw?.routing && typeof raw.routing === 'object' ? raw.routing : raw
  if (!source || typeof source !== 'object') return {}

  const providerChoice =
    typeof source.providerChoice === 'string'
      ? source.providerChoice.trim()
      : ''
  const routing = {}
  if (providerChoice) routing.providerChoice = providerChoice
  if (typeof source.allowFallbacks === 'boolean') {
    routing.allowFallbacks = source.allowFallbacks
  }
  return Object.keys(routing).length ? routing : {}
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
  normalized.routing = normalizeProviderRouting(raw)
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
    routing: normalizeProviderRouting(settings),
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
    routing: normalizeProviderRouting(normalized),
    systemPrompt: normalized.systemPrompt ?? '',
  }

  for (const [key, value] of Object.entries(normalized.parameters || {})) {
    if (value === '' || value === undefined || value === null) continue
    payload.parameters[key] = value
  }

  if (!payload.systemPrompt) {
    delete payload.systemPrompt
  }
  if (!Object.keys(payload.parameters).length) {
    delete payload.parameters
  }
  if (!Object.keys(payload.routing).length) {
    delete payload.routing
  }
  if (!payload.providerId) {
    delete payload.providerId
  }

  return payload
}
