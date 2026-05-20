function parseEnvBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  const normalized = String(value).trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return fallback
}

export function createDefaultToolSettings() {
  const env = import.meta.env || {}
  return {
    useUrlContext: parseEnvBoolean(env.VITE_DEFAULT_TOOL_URL_CONTEXT, true),
    useGrounding: parseEnvBoolean(env.VITE_DEFAULT_TOOL_SEARCH, false),
    useCodeExecution: parseEnvBoolean(
      env.VITE_DEFAULT_TOOL_CODE_EXECUTION,
      false
    ),
  }
}
