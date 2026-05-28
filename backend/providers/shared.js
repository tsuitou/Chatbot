export function supportsServerSideToolInvocations(features = {}) {
  return features?.includeServerSideToolInvocations === true
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
