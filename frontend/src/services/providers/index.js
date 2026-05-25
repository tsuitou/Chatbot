import * as gemini from './gemini'
import * as claude from './claude'

const registry = {
  [gemini.id]: gemini,
  [claude.id]: claude,
}

const fallbackProviderId = gemini.id

export function getProviderById(providerId) {
  if (providerId && registry[providerId]) {
    return registry[providerId]
  }
  return registry[fallbackProviderId]
}

export function listProviders() {
  return Object.values(registry)
}

export function getDefaultProviderId() {
  return fallbackProviderId
}
