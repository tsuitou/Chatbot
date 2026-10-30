import { getRuntime } from './runtime'
import { showWarningToast } from '../notification'

// Browser-only replacement for services/api.js (swapped in by vite.config.js
// for the PWA build); same exports, answered by the in-browser runtime.

export const getModels = async () => {
  const runtime = await getRuntime()
  if (!runtime.hasProvider()) {
    showWarningToast(
      'No API key is set. Add one in Data Management → Configuration.'
    )
  }
  return runtime.listModelGroups()
}

export const getModelCapabilities = async (modelName, providerId) => {
  try {
    return await (
      await getRuntime()
    ).getModelCapabilities(modelName, providerId)
  } catch (error) {
    console.error(`Failed to fetch capabilities for ${modelName}:`, error)
    throw error
  }
}

export const getDefaultModel = async () => (await getRuntime()).defaultModel()

/**
 * @param {File} file
 * @param {{ model?: string, providerId?: string | null, onProgress?: (percent: number) => void }} [options]
 */
export const uploadFile = async (file, { model, providerId } = {}) => {
  try {
    return await (
      await getRuntime()
    ).uploadFile(file, {
      mimeType: file.type || 'application/octet-stream',
      displayName: file.name,
      model,
      provider: providerId,
    })
  } catch (error) {
    console.error('File upload failed:', error)
    throw error
  }
}
