const MODES = new Set(['frontend_first', 'default_first', 'merge'])

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0
}

export function normalizeSystemInstructionMode(raw) {
  const mode = String(raw || 'frontend_first').trim().toLowerCase()
  if (mode === 'frontend' || mode === 'front') return 'frontend_first'
  if (mode === 'default') return 'default_first'
  return MODES.has(mode) ? mode : 'frontend_first'
}

export function resolveSystemInstruction({
  defaultSystemInstruction,
  userSystemInstruction,
  mode,
}) {
  const normalizedMode = normalizeSystemInstructionMode(mode)
  const defaultText = hasText(defaultSystemInstruction)
    ? defaultSystemInstruction
    : ''
  const userText = hasText(userSystemInstruction) ? userSystemInstruction : ''

  if (normalizedMode === 'default_first') {
    return defaultText || userText
  }

  if (normalizedMode === 'merge') {
    return [defaultText, userText].filter(Boolean).join('\n\n')
  }

  return userText || defaultText
}
