import { parseModelResponse } from './parser'
import { getProviderById } from './providers'

const ICONS = {
  file: `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 384 512" width="16" height="16" fill="currentColor">
      <path d="M0 64C0 28.7 28.7 0 64 0H224V128c0 17.7 14.3 32 32 32H384V448c0 35.3-28.7 64-64 64H64c-35.3 0-64-28.7-64-64V64zm384 64H256V0L384 128z"/>
    </svg>`,
  image: `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="16" height="16" fill="currentColor">
      <path d="M448 80c8.8 0 16 7.2 16 16V415.8l-5-6.5-136-176c-4.5-5.9-11.6-9.3-19-9.3s-14.4 3.4-19 9.3L202 340.7l-30.5-42.7C167 291.7 159.8 288 152 288s-15 3.7-19.5 10.1l-80 112L48 416V96c0-8.8 7.2-16 16-16H448zM64 32C28.7 32 0 60.7 0 96V416c0 35.3 28.7 64 64 64H448c35.3 0 64-28.7 64-64V96c0-35.3-28.7-64-64-64H64zm80 192a48 48 0 1 0 0-96 48 48 0 1 0 0 96z"/>
    </svg>`,
}

const STATUS_ICON = `
  <svg class="status-icon-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
    <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2" />
  </svg>
`

const CHEVRON_ICON = `
  <svg class="chevron-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">
    <path d="M3 6l5 5 5-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
`

const dateTimeFormatter = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
})

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function formatTimestamp(value) {
  if (!value) return ''
  try {
    return dateTimeFormatter.format(new Date(value))
  } catch (error) {
    console.error('Failed to format timestamp for export:', error)
    return ''
  }
}

function getAttachmentIcon(mimeType = '') {
  if (mimeType.startsWith('image/')) {
    return ICONS.image
  }
  return ICONS.file
}

function renderAttachments(attachments) {
  if (!attachments || attachments.length === 0) return ''
  const html = attachments
    .map(
      (att) => `
        <div class="attachment-chip">
          ${getAttachmentIcon(att.mimeType)}
          <span>${escapeHtml(att.name)}</span>
        </div>
      `
    )
    .join('')
  return `<div class="attachment-list">${html}</div>`
}

function renderUserText(text) {
  if (!text) return ''
  return escapeHtml(text).replace(/\r?\n/g, '<br/>')
}

function renderModelSegments(segments) {
  if (!segments.length) return ''
  return segments
    .map((segment) => {
      if (segment.type === 'code') {
        return `
          <div class="code-block">
            <pre><code>${escapeHtml(segment.content)}</code></pre>
          </div>
        `
      }
      if (segment.type === 'prompt') {
        return `<div>${escapeHtml(segment.htmlContent)}</div>`
      }
      return segment.htmlContent || ''
    })
    .join('')
}

function getDefaultSystemSummary(message) {
  if (message.status === 'streaming') return 'Streaming response'
  if (message.status === 'error') return 'Generation failed'
  if (message.status === 'cancelled') return 'Generation cancelled'
  return 'No additional parameters'
}

function renderSystemBubble({ message, indicators, thoughtHtml, hasThoughts }) {
  const fallback = getDefaultSystemSummary(message)
  const summaryItems =
    indicators.length > 0
      ? indicators
          .map((indicator) => {
            const text = escapeHtml(indicator.text || '')
            return `<span class="summary-item">${text}</span>`
          })
          .join('')
      : `<span class="summary-item summary-item--placeholder">${escapeHtml(fallback)}</span>`

  const thoughtId = `thought-${message.id}`
  const headerClass = hasThoughts
    ? 'thought-stream-header thought-toggle-btn'
    : 'thought-stream-header disabled'
  const buttonAttributes = hasThoughts
    ? `type="button" class="${headerClass}" data-target="${thoughtId}" aria-expanded="false" aria-controls="${thoughtId}"`
    : `type="button" class="${headerClass}" disabled`
  const chevron = hasThoughts
    ? `<span class="thought-chevron" aria-hidden="true">${CHEVRON_ICON}</span>`
    : ''
  const thoughtContent = hasThoughts
    ? `<div class="thought-stream-content" id="${thoughtId}" hidden style="display: none;">${thoughtHtml}</div>`
    : ''

  return `
    <div class="system-bubble">
      <div class="thought-stream${hasThoughts ? '' : ' no-thoughts'}">
        <button ${buttonAttributes}>
          <span class="status-icon">
            ${STATUS_ICON}
          </span>
          <span class="system-summary">
            ${summaryItems}
          </span>
          ${chevron}
        </button>
        ${thoughtContent}
      </div>
    </div>
  `
}

function buildSystemMeta(message, provider) {
  const resolvedProvider =
    provider || getProviderById(message?.configSnapshot?.providerId)
  if (!resolvedProvider) return ''

  if (resolvedProvider.buildMetadataHtmlForExport) {
    return resolvedProvider.buildMetadataHtmlForExport(message)
  }
  if (resolvedProvider.buildMetadataHtml) {
    return resolvedProvider
      .buildMetadataHtml(message)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => `<div class="metadata-item">${line}</div>`)
      .join('')
  }
  return ''
}

