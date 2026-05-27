import { normalizeError as sharedNormalizeError } from './utils'

export const id = 'claude'
export const label = 'Anthropic Claude'

export function normalizeError(rawError, phase) {
  return sharedNormalizeError(rawError, phase, id)
}
