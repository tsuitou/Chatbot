import axios from 'axios'
import axiosRetry from 'axios-retry'

const resolveApiBaseUrl = () => {
  const raw = import.meta.env?.VITE_API_BASE_URL
  if (typeof raw === 'string' && raw.trim().length > 0) {
    return raw.trim().replace(/\/+$/, '')
  }

  if (typeof window !== 'undefined' && window.location?.origin) {
    const origin = window.location.origin.replace(/\/+$/, '')
    return `${origin}/api`
  }

  return '/api'
}

const apiClient = axios.create({
  baseURL: resolveApiBaseUrl(),
  headers: {
    'Content-Type': 'application/json',
  },
})

axiosRetry(apiClient, {
  retries: 3,
  retryDelay: (retryCount) => {
    return retryCount * 1000
  },
  retryCondition: (error) => {
    return (
      axiosRetry.isNetworkError(error) ||
      (error.response &&
        error.response.status >= 500 &&
        error.response.status <= 599)
    )
  },
})

export const getModels = async () => {
  try {
    const response = await apiClient.get('/models')
    return response.data
  } catch (error) {
    console.error('Failed to fetch models:', error)
    throw error
  }
}

export const getConfigRanges = async (modelName) => {
  try {
    const response = await apiClient.get(`/models/${modelName}/config-ranges`)
    return response.data
  } catch (error) {
    console.error(`Failed to fetch config ranges for ${modelName}:`, error)
    throw error
  }
}

export const getDefaultModel = async () => {
  try {
    const response = await apiClient.get('/models/default')
    return response.data
  } catch (error) {
    console.error('Failed to fetch default model:', error)
    throw error
  }
}

export const uploadFile = async (file, onProgress) => {
  const formData = new FormData()
  formData.append('file', file)

  try {
    const response = await apiClient.post('/files/upload', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
      onUploadProgress: (progressEvent) => {
        const percentCompleted = Math.round(
          (progressEvent.loaded * 100) / progressEvent.total
        )
        if (typeof onProgress === 'function') {
          onProgress(percentCompleted)
        }
      },
    })
    return response.data
  } catch (error) {
    console.error('File upload failed:', error)
    throw error
  }
}
