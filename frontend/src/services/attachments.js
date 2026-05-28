import { reactive } from 'vue'
import { v4 as uuidv4 } from 'uuid'
import { read as readXlsx, utils as xlsxUtils } from 'xlsx'
import { showErrorToast } from './notification'
import { MAX_UPLOAD_FILE_SIZE } from './env'

const MAX_ATTACHMENTS = 10

const DEFAULT_ATTACHMENT_POLICY = Object.freeze({
  allowRemoteUpload: true,
  allowedMimes: null,
  maxInlineFileSize: null,
})

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
  'image/gif',
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
    throw new Error(`Could not process Excel file: ${file.name}`, {
      cause: error,
    })
  }
}

async function buildAttachmentRecord(
  file,
  { requiresRemoteUpload = false } = {}
) {
  // Read the file content into memory to break dependency on the original file
  let independentBlob
  try {
    const arrayBuffer = await file.arrayBuffer()
    independentBlob = new Blob([arrayBuffer], { type: file.type })
  } catch {
    // Fallback to cloning
    independentBlob = cloneBlobValue(file, { mimeType: file.type })
  }

  return {
    id: uuidv4(),
    name: file.name,
    mimeType: file.type,
    size: independentBlob?.size ?? file.size,
    source: 'user',
    blob: independentBlob,
    file: null, // Clear original file reference
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
      : MAX_UPLOAD_FILE_SIZE

  function resolvePolicy() {
    const raw =
      typeof options.policy === 'function' ? options.policy() : options.policy
    return {
      ...DEFAULT_ATTACHMENT_POLICY,
      allowRemoteUpload: options.allowRemoteUpload !== false,
      ...(raw || {}),
    }
  }

  function isMimeAllowed(file, policy) {
    if (!policy.allowedMimes) return true
    const allowed = policy.allowedMimes
    const mimeType = file.type || 'application/octet-stream'
    if (allowed instanceof Set && allowed.has(mimeType)) return true
    if (Array.isArray(allowed) && allowed.includes(mimeType)) return true
    const patterns =
      allowed instanceof Set || Array.isArray(allowed) ? allowed : []
    for (const pattern of patterns) {
      if (typeof pattern === 'string' && pattern.endsWith('/*')) {
        const prefix = pattern.slice(0, -1)
        if (mimeType.startsWith(prefix)) return true
      }
    }
    return false
  }

  async function addFiles(fileList) {
    const files = Array.from(fileList || [])
    if (!files.length) return

    if (attachments.length + files.length > maxAttachments) {
      showErrorToast(`Cannot attach more than ${maxAttachments} files.`)
      return
    }

    const policy = resolvePolicy()
    const allowRemoteUpload = policy.allowRemoteUpload !== false
    const maxInlineFileSize =
      typeof policy.maxInlineFileSize === 'number' &&
      policy.maxInlineFileSize > 0
        ? policy.maxInlineFileSize
        : null

    for (const file of files) {
      try {
        const normalized = await normalizeFile(file)
        if (!isMimeAllowed(normalized, policy)) {
          throw new Error(
            `File type not allowed for this model: ${normalized.type || normalized.name}`
          )
        }
        validateFile(normalized)
        if (maxFileSize && normalized.size > maxFileSize) {
          showErrorToast(
            `Attachments must be smaller than ${formatFileSize(maxFileSize)}.`
          )
          continue
        }
        const processed = await convertFile(normalized)
        if (!isMimeAllowed(processed, policy)) {
          throw new Error(
            `File type not allowed for this model: ${processed.type || processed.name}`
          )
        }
        if (maxFileSize && processed.size > maxFileSize) {
          showErrorToast(
            `Attachments must be smaller than ${formatFileSize(maxFileSize)}.`
          )
          continue
        }
        if (
          maxInlineFileSize &&
          processed.size > maxInlineFileSize &&
          !allowRemoteUpload
        ) {
          showErrorToast(
            `Attachments must be smaller than ${formatFileSize(
              maxInlineFileSize
            )} for this model.`
          )
          continue
        }
        const requiresRemoteUpload =
          allowRemoteUpload &&
          maxInlineFileSize &&
          processed.size > maxInlineFileSize
        const record = await buildAttachmentRecord(processed, {
          requiresRemoteUpload,
        })
        attachments.push(record)
        const reactiveAttachment = attachments[attachments.length - 1]
        if (requiresRemoteUpload) {
          void startUpload(reactiveAttachment, processed)
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
      attachments.push(cloned)
    }
    if (rejected) {
      showErrorToast('Some attachments were skipped because of size limits.')
    }
  }

  function isUploadPending(attachment) {
    if (!attachment || attachment.error) return false
    return attachment.uploadProgress !== 100
  }

  function isUnsupported(item) {
    if (!item) return false
    const policy = resolvePolicy()
    const inlineLimit =
      typeof policy.maxInlineFileSize === 'number' &&
      policy.maxInlineFileSize > 0
        ? policy.maxInlineFileSize
        : null
    return (
      policy.enabled !== true ||
      !isMimeAllowed({ type: item.mimeType }, policy) ||
      (maxFileSize && item.size > maxFileSize) ||
      (!policy.allowRemoteUpload && item.remoteUri && !item.blob) ||
      (!policy.allowRemoteUpload && inlineLimit && item.size > inlineLimit)
    )
  }

  function getBlockingIssue() {
    if (attachments.some((item) => item.error)) {
      return 'Some attachments failed to upload. Remove them or try again.'
    }
    if (attachments.some(isUploadPending)) {
      return 'Please wait for attachments to finish uploading.'
    }
    return null
  }

  function dropUnsupportedForCurrentPolicy() {
    const policy = resolvePolicy()
    let unsupportedCount = 0

    for (const item of attachments) {
      if (!policy.allowRemoteUpload && item.remoteUri && item.blob) {
        item.remoteUri = null
      }
      if (isUnsupported(item)) {
        unsupportedCount++
      }
    }

    return unsupportedCount
  }

  function list() {
    return attachments.map((item, index) => ({
      ...cloneAttachment(item),
      order: item.order ?? index,
    }))
  }

  async function startUpload(attachment, file) {
    if (typeof options.uploadFn !== 'function') {
      attachment.error = 'Attachment upload is not supported for this provider.'
      return
    }

    try {
      const result = await options.uploadFn(file, {
        onProgress(percentage) {
          attachment.uploadProgress = percentage
        },
      })
      const remoteUri = result?.uri ?? result?.remoteUri ?? null
      if (!remoteUri) {
        throw new Error('File upload completed without a usable file URI.')
      }
      attachment.uploadProgress = 100
      attachment.remoteUri = remoteUri
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
    getBlockingIssue,
    dropUnsupportedForCurrentPolicy,
    list,
    isUnsupported,
  }
}

export { MAX_ATTACHMENTS, cloneAttachment }
