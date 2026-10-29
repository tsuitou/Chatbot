// Exports a chat as one self-contained HTML file that looks like the app:
// the markup mirrors Message.vue / CodeBlock.vue and the page embeds the
// app's own tokens.css + message.css, so both themes and every message
// detail carry over. Nothing is loaded from the network when it is opened.
import exportStyles from '../styles/export.css?inline'
import katexCss from 'katex/dist/katex.min.css?raw'
import { icon as faIcon, dom as faDom } from '@fortawesome/fontawesome-svg-core'
import '../icons'
import { parseModelResponse } from './parser'
import { escapeHtml } from './htmlSafety'
import { highlightCode } from './highlight'
import {
  buildDisplayIndicators,
  buildMetadataHtmlForExport,
} from './messageMetadata'
import {
  defaultSystemSummary,
  errorText,
  formatDuration,
  formatTimestamp,
  senderLabel,
} from './messageView'

// Loaded only when an export contains math; each resolves to a data: URL.
const katexFontLoaders = import.meta.glob(
  '../../node_modules/katex/dist/fonts/*.woff2',
  { query: '?inline', import: 'default' }
)

function iconSvg(name, className = '') {
  const definition = faIcon(
    { prefix: 'fas', iconName: name },
    className ? { classes: [className] } : {}
  )
  return definition ? definition.html.join('') : ''
}

function renderCodeBlock(content, lang) {
  const special = lang === 'mermaid' || lang === 'svg'
  // The wrapper is white-space: pre (as in the app), so no whitespace may
  // sit between these tags or it would show up as blank lines.
  return [
    `<div class="code-block-wrapper${special ? ' special-lang' : ''}">`,
    '<div class="code-header">',
    `<span class="language-name">${escapeHtml(lang)}</span>`,
    '<div class="actions">',
    `<button class="action-btn" type="button" data-copy>${iconSvg('copy')}<span>Copy</span></button>`,
    '</div>',
    '</div>',
    `<div class="code-content"><pre><code>${highlightCode(content, lang)}</code></pre></div>`,
    '</div>',
  ].join('')
}

function renderSegments(segments) {
  return segments
    .map((segment) => {
      if (segment.type === 'code') {
        return renderCodeBlock(segment.content, segment.lang)
      }
      if (segment.type === 'prompt') {
        return `<div>${escapeHtml(segment.htmlContent)}</div>`
      }
      return `<div>${segment.htmlContent || ''}</div>`
    })
    .join('')
}

function renderSystemBubble(message, indicators, thoughtSegments) {
  const hasThoughts = thoughtSegments.length > 0
  const summary = indicators.length
    ? indicators
        .map(
          (indicator) =>
            `<span class="summary-item">${indicator.icon ? iconSvg(indicator.icon) : ''}<span>${escapeHtml(indicator.text || '')}</span></span>`
        )
        .join('')
    : `<span class="summary-item summary-item--placeholder"><span>${escapeHtml(
        defaultSystemSummary(message.status)
      )}</span></span>`
  const thoughtId = `thoughts-${escapeHtml(message.id)}`
  const toggle = hasThoughts
    ? `aria-expanded="false" aria-controls="${thoughtId}" data-thought-toggle`
    : 'disabled aria-disabled="true"'
  const duration = message.metadata?.duration

  return `<div class="message-bubble system-bubble">
  <div class="thought-stream collapsed${hasThoughts ? '' : ' disabled'}">
    <button class="thought-stream-header${hasThoughts ? '' : ' disabled'}" type="button" ${toggle}>
      <div class="status-icon"><span class="duration-text">${escapeHtml(
        duration !== undefined && duration !== null
          ? formatDuration(duration)
          : '- s'
      )}</span></div>
      <div class="system-summary">${summary}</div>
      ${iconSvg('chevron-down', 'thought-chevron')}
    </button>
    ${
      hasThoughts
        ? `<div class="thought-stream-content" id="${thoughtId}" hidden>${renderSegments(thoughtSegments)}</div>`
        : ''
    }
  </div>
</div>`
}

function renderAttachments(attachments) {
  if (!attachments?.length) return ''
  const chips = attachments
    .map(
      (att) =>
        `<span class="attachment-chip">${iconSvg('file-download')}<span>${escapeHtml(att.name)}</span></span>`
    )
    .join('')
  return `<div class="attachment-list">${chips}</div>`
}

