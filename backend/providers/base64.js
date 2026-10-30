// Decodes base64 to UTF-8 text without Node's Buffer, so the providers also
// run in the browser. Invalid input yields '' instead of throwing.
export function decodeBase64Text(data) {
  try {
    const binary = atob(String(data || '').replace(/\s+/g, ''))
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch {
    return ''
  }
}
