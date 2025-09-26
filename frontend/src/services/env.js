const toBoolean = (value) => {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  if (normalized === 'true') return true
  if (normalized === 'false') return false
  return null
}

export const DEBUG_PANEL_ENABLED = (() => {
  const configured = toBoolean(import.meta.env.VITE_ENABLE_DEBUG_PANEL)
  if (configured != null) {
    return configured
  }
  return !!import.meta.env.DEV
})()
