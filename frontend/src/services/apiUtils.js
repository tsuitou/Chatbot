export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    if (!blob) {
      reject(new Error('No blob provided for base64 conversion.'))
      return
    }
    const reader = new FileReader()
    reader.onloadend = () => {
      if (reader.error) {
        reject(reader.error)
        return
      }
      const result = reader.result
      if (typeof result !== 'string') {
        reject(new Error('Failed to read blob as data URL.'))
        return
      }
      const [, base64String = ''] = result.split(',')
      resolve(base64String)
    }
    reader.onerror = () => {
      reject(reader.error || new Error('Failed to read blob as data URL.'))
    }
    reader.readAsDataURL(blob)
  })
}

export function normalizeError(rawError, phase, providerId) {
  const status = rawError?.status || 500
  let code = 'E_UNKNOWN'
  if (status === 400) code = 'E_BAD_REQUEST'
  if (status === 401) code = 'E_UNAUTHORIZED'
  if (status === 403) code = 'E_FORBIDDEN'
  if (status === 429) code = 'E_RATE_LIMIT'
  if (status >= 500) code = 'E_BACKEND'
  return {
    code,
    message:
      rawError?.message || rawError?.error || 'An unknown error occurred.',
    status,
    phase,
    retryable: status >= 500,
    provider: providerId,
  }
}

export function base64ToBlob(base64, mimeType) {
  const byteCharacters = atob(base64)
  const byteNumbers = new Array(byteCharacters.length)
  for (let i = 0; i < byteCharacters.length; i++) {
    byteNumbers[i] = byteCharacters.charCodeAt(i)
  }
  const byteArray = new Uint8Array(byteNumbers)
  return new Blob([byteArray], { type: mimeType })
}