async function renderMessage(message) {
  // Interrupted responses are hidden in the app as well.
  if (message.status === 'cancelled') return { html: '', hasMath: false }

  const isUser = message.sender === 'user'
  const contentSegments = isUser
    ? []
    : await parseModelResponse(message.content?.text ?? '')
  const thoughtSegments = isUser
    ? []
    : await parseModelResponse(message.runtime?.system?.thoughts?.rawText ?? '')
  const indicators = buildDisplayIndicators(message)
  const attachments = message.attachments || []
  const metadataHtml =
    !isUser && message.status === 'completed'
      ? buildMetadataHtmlForExport(message)
      : ''

  const showSystem =
    !isUser &&
    !!message.uiFlags?.systemBubbleActive &&
    (indicators.length > 0 ||
      thoughtSegments.length > 0 ||
      message.status === 'streaming')
  const showContent =
    isUser ||
    contentSegments.length > 0 ||
    attachments.length > 0 ||
    !!metadataHtml

  const error = errorText(message)
  const body = isUser
    ? `<div class="plain-user-text">${escapeHtml(message.content?.text ?? '')}</div>`
    : `<div class="prose">${renderSegments(contentSegments)}</div>`
  const timestamp = formatTimestamp(message.createdAt)

  const html = `<div class="message-wrapper">
  <div class="message-header">
    <div class="sender-info">
      <span class="sender-name">${senderLabel(message.sender)}</span>
      ${timestamp ? `<span class="message-timestamp">${escapeHtml(timestamp)}</span>` : ''}
    </div>
  </div>
  <div class="message-body">
    ${showSystem ? renderSystemBubble(message, indicators, thoughtSegments) : ''}
    ${
      showContent
        ? `<div class="message-bubble ${isUser ? 'bubble-user' : 'bubble-model'}">
      ${error ? `<div class="message-alert error" role="alert">${escapeHtml(error)}</div>` : ''}
      ${body}
      ${metadataHtml ? `<div class="metadata">${metadataHtml}</div>` : ''}
    </div>`
        : ''
    }
    ${renderAttachments(attachments)}
  </div>
</div>`

  return { html, hasMath: html.includes('class="katex') }
}

// KaTeX's stylesheet with its fonts inlined, so math renders offline.
async function buildKatexStyles() {
  const fonts = {}
  await Promise.all(
    Object.entries(katexFontLoaders).map(async ([path, load]) => {
      const name = path.slice(path.lastIndexOf('/') + 1, -'.woff2'.length)
      fonts[name] = await load()
    })
  )
  return katexCss.replace(
    /src:url\(fonts\/([\w-]+)\.woff2\)[^;}]*/g,
    (match, name) =>
      fonts[name] ? `src:url(${fonts[name]}) format("woff2")` : match
  )
}

const PAGE_SCRIPT = `
(function () {
  var root = document.documentElement
  var themes = ['system', 'light', 'dark']
  var labels = { system: 'System', light: 'Light', dark: 'Dark' }
  var themeButton = document.querySelector('[data-theme-switch]')
  function showTheme(theme) {
    if (theme === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', theme)
    themeButton.querySelector('span').textContent = 'Theme: ' + labels[theme]
    themeButton.dataset.current = theme
  }
  themeButton.addEventListener('click', function () {
    var current = themeButton.dataset.current || 'system'
    showTheme(themes[(themes.indexOf(current) + 1) % themes.length])
  })
  showTheme('system')

  document.querySelectorAll('[data-thought-toggle]').forEach(function (button) {
    var target = document.getElementById(button.getAttribute('aria-controls'))
    var stream = button.closest('.thought-stream')
    button.addEventListener('click', function () {
      var open = button.getAttribute('aria-expanded') !== 'true'
      button.setAttribute('aria-expanded', String(open))
      target.hidden = !open
      stream.classList.toggle('collapsed', !open)
      button.querySelector('.thought-chevron').style.transform = open ? 'rotate(180deg)' : ''
    })
  })

  document.querySelectorAll('[data-copy]').forEach(function (button) {
    button.addEventListener('click', function () {
      var code = button.closest('.code-block-wrapper').querySelector('code')
      var label = button.querySelector('span')
      navigator.clipboard.writeText(code.textContent).then(
        function () { label.textContent = 'Copied!' },
        function () { label.textContent = 'Error' }
      )
      setTimeout(function () { label.textContent = 'Copy' }, 2000)
    })
  })
})()
`

export async function exportChatAsHTML(chat, messages) {
  if (!chat || !Array.isArray(messages)) return ''

  const title = chat.title || 'Chat Export'
  const rendered = await Promise.all(messages.map(renderMessage))
  const hasMath = rendered.some((r) => r.hasMath)
  const exportedAt = formatTimestamp(Date.now())

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="color-scheme" content="light dark" />
<title>${escapeHtml(title)}</title>
<style>${faDom.css()}</style>
${hasMath ? `<style>${await buildKatexStyles()}</style>` : ''}
<style>${exportStyles}</style>
</head>
<body>
<header class="export-header">
  <h1 class="export-title">${escapeHtml(title)}</h1>
  <span class="export-meta">Exported ${escapeHtml(exportedAt)}</span>
  <button class="theme-switch" type="button" data-theme-switch>${iconSvg('circle-half-stroke')}<span>Theme: System</span></button>
</header>
<main class="message-list">
${rendered.map((r) => r.html).join('\n')}
</main>
<script>${PAGE_SCRIPT}</script>
</body>
</html>
`
}
