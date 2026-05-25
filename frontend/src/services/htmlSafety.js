const SAFE_URL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function isSafeUrl(value) {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (!trimmed) return false

  const protocolInput = stripProtocolSeparators(trimmed)
  const protocolMatch = protocolInput.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/)
  if (!protocolMatch) return true

  return SAFE_URL_PROTOCOLS.has(`${protocolMatch[1].toLowerCase()}:`)
}

export function safeHref(value) {
  return isSafeUrl(value) ? String(value).trim() : null
}

export function safeAnchorHtml(href, label, attributes = '') {
  const safe = safeHref(href)
  const safeLabel = escapeHtml(label || href || '')
  if (!safe) return safeLabel

  const attr = attributes ? ` ${attributes.trim()}` : ''
  return `<a href="${escapeHtml(safe)}"${attr}>${safeLabel}</a>`
}

function stripProtocolSeparators(value) {
  return Array.from(value)
    .filter((char) => {
      const code = char.charCodeAt(0)
      return code > 0x20 && code !== 0x7f
    })
    .join('')
}
