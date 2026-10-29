import hljs from 'highlight.js'
import DOMPurify from 'dompurify'

// Highlighted, sanitized HTML for a code block. Shared by the CodeBlock
// component and the HTML exporter so both colour code the same way.
export function highlightCode(content, lang) {
  const raw = content ?? ''
  const language = (lang || '').toLowerCase()

  if (language === 'mermaid') {
    return DOMPurify.sanitize(
      hljs.highlight(raw, { language: 'plaintext' }).value
    )
  }
  if (language === 'svg') {
    return DOMPurify.sanitize(hljs.highlight(raw, { language: 'svg' }).value)
  }

  try {
    if (language && hljs.getLanguage(language)) {
      return DOMPurify.sanitize(hljs.highlight(raw, { language }).value)
    }
    return DOMPurify.sanitize(hljs.highlightAuto(raw).value)
  } catch {
    return DOMPurify.sanitize(
      hljs.highlight(raw, { language: 'plaintext' }).value
    )
  }
}
