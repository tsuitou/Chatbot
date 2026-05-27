import * as gemini from './gemini'
import * as claude from './claude'

const registry = {
  [gemini.id]: gemini,
  [claude.id]: claude,
}

const defaultProviderId = gemini.id

export function getProviderById(providerId) {
  if (providerId && registry[providerId]) {
    return registry[providerId]
  }
  return registry[defaultProviderId]
}

export function listProviders() {
  return Object.values(registry)
}

export function getDefaultProviderId() {
  return defaultProviderId
}
