// Presentation details of a message shared by the Message component and the
// HTML exporter, so an exported chat reads the same as the app.

export function senderLabel(sender) {
  return sender === 'user' ? 'User' : 'Model'
}

export function formatTimestamp(createdAt) {
  if (!createdAt) return ''
  try {
    const locale =
      typeof navigator !== 'undefined' && navigator.language
        ? navigator.language
        : undefined
    return new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(createdAt))
  } catch (error) {
    console.error('Failed to format message timestamp:', error)
    return ''
  }
}

export function formatDuration(ms) {
  if (typeof ms !== 'number' || isNaN(ms)) return '- s'
  const totalSeconds = ms / 1000
  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(1)}s`
  }
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = Math.floor(totalSeconds % 60)
  return `${minutes}m ${seconds}s`
}

// Shown in the status bubble when there are no parameter indicators.
export function defaultSystemSummary(status, isStreaming = false) {
  if (isStreaming) return 'Streaming response'
  if (status === 'error') return 'Generation failed'
  if (status === 'cancelled') return 'Generation cancelled'
  return 'No additional parameters'
}

// Failed generations are stored as completed with finishReason 'error' and
// the reason in metadata.error (provider error, lost connection, stall...).
export function errorText(message) {
  const metadata = message?.metadata
  if (metadata?.finishReason !== 'error') return ''
  return typeof metadata.error === 'string' ? metadata.error : ''
}
