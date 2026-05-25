export function createProviderRegistry(providers = []) {
  const entries = providers.filter((entry) => entry?.provider)
  const byId = new Map(entries.map((entry) => [entry.id, entry]))

  return {
    get(providerId) {
      return byId.get(providerId)?.provider || null
    },

    has(providerId) {
      return byId.has(providerId)
    },

    groups() {
      return entries.map((entry) => ({
        provider: entry.id,
        label: entry.label,
        models: entry.provider.listModels(),
      }))
    },

    resolveProviderId(modelName, hint) {
      if (hint && byId.has(hint)) return hint
      const normalized = String(modelName || '').replace(/^models\//, '')
      for (const [id, entry] of byId) {
        const prefixes = Array.isArray(entry.modelPrefixes) ? entry.modelPrefixes : []
        if (prefixes.some((p) => normalized.startsWith(p))) return id
      }
      return entries[0]?.id || null
    },
  }
}
