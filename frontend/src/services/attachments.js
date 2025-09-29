import { reactive } from 'vue'
import { v4 as uuidv4 } from 'uuid'
import { read as readXlsx, utils as xlsxUtils } from 'xlsx'
import { showErrorToast } from './notification'
import { getDefaultProviderId, getProviderById } from './providers'

const MAX_FILE_SIZE_DEFAULT = 10 * 1024 * 1024 // 10MB
const MAX_ATTACHMENTS = 10

function cloneBlobValue(value, { mimeType } = {}) {
  if (!value) return null

  const fallbackType =
    mimeType || (typeof value.type === 'string' && value.type)
  const resolvedType = fallbackType || 'application/octet-stream'

  if (typeof Blob !== 'undefined' && value instanceof Blob) {
    return value.slice(0, value.size, resolvedType)
  }

  return value
}

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let size = bytes
  let unitIndex = 0
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex += 1
  }
  return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}

const ALLOWED_MIMES = new Set([
  'text/plain',
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'video/x-flv',
  'video/quicktime',
  'video/mpeg',
  'video/mpg',
  'video/mp4',
  'video/webm',
  'video/wmv',
  'video/3gpp',
  'video/mpegps',
  'audio/aac',
  'audio/flac',
  'audio/mpeg',
  'audio/mpga',
  'audio/m4a',
  'audio/opus',
  'audio/pcm',
  'audio/wav',
  'audio/ogg',
  'audio/webm',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel.sheet.macroEnabled.12',
])

const EXCEL_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel.sheet.macroEnabled.12',
])

const TEXT_EXTENSIONS = new Set([
  'txt',
  'md',
  'markdown',
  'mdx',
  'csv',
  'tsv',
  'json',
  'jsonl',
  'yaml',
  'yml',
  'xml',
  'html',
  'htm',
  'css',
  'js',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'jsx',
  'py',
  'pyw',
  'ipynb',
  'java',
  'kt',
  'kts',
  'scala',
  'groovy',
  'go',
  'rs',
  'rb',
  'php',
  'phtml',
  'pl',
  'pm',
  'swift',
  'c',
  'h',
  'cc',
  'cxx',
  'cpp',
  'hh',
  'hpp',
  'm',
  'mm',
  'cs',
  'sh',
  'bash',
  'zsh',
  'ksh',
  'bat',
  'cmd',
  'ps1',
  'psm1',
  'sql',
  'ini',
  'toml',
  'cfg',
  'conf',
  'env',
  'proto',
  'thrift',
  'graphql',
  'gql',
  'tex',
  'jl',
  'lua',
  'dart',
  'hs',
  'ml',
  'mli',
  'vue',
  'svelte',
  'sol',
  'nim',
  'erl',
  'ex',
  'exs',
  'r',
  'gradle',
  'properties',
])

function isMediaFile(file) {
  return file.type.startsWith('video/') || file.type.startsWith('audio/')
}

function resolveExtension(name) {
  return name?.split('.')?.pop()?.toLowerCase() || ''
}

async function normalizeFile(file) {
  const extension = resolveExtension(file.name)

  if (file.type && file.type !== 'application/octet-stream') {
    if (!ALLOWED_MIMES.has(file.type) && TEXT_EXTENSIONS.has(extension)) {
      return new File([file], file.name, { type: 'text/plain' })
    }
    return file
  }

  if (TEXT_EXTENSIONS.has(extension)) {
    return new File([file], file.name, { type: 'text/plain' })
  }

  return file
}

function validateFile(file) {
  if (!ALLOWED_MIMES.has(file.type)) {
    throw new Error(`File type not allowed: ${file.type || file.name}`)
  }

  const isMedia = isMediaFile(file)
  if (!isMedia && file.size > MAX_FILE_SIZE_DEFAULT) {
    throw new Error(
      `File size exceeds ${MAX_FILE_SIZE_DEFAULT / 1024 / 1024}MB limit: ${file.name}`
    )
  }
}

async function convertFile(file) {
  if (!EXCEL_MIMES.has(file.type)) {
    return file
  }

  try {
    const arrayBuffer = await file.arrayBuffer()
    const workbook = readXlsx(arrayBuffer)
    let fullText = ''
    workbook.SheetNames.forEach((sheetName) => {
      const worksheet = workbook.Sheets[sheetName]
      const text = xlsxUtils.sheet_to_csv(worksheet)
      fullText += `--- Sheet: ${sheetName} ---\n${text}\n\n`
    })

    const newBlob = new Blob([fullText], { type: 'text/plain' })
    return new File([newBlob], `${file.name}.txt`, { type: 'text/plain' })
  } catch (error) {
    console.error('Failed to convert Excel file:', error)
    throw new Error(`Could not process Excel file: ${file.name}`)
  }
}

function buildAttachmentRecord(file) {
  const requiresRemoteUpload =
    isMediaFile(file) && file.size > MAX_FILE_SIZE_DEFAULT

  return {
    id: uuidv4(),
    name: file.name,
    mimeType: file.type,
    size: file.size,
    source: 'user',
    blob: file,
    remoteUri: null,
    uploadProgress: requiresRemoteUpload ? 0 : 100,
    error: null,
    expirationTime: null,
  }
}

