import { uploadFile as apiUploadFile } from '../api'
import { normalizeError as sharedNormalizeError } from './utils'

export const id = 'gemini'
export const label = 'Google Gemini'

export function normalizeError(rawError, phase) {
  return sharedNormalizeError(rawError, phase, id)
}

export async function uploadAttachment(file, { onProgress } = {}) {
  const progressHandler =
    typeof onProgress === 'function' ? onProgress : () => {}
  const uploaded = await apiUploadFile(file, progressHandler)
  return {
    uri: uploaded?.uri ?? null,
    expiresAt: uploaded?.expirationTime ?? uploaded?.expiresAt ?? null,
  }
}
