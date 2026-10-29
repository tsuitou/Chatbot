// Color theme preference: 'system' follows the OS, 'light' / 'dark' pin it.
// It is a per-device display choice, so it lives in localStorage rather than
// the chat database.
const STORAGE_KEY = 'chatbot.theme'
export const THEME_PREFERENCES = ['system', 'light', 'dark']

export function getThemePreference() {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    return THEME_PREFERENCES.includes(value) ? value : 'system'
  } catch {
    return 'system'
  }
}

export function applyThemePreference(preference) {
  const root = document.documentElement
  if (preference === 'light' || preference === 'dark') {
    root.dataset.theme = preference
  } else {
    delete root.dataset.theme
  }
}

export function setThemePreference(preference) {
  const next = THEME_PREFERENCES.includes(preference) ? preference : 'system'
  try {
    localStorage.setItem(STORAGE_KEY, next)
  } catch {
    // Storage can be unavailable (private mode); the choice still applies now.
  }
  applyThemePreference(next)
  return next
}

// The theme actually shown, for things CSS cannot reach (e.g. mermaid).
export function isDarkThemeActive() {
  const pinned = document.documentElement.dataset.theme
  if (pinned) return pinned === 'dark'
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
}
