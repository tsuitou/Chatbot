import * as gemini from './gemini'

const registry = {
  [gemini.id]: gemini,
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