function renderErrorAlert(message) {
  if (message.status !== 'error') return ''
  const error = message.metadata?.error
  if (!error) return ''
  return `<div class="message-alert error">${escapeHtml(error)}</div>`
}

async function buildMessageHtml(message) {
  const senderLabel = message.sender === 'user' ? 'User' : 'Model'
  const timestamp = formatTimestamp(message.createdAt)
  const bubbleClass = message.sender === 'user' ? 'bubble-user' : 'bubble-model'
  const provider = getProviderById(message?.configSnapshot?.providerId)
  let systemIndicators = []
  if (provider?.buildDisplayIndicators) {
    try {
      systemIndicators = provider.buildDisplayIndicators(message) || []
    } catch (error) {
      console.warn('Failed to build system indicators for export:', error)
    }
  }

  let mainContent = ''
  if (message.sender === 'user') {
    mainContent = `<div class="plain-user-text">${renderUserText(
      message.content?.text ?? ''
    )}</div>`
  } else {
    const segments = await parseModelResponse(message.content?.text ?? '')
    mainContent = `<div class="prose">${renderModelSegments(segments)}</div>`
  }

  let systemBubbleHtml = ''
  let metadataHtml = ''
  if (message.sender === 'model') {
    const rawThoughts = message.runtime?.system?.thoughts?.rawText ?? ''
    let thoughtSegmentsHtml = ''
    let hasThoughts = false
    if (rawThoughts && rawThoughts.trim()) {
      try {
        const thoughtSegments = await parseModelResponse(rawThoughts)
        thoughtSegmentsHtml = renderModelSegments(thoughtSegments)
        hasThoughts = thoughtSegments.length > 0
      } catch (error) {
        console.warn('Failed to parse thoughts for export:', error)
      }
    }
    const shouldRenderSystem =
      systemIndicators.length > 0 ||
      hasThoughts ||
      message.status === 'streaming'
    if (shouldRenderSystem) {
      systemBubbleHtml = renderSystemBubble({
        message,
        indicators: systemIndicators,
        thoughtHtml: thoughtSegmentsHtml,
        hasThoughts,
      })
    }
    metadataHtml = buildSystemMeta(message, provider)
  }

  const metadataBlock = metadataHtml
    ? `<div class="metadata">${metadataHtml}</div>`
    : ''
  const attachmentsHtml = renderAttachments(message.attachments)
  const errorAlert = renderErrorAlert(message)

  return `
    <div class="message-wrapper">
      <div class="message-header">
        <div class="sender-info">
          <span class="sender-name">${senderLabel}</span>
          ${timestamp ? `<span class="message-timestamp">${timestamp}</span>` : ''}
        </div>
      </div>
      <div class="message-body">
        ${systemBubbleHtml}
        <div class="message-bubble ${bubbleClass}">
          ${errorAlert}
          ${mainContent}
          ${metadataBlock}
        </div>
        ${attachmentsHtml}
      </div>
    </div>
  `
}

