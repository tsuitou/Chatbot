export function supportsServerSideToolInvocations(modelName) {
  const normalized = String(modelName || '').toLowerCase()
  return normalized.includes('gemini-3') || normalized.includes('gemini-4')
}

export function normalizeGeminiUsage(u) {
  if (!u) return null
  return {
    inputTokens: u.promptTokenCount ?? null,
    outputTokens: u.candidatesTokenCount ?? null,
    reasoningTokens: u.thoughtsTokenCount ?? null,
    totalTokens: u.totalTokenCount ?? null,
  }
}
