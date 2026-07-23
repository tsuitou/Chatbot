export function supportsServerSideToolInvocations(features = {}) {
  return features?.includeServerSideToolInvocations === true
}

export function normalizeGeminiUsage(u) {
  if (!u) return null
  const input = u.promptTokenCount ?? null
  const cacheRead = u.cachedContentTokenCount ?? null
  return {
    inputTokens: input,
    uncachedInputTokens:
      input != null && cacheRead != null ? Math.max(0, input - cacheRead) : null,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: null,
    outputTokens: u.candidatesTokenCount ?? null,
    reasoningTokens: u.thoughtsTokenCount ?? null,
    totalTokens: u.totalTokenCount ?? null,
  }
}