function cloneAttachment(attachment) {
  const sanitizedBlob = cloneBlobValue(attachment?.blob || attachment?.file, {
    mimeType: attachment?.mimeType,
  })
  return {
    id: attachment.id ?? uuidv4(),
    name: attachment.name ?? 'attachment',
    mimeType: attachment.mimeType ?? 'application/octet-stream',
    size: attachment.size ?? 0,
    source: attachment.source ?? 'user',
    blob: sanitizedBlob,
    file: null,
    remoteUri: attachment.remoteUri ?? null,
    uploadProgress: attachment.uploadProgress ?? 100,
    error: attachment.error ?? null,
    expirationTime: attachment.expirationTime ?? null,
  }
}

export function createAttachmentBucket(options = {}) {
  const attachments = reactive([])
  const maxAttachments = options.max ?? MAX_ATTACHMENTS
  const maxFileSize =
    typeof options.maxFileSize === 'number' && options.maxFileSize > 0
      ? options.maxFileSize
      : null
  const allowRemoteUpload = options.allowRemoteUpload !== false

  function resolveProvider(providerId) {
    if (options.resolveProvider) {
      return options.resolveProvider(providerId)
    }
    return getProviderById(providerId)
  }

  function currentProviderId(fallback) {
    if (typeof fallback === 'string' && fallback) {
      return fallback
    }
    if (typeof options.defaultProviderId === 'function') {
      const resolved = options.defaultProviderId()
      if (resolved) return resolved
    } else if (typeof options.defaultProviderId === 'string') {
      return options.defaultProviderId
    }
    return getDefaultProviderId()
  }

  async function addFiles(fileList, { providerId } = {}) {
    const files = Array.from(fileList || [])
    if (!files.length) return

    if (attachments.length + files.length > maxAttachments) {
      showErrorToast(`Cannot attach more than ${maxAttachments} files.`)
      return
    }

    const effectiveProviderId = currentProviderId(providerId)
    const provider = resolveProvider(effectiveProviderId)

    for (const file of files) {
      try {
        const normalized = await normalizeFile(file)
        validateFile(normalized)
        const processed = await convertFile(normalized)
        if (maxFileSize && processed.size > maxFileSize) {
          showErrorToast(
            `Attachments must be smaller than ${formatFileSize(maxFileSize)}.`
          )
          continue
        }
        const record = buildAttachmentRecord(processed)
        if (!allowRemoteUpload && record.uploadProgress < 100) {
          const limit = maxFileSize || MAX_FILE_SIZE_DEFAULT
          showErrorToast(
            `Attachments larger than ${formatFileSize(
              limit
            )} cannot be used here.`
          )
          continue
        }
        attachments.push(record)
        const reactiveAttachment = attachments[attachments.length - 1]
        if (reactiveAttachment.uploadProgress < 100 && allowRemoteUpload) {
          void startUpload(reactiveAttachment, processed, provider)
        }
      } catch (error) {
        const message = error?.message || 'Failed to add file.'
        showErrorToast(message)
      }
    }
  }

  function remove(id) {
    const index = attachments.findIndex((item) => item.id === id)
    if (index !== -1) {
      attachments.splice(index, 1)
    }
  }

  function clear() {
    attachments.splice(0, attachments.length)
  }

  function replaceAll(list = []) {
    attachments.splice(0, attachments.length)
    let rejected = false
    for (const item of list) {
      const cloned = cloneAttachment(item)
      if (maxFileSize && cloned.size > maxFileSize) {
        rejected = true
        continue
      }
      if (!allowRemoteUpload && cloned.remoteUri) {
        rejected = true
        continue
      }
      attachments.push(cloned)
    }
    if (rejected) {
      showErrorToast('Some attachments were skipped because of size limits.')
    }
  }

  function list() {
    return attachments.map((item, index) => ({
      ...item,
      order: item.order ?? index,
    }))
  }

  async function startUpload(attachment, file, provider) {
    if (!provider || typeof provider.uploadAttachment !== 'function') {
      attachment.error = 'Attachment upload is not supported for this provider.'
      return
    }

    try {
      const result = await provider.uploadAttachment(file, {
        onProgress(percentage) {
          attachment.uploadProgress = percentage
        },
      })
      attachment.uploadProgress = 100
      attachment.remoteUri = result?.uri ?? result?.remoteUri ?? null
      attachment.blob = null
      if (result?.expiresAt) {
        attachment.expirationTime = result.expiresAt
      }
      attachment.error = null
    } catch (error) {
      console.error('Upload failed for attachment:', attachment.id, error)
      attachment.error = error?.message || 'Upload failed.'
      attachment.uploadProgress = 0
    }
  }

  return {
    items: attachments,
    addFiles,
    remove,
    clear,
    replaceAll,
    list,
  }
}

export { MAX_ATTACHMENTS }
