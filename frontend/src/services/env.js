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

// The browser-only (PWA) build: no backend, providers run in the page.
export const IS_LOCAL_MODE = import.meta.env.VITE_BACKEND === 'local'

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

const parsePositiveSeconds = (value, fallback) => {
  if (typeof value !== 'string' || !value.trim()) return fallback
  const seconds = Number(value.trim())
  return Number.isFinite(seconds) && seconds > 0 ? seconds : fallback
}

// How long a streaming response may stay silent before it is treated as
// stalled. Only applied to streaming requests on regular providers.
export const STREAM_IDLE_TIMEOUT_MS =
  parsePositiveSeconds(import.meta.env.VITE_STREAM_IDLE_TIMEOUT, 180) * 1000