export async function exportChatAsHTML(chat, messages) {
  if (!chat || !Array.isArray(messages)) return ''

  const title = chat.title || 'Chat Export'
  const messageHtmlList = await Promise.all(
    messages.map((message) => buildMessageHtml(message))
  )

  return `
    <!DOCTYPE html>
    <html lang="ja">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>${escapeHtml(title)}</title>
        <style>
          :root {
            --primary-color: #4f46e5;
            --text-color: #1f2937;
            --bg-color: #ffffff;
            --bg-gray: #f3f4f6;
            --border-color: #e5e7eb;
            --user-message-bg: #f0f9ff;
            --bot-message-bg: #ffffff;
            --shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
            --border-radius: 8px;
            --text-light: #6b7280;
            --danger-color: #dc2626;
          }

          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            line-height: 1.5;
            background-color: var(--bg-gray);
            color: var(--text-color);
            margin: 0;
            padding: 32px 16px;
          }

          .chat-window {
            padding: 16px 24px;
            max-width: 800px;
            margin: auto;
            background-color: var(--bg-color);
            border-radius: 16px;
            box-shadow: 0 10px 30px rgba(15, 23, 42, 0.08);
          }

          .chat-header {
            padding-bottom: 24px;
            border-bottom: 1px solid var(--border-color);
            margin-bottom: 24px;
          }

          .chat-title {
            font-size: 24px;
            font-weight: 600;
            margin: 0;
          }

          .message-list {
            display: flex;
            flex-direction: column;
            gap: 24px;
          }

          .message-wrapper {
            display: flex;
            flex-direction: column;
            gap: 4px;
          }

          .message-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 0 4px;
          }

          .sender-info {
            display: flex;
            align-items: center;
            gap: 8px;
          }

          .sender-name {
            font-weight: 600;
            font-size: 14px;
            color: var(--text-color);
          }

          .message-timestamp {
            font-size: 11px;
            color: var(--text-light);
          }

          .message-body {
            display: flex;
            flex-direction: column;
            gap: 8px;
          }

          .thought-stream {
            display: flex;
            flex-direction: column;
          }

          .thought-stream-header {
            display: flex;
            align-items: center;
            gap: 12px;
            width: 100%;
            padding: 10px 16px;
            background: none;
            border: none;
            color: inherit;
            font: inherit;
            text-align: left;
            cursor: pointer;
          }

          .status-icon {
            display: flex;
            align-items: center;
            justify-content: center;
            width: 24px;
            height: 24px;
            border-radius: 9999px;
            color: var(--primary-color);
            flex-shrink: 0;
          }

          .status-icon-svg {
            width: 16px;
            height: 16px;
          }

          .system-summary {
            display: flex;
            align-items: center;
            gap: 12px;
            flex-wrap: wrap;
            font-size: 12px;
            color: var(--text-light);
            flex: 1;
          }

          .summary-item {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            position: relative;
            padding-left: 10px;
          }

          .summary-item::before {
            content: '';
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background-color: var(--primary-color);
            position: absolute;
            left: 0;
            top: 50%;
            transform: translateY(-50%);
          }

          .summary-item--placeholder {
            font-style: italic;
            padding-left: 0;
          }

          .summary-item--placeholder::before {
            display: none;
          }

          .thought-chevron {
            display: inline-flex;
            align-items: center;
            color: var(--text-light);
          }

          .chevron-icon {
            width: 16px;
            height: 16px;
          }

          .thought-stream-content {
            font-size: 13px;
            color: var(--text-color);
            display: flex;
            flex-direction: column;
            gap: 6px;
            padding: 12px 16px 16px;
          }

          .message-bubble {
            width: 100%;
            padding: 16px 24px;
            border-radius: var(--border-radius);
            border: 1px solid var(--border-color);
            box-shadow: var(--shadow-sm);
            background-color: var(--bot-message-bg);
            box-sizing: border-box;
          }

          .bubble-user {
            background-color: var(--user-message-bg);
          }

          .prose {
            font-size: 14px;
            line-height: 1.5;
            color: var(--text-color);
            word-wrap: break-word;
          }

          .plain-user-text {
            white-space: pre-wrap;
            word-break: break-word;
            font-size: 14px;
            line-height: 1.5;
            color: var(--text-color);
          }

          .metadata {
            margin-top: 8px;
            padding-top: 8px;
            border-top: 1px solid var(--border-color);
            display: flex;
            flex-direction: column;
            gap: 4px;
            font-size: 12px;
            line-height: 1.3;
            color: var(--text-light);
            align-self: flex-start;
            max-width: 100%;
          }

          .metadata-item {
            display: block;
          }

          .attachment-list {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            padding-top: 8px;
          }

          .attachment-chip {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            background-color: var(--bot-message-bg);
            color: var(--text-color);
            padding: 6px 12px;
            box-shadow: var(--shadow-sm);
            border: 1px solid var(--border-color);
            border-radius: 16px;
            font-size: 13px;
          }

          .message-alert {
            margin-bottom: 12px;
            padding: 12px;
            border-radius: var(--border-radius);
            font-size: 14px;
          }

          .message-alert.error {
            background-color: rgba(220, 38, 38, 0.1);
            border: 1px solid rgba(220, 38, 38, 0.4);
            color: var(--danger-color);
          }

          .code-block {
            background-color: #0d1117;
            color: #f0f6fc;
            font-family: ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, monospace;
            border-radius: 6px;
            margin: 1em 0;
            overflow: hidden;
          }

          .code-block pre {
            padding: 16px;
            overflow-x: auto;
            white-space: pre;
            word-wrap: normal;
            margin: 0;
          }

          .code-block code {
            background-color: transparent;
            color: inherit;
            padding: 0;
            font-size: 1em;
          }
        </style>
      </head>
      <body>
        <div class="chat-window">
          <div class="chat-header">
            <h2 class="chat-title">${escapeHtml(title)}</h2>
          </div>
          <div class="message-list">
            ${messageHtmlList.join('\n')}
          </div>
        </div>
        <script>
          (function () {
            document.querySelectorAll('.thought-toggle-btn').forEach(function (button) {
              const targetId = button.getAttribute('data-target')
              if (!targetId) return
              const target = document.getElementById(targetId)
              if (!target) return

              function toggleThought() {
                const expanded = button.getAttribute('aria-expanded') === 'true'
                const nextState = !expanded
                button.setAttribute('aria-expanded', String(nextState))
                if (nextState) {
                  target.removeAttribute('hidden')
                  target.style.display = 'block'
                  return
                }
                target.setAttribute('hidden', '')
                target.style.display = 'none'
              }

              button.addEventListener('click', function (event) {
                event.preventDefault()
                toggleThought()
              })

              button.addEventListener('keydown', function (event) {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  toggleThought()
                }
              })
            })
          })();
        </script>
      </body>
    </html>
  `
}
