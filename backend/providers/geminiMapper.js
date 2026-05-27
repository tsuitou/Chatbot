export function buildGeminiTools(tools = {}, toolCapabilities = null) {
  const enabled = (key) => !toolCapabilities || toolCapabilities[key]?.enabled
  const result = []
  if (tools.urlContext && enabled('urlContext')) result.push({ urlContext: {} })
  if (tools.codeExecution && enabled('codeExecution')) {
    result.push({ codeExecution: {} })
  }
  if (tools.grounding && enabled('grounding')) result.push({ googleSearch: {} })
  return result
}

export function buildGeminiPart(part) {
  if (part?.type === 'text') return { text: part.text || '' }
  if (part?.type === 'file' && part.remoteUri) {
    return { fileData: { mimeType: part.mimeType, fileUri: part.remoteUri } }
  }
  if (part?.type === 'file' && part.data) {
    return { inlineData: { mimeType: part.mimeType, data: part.data } }
  }
  return null
}

export function buildGeminiContents(messages = []) {
  return messages.map((message) => {
    const parts = []
    const signatures = []
    for (const part of message.parts || []) {
      if (part?.type === 'thoughtSignature') {
        signatures.push(part)
        continue
      }
      const converted = buildGeminiPart(part)
      if (converted) parts.push(converted)
    }
    if (!parts.length) parts.push({ text: '' })
    for (const signature of signatures) {
      const target = parts[signature.partIndex] || parts[0]
      if (target && signature.signature) {
        target.thoughtSignature = signature.signature
      }
    }
    return { role: message.role, parts }
  })
}
