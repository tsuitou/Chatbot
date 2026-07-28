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
        if (part.signature) signatures.push(String(part.signature))
        continue
      }
      const converted = buildGeminiPart(part)
      if (converted) parts.push(converted)
    }
    if (!parts.length) parts.push({ text: '' })
    if (signatures.length) {
      // Gemini emits the signature that closes the turn on its final text
      // part; earlier ones belong to tool-call parts we don't resend, and
      // gemini-3.6+ rejects them when attached to a text part. Send only the
      // newest signature, and never on a file part.
      const signature = signatures[signatures.length - 1]
      const target = parts.find((p) => typeof p.text === 'string')
      if (target) target.thoughtSignature = signature
      else parts.push({ text: '', thoughtSignature: signature })
    }
    return { role: message.role, parts }
  })
}
