const toBoolean = (value) => {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  if (normalized === 'true') return true
  if (normalized === 'false') return false
  return null
}

const parseByteSize = (value, fallback) => {
  if (typeof value !== 'string' || !value.trim()) return fallback
  const normalized = value.trim().toLowerCase()
  const match = normalized.match(
    /^(\d+(?:\.\d+)?)\s*(b|kb|kib|mb|mib|gb|gib)?$/
  )
  if (!match) return fallback

  const amount = Number(match[1])
  if (!Number.isFinite(amount) || amount <= 0) return fallback

  const unit = match[2] || 'b'
  const multipliers = {
    b: 1,
    kb: 1024,
    kib: 1024,
    mb: 1024 ** 2,
    mib: 1024 ** 2,
    gb: 1024 ** 3,
    gib: 1024 ** 3,
  }
  return Math.floor(amount * multipliers[unit])
}

export const DEBUG_PANEL_ENABLED = (() => {
  const configured = toBoolean(import.meta.env.VITE_ENABLE_DEBUG_PANEL)
  if (configured != null) {
    return configured
  }
  return !!import.meta.env.DEV
})()

export const MAX_UPLOAD_FILE_SIZE = parseByteSize(
  import.meta.env.VITE_MAX_UPLOAD_FILE_SIZE,
  10 * 1024 * 1024
)
