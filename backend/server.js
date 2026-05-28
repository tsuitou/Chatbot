import express from 'express'
import cors from 'cors'
import { createServer } from 'http'
import { Server } from 'socket.io'
import multer from 'multer'
import fs from 'fs'
import path from 'path'
import readline from 'readline'
import { fileURLToPath } from 'url'
import dotenv from 'dotenv'
import { GeminiProvider } from './providers/gemini.js'
import { ClaudeProvider } from './providers/claude.js'
import { createProviderRegistry } from './providers/registry.js'
import { createSpecialRegistry } from './specialModels.js'
import { makeResolveFirstExisting } from './utils.js'
import { normalizeSystemInstructionMode } from './systemInstruction.js'

const normalizeBasePath = (raw) => {
  if (!raw || typeof raw !== 'string') return '/chatbot'
  const trimmed = raw.trim()
  const withLeading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  return withLeading.replace(/\/+$/, '') || '/chatbot'
}
const escapeForRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const parseByteSize = (value, fallback) => {
  if (typeof value !== 'string' || !value.trim()) return fallback
  const match = value
    .trim()
    .toLowerCase()
    .match(/^(\d+(?:\.\d+)?)\s*(b|kb|kib|mb|mib|gb|gib)?$/)
  if (!match) return fallback
  const amount = Number(match[1])
  if (!Number.isFinite(amount) || amount <= 0) return fallback
  const multipliers = {
    b: 1,
    kb: 1024,
    kib: 1024,
    mb: 1024 ** 2,
    mib: 1024 ** 2,
    gb: 1024 ** 3,
    gib: 1024 ** 3,
  }
  return Math.floor(amount * multipliers[match[2] || 'b'])
}

// --- Path Helpers ---
const runtimeFilename = fileURLToPath(import.meta.url)
const runtimeDirname = path.dirname(runtimeFilename)
const projectRoot = path.resolve(runtimeDirname, '..')

const baseDirs = Array.from(new Set([runtimeDirname, projectRoot, process.cwd()]))
const resolveFirstExisting = makeResolveFirstExisting(baseDirs)

function resolveEnvPath() {
  if (process.env.APP_ENV_FILE) {
    return path.isAbsolute(process.env.APP_ENV_FILE)
      ? process.env.APP_ENV_FILE
      : path.resolve(process.cwd(), process.env.APP_ENV_FILE)
  }

  return resolveFirstExisting('backend.env', 'file')
}

const envPath = resolveEnvPath()
if (envPath) {
  dotenv.config({ path: envPath })
  console.log(`Loaded environment from ${envPath}`)
} else {
  dotenv.config()
  console.log('Loaded environment from process.env (no external backend.env found).')
}

const BASE_PATH = normalizeBasePath(process.env.BASE_PATH)
const API_PREFIX = `${BASE_PATH}/api`
const SOCKET_PATH = `${BASE_PATH}/socket.io`
const MAX_UPLOAD_FILE_SIZE = parseByteSize(
  process.env.MAX_UPLOAD_FILE_SIZE,
  10 * 1024 * 1024
)

// --- Config Loading ---
let defaultSystemInstruction;
let systemInstructionMode;

function reloadConfig() {
  defaultSystemInstruction = process.env.DEFAULT_SYSTEM_INSTRUCTION ?? (() => {
    const candidate = resolveFirstExisting('system_instruction.txt', 'file')
    return candidate ? fs.readFileSync(candidate, 'utf-8') : undefined
  })()
  systemInstructionMode = normalizeSystemInstructionMode(
    process.env.SYSTEM_INSTRUCTION_MODE
  )
  console.log('Config reloaded.')
}

function applyReloadedConfig() {
  reloadConfig()
  geminiProvider?.setDefaultSystemInstruction(
    defaultSystemInstruction,
    systemInstructionMode
  )
  claudeProvider?.setDefaultSystemInstruction(
    defaultSystemInstruction,
    systemInstructionMode
  )
}

// --- Init ---
reloadConfig();
const app = express()

// CORS: production whitelist if ALLOWED_ORIGINS is empty, allow all (dev)
const allowed = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

app.use(cors({
  origin(origin, cb) {
    if (!origin || allowed.length === 0 || allowed.includes(origin)) return cb(null, true)
    return cb(new Error('Not allowed by CORS'))
  },
  credentials: true,
}))

const httpServer = createServer(app)
const io = new Server(httpServer, {
  cors: { origin: allowed.length ? allowed : '*' },
  maxHttpBufferSize: 10 * 1024 * 1024,
  path: SOCKET_PATH,
})

function parseKeyFile(raw) {
  const trimmed = raw.trim()
  if (!trimmed) return {}
  try {
    const parsed = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object') {
      return {
        gemini: String(parsed.gemini || '').trim(),
        claude: String(parsed.claude || parsed.anthropic || '').trim(),
      }
    }
  } catch {}
  // Plain text: auto-detect provider by key prefix
  if (trimmed.startsWith('sk-ant-')) return { claude: trimmed }
  return { gemini: trimmed }
}

function hasProviderKey(keys) {
  return Boolean(keys?.gemini || keys?.claude)
}

function resolveProviderKeys() {
  const keys = {
    gemini: '',
    claude: '',
  }

  // First check for key_valid files in cwd and runtimeDirname (do not go up directories)
  const validCandidatePaths = Array.from(new Set([
    path.join(process.cwd(), 'key_valid'),
    path.join(runtimeDirname, 'key_valid'),
  ])).filter(p => {
    try {
      return fs.existsSync(p) && fs.statSync(p).isFile()
    } catch {
      return false
    }
  })

  for (const keyPath of validCandidatePaths) {
    try {
      const parsed = parseKeyFile(fs.readFileSync(keyPath, 'utf-8'))
      keys.gemini ||= parsed.gemini || ''
      keys.claude ||= parsed.claude || ''
    } catch (error) {
      console.warn(`Failed to read API key from ${keyPath}:`, error)
    }
  }

  // Then check for regular key files in cwd and runtimeDirname and rename them if they contain valid keys
  const candidatePaths = Array.from(new Set([
    path.join(process.cwd(), 'key'),
    path.join(runtimeDirname, 'key'),
  ])).filter(p => {
    try {
      return fs.existsSync(p) && fs.statSync(p).isFile()
    } catch {
      return false
    }
  })

  for (const keyPath of candidatePaths) {
    try {
      const raw = fs.readFileSync(keyPath, 'utf-8').trim()
      const parsed = parseKeyFile(raw)
      if (hasProviderKey(parsed)) {
        // Rename key to key_valid to prevent accidental distribution
        const validKeyPath = keyPath.replace(/key$/, 'key_valid')
        try {
          fs.renameSync(keyPath, validKeyPath)
          console.log(`Renamed ${path.basename(keyPath)} to ${path.basename(validKeyPath)} for security`)
        } catch (renameError) {
          console.warn(`Could not rename key file: ${renameError.message}`)
        }
        keys.gemini ||= parsed.gemini || ''
        keys.claude ||= parsed.claude || ''
      }
    } catch (error) {
      console.warn(`Failed to read API key from ${keyPath}:`, error)
    }
  }

  return keys
}

const providerKeys = resolveProviderKeys()
if (!providerKeys.gemini && !providerKeys.claude) {
  console.error('\n======================================================================')
  console.error('❌ Error: No provider API key found!')
  console.error('Please configure at least one API key using the following method:')
  console.error('Place a "key" file containing your API key(s) in the execution directory.')
  console.error('Format (JSON or text):')
  console.error('  JSON:  {"gemini": "YOUR_GEMINI_KEY", "claude": "YOUR_CLAUDE_KEY"}')
  console.error('  Plain: YOUR_GEMINI_KEY')
  console.error('======================================================================\n')
  process.exit(1)
}

const modelFilterKeywords = (process.env.MODEL_FILTER || '')
  .split(',')
  .map((keyword) => keyword.trim().toLowerCase())
  .filter(Boolean)
const connectionInfo = {}

// Initialize Provider
const geminiCapabilitiesPath = resolveFirstExisting(path.join('capabilities', 'gemini.json'), 'file')
const claudeCapabilitiesPath = resolveFirstExisting(path.join('capabilities', 'claude.json'), 'file')
const geminiProvider = providerKeys.gemini
  ? new GeminiProvider(providerKeys.gemini, defaultSystemInstruction, {
      capabilitiesPath: geminiCapabilitiesPath,
      systemInstructionMode,
    })
  : null
const claudeProvider = providerKeys.claude
  ? new ClaudeProvider(providerKeys.claude, defaultSystemInstruction, {
      capabilitiesPath: claudeCapabilitiesPath,
      systemInstructionMode,
    })
  : null
const providerRegistry = createProviderRegistry([
  { id: 'gemini', provider: geminiProvider },
  { id: 'claude', provider: claudeProvider, modelPrefixes: ['claude-'] },
])

const specialRegistry = createSpecialRegistry({ providerKeys })

// Ensure uploads dir exists for Multer temp files
const uploadsDir = path.resolve(runtimeDirname, 'uploads')
fs.mkdirSync(uploadsDir, { recursive: true })

const upload = multer({
  dest: uploadsDir,
  limits: { fileSize: MAX_UPLOAD_FILE_SIZE },
})

// --- Helpers ---
const normalizeModelName = (name) => (name || '').replace(/^models\//, '')
const resolveProviderId = (modelName, hint) =>
  providerRegistry.resolveProviderId(modelName, hint) || 'gemini'

function isMimeAllowedByPolicy(mimeType, allowedMimes) {
  if (!allowedMimes) return true
  const list = Array.isArray(allowedMimes) ? allowedMimes : []
  if (list.includes(mimeType)) return true
  return list.some(
    (pattern) =>
      typeof pattern === 'string' &&
      pattern.endsWith('/*') &&
      mimeType.startsWith(pattern.slice(0, -1))
  )
}

function cleanupUploadedFile(file) {
  try {
    if (file?.path) fs.unlinkSync(file.path)
  } catch {}
}

function handleUploadMiddleware(req, res, next) {
  upload.single('file')(req, res, (error) => {
    if (!error) {
      next()
      return
    }
    cleanupUploadedFile(req.file)
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({
        error: 'File too large',
        message: `Attachments must be smaller than ${MAX_UPLOAD_FILE_SIZE} bytes.`,
      })
      return
    }
    res.status(400).json({
      error: 'Upload failed',
      message: error?.message || 'Upload failed.',
    })
  })
}
const filterModelNames = (names = []) => {
  const list = Array.isArray(names) ? names : []
  if (!modelFilterKeywords.length) return list
  return list.filter((name) => {
    const normalized = String(name || '').toLowerCase()
    return modelFilterKeywords.some((keyword) => normalized.includes(keyword))
  })
}
const numberOr = (v, fallback) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}
const updateConnectionInfo = (id, newStatus)  => ( newStatus === 'disconnect' ? delete connectionInfo[id] : connectionInfo[id] = { status: newStatus }  )
const getConnectedClientCount = () => io.engine?.clientsCount ?? 0
const requestFrontendReload = () => {
  io.emit('frontend_reload', {
    requestedAt: new Date().toISOString(),
    reason: 'backend-command',
  })
  console.log(`Frontend reload requested for ${getConnectedClientCount()} client(s).`)
}

// --- HTTP API ---
const apiRouter = express.Router()

// Health check under BASE_PATH
app.get(`${BASE_PATH}/healthz`, (_req, res) => res.json({ ok: true }))

// List models
apiRouter.get('/models', async (_req, res) => {
  try {
    const groups = [
      { provider: 'virtual', label: specialRegistry.label, models: specialRegistry.list() },
    ]

    for (const group of providerRegistry.groups()) {
      groups.push({
        provider: group.provider,
        label: group.label,
        models: filterModelNames(await group.models),
      })
    }

    res.json(groups.filter(group => group.models.length > 0))
  } catch (error) {
    console.error('models list error:', error?.status, error?.message)
    res.status(500).json({ error: 'Failed to fetch models', message: error?.message })
  }
})

// Get default model name (plain text). Prefer .env DEFAULT_MODEL
apiRouter.get('/models/default', async (_req, res) => {
  try {
    const configured = process.env.DEFAULT_MODEL
    if (configured) {
      return res.type('text/plain').send(normalizeModelName(configured))
    }
    // Fallback empty if none found
    return res.type('text/plain').send('')
  } catch (error) {
    console.error('default-model error:', error?.status, error?.message)
    return res.status(500).type('text/plain').send('')
  }
})

apiRouter.get(/^\/models\/(.+)\/capabilities$/, async (req, res) => {
  try {
    const modelName = req.params[0]
    const normalized = normalizeModelName(modelName)
    if (specialRegistry.isSpecial(normalized)) {
      return res.json(specialRegistry.capabilities(normalized))
    }

    const providerId = resolveProviderId(modelName, req.query.provider)
    const capabilities = await providerRegistry
      .get(providerId)
      ?.getModelCapabilities(modelName)
    if (!capabilities) {
      return res.status(404).json({ error: 'Provider not available', message: 'Provider not available for model.' })
    }
    res.json(capabilities)
  } catch (error) {
    console.error('capabilities error:', error?.status, error?.message)
    res.status(500).json({ error: 'Failed to get model capabilities', message: error?.message })
  }
})

// Upload file via Files API
apiRouter.post('/files/upload', handleUploadMiddleware, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.', message: 'No file uploaded.' })

  try {
    const modelName = normalizeModelName(req.query.model)
    if (!modelName) {
      cleanupUploadedFile(req.file)
      return res.status(400).json({
        error: 'Model required',
        message: 'Model is required for file upload.',
      })
    }
    const providerId = resolveProviderId(modelName, req.query.provider)
    const providerInstance = providerRegistry.get(providerId)
    if (!providerInstance) {
      cleanupUploadedFile(req.file)
      return res.status(404).json({
        error: 'Provider not available',
        message: 'Provider not available for file upload.',
        provider: providerId,
        model: modelName,
      })
    }
    if (typeof providerInstance.uploadFile !== 'function') {
      cleanupUploadedFile(req.file)
      return res.status(400).json({
        error: 'File upload unsupported',
        message: 'File upload is not supported for this model.',
        provider: providerId,
        model: modelName,
      })
    }
    const capabilities =
      typeof providerInstance.getModelCapabilities === 'function'
        ? await providerInstance.getModelCapabilities(modelName)
        : null
    const attachmentPolicy = capabilities?.attachments || {}
    if (
      attachmentPolicy.enabled !== true ||
      attachmentPolicy.allowRemoteUpload !== true ||
      !isMimeAllowedByPolicy(req.file.mimetype, attachmentPolicy.allowedMimes)
    ) {
      cleanupUploadedFile(req.file)
      return res.status(400).json({
        error: 'File upload unsupported',
        message: 'File upload is not supported for this model or file type.',
        provider: providerId,
        model: modelName,
      })
    }
    const file = await providerInstance.uploadFile(req.file.path, req.file.mimetype, req.file.originalname);
    cleanupUploadedFile(req.file)
    res.json(file)
  } catch (error) {
    console.error('upload error:', error?.status, error?.message)
    cleanupUploadedFile(req.file)
    const status = numberOr(error?.status, 500)
    res.status(status).json({ error: 'Failed to process file', message: error?.message })
  }
})

app.use(API_PREFIX, apiRouter)

// --- Static Frontend ---
const staticDir = resolveFirstExisting('dist', 'dir') || resolveFirstExisting(path.join('frontend', 'dist'), 'dir')
if (staticDir) {
  app.use(BASE_PATH, express.static(staticDir))
  const basePathPattern = new RegExp(`^${escapeForRegex(BASE_PATH)}(?:/(?!api)(.*))?$`)
  app.get(basePathPattern, (_req, res) => {
    res.sendFile(path.join(staticDir, 'index.html'))
  })
  console.log(`Serving static assets from ${staticDir} at ${BASE_PATH}`)
} else {
  console.warn('No static frontend dist directory found. Skipping static asset hosting.')
}

// --- Socket.IO for generation ---
io.on('connection', (socket) => {
	updateConnectionInfo(socket.id, 'connected')
	console.log(connectionInfo)
	
  socket.on("disconnect", () => {
		updateConnectionInfo(socket.id, 'disconnect')
		console.log(connectionInfo)
  });
	
  socket.on('start_generation', async (data) => {
    const {
      provider,
      messages,
      model: modelName,
      parameters,
      tools,
      systemInstruction,
      streaming,
      chatId,
      requestId,
    } = data ?? {}

    const echoErr = (err) => {
      const status = numberOr(err?.status, 500)
      const message = err?.message || 'generation failed'
      socket.emit('error', { error: message, message, status, chatId, requestId })
    }
		updateConnectionInfo(socket.id, 'generating')
		console.log(connectionInfo)
    try {
      if (!modelName) throw new Error('model is required')
      
      const normalizedModel = normalizeModelName(modelName)
      const providerId = resolveProviderId(normalizedModel, provider)

      if (specialRegistry.isSpecial(normalizedModel)) {
        await specialRegistry.handle(normalizedModel, socket, data, {
          defaultSystemInstruction,
          systemInstructionMode,
        })
        return
      }

      const providerInstance = providerRegistry.get(providerId)
      if (!providerInstance) throw new Error(`${providerId || 'Requested'} provider is not configured`)
      if (!Array.isArray(messages)) throw new Error('messages must be an array')
      const request = {
        provider: providerId,
        chatId,
        requestId,
        model: modelName,
        messages,
        parameters: parameters || {},
        tools: tools || {},
        systemInstruction: systemInstruction || '',
      }
      if (streaming) {
        const stream = providerInstance.generateStream(request);
        for await (const chunk of stream) {
          socket.emit('chunk', chunk)
        }
        socket.emit('end_generation', { ok: true, chatId, requestId })
      } else {
        const response = await providerInstance.generate(request);
        socket.emit('chunk', response)
        socket.emit('end_generation', { ok: true, chatId, requestId })
      }
    } catch (error) {
      console.error('generation error:', error?.status, error?.message)
      echoErr(error)
    } finally {
			updateConnectionInfo(socket.id, 'connected')
			console.log(connectionInfo)
		}
  })
})

// --- Stdin commands ---
function printCommandHelp() {
  console.log('Commands: rs = reload config, rf = reload frontend, help = show commands.')
}

function handleStdinCommand(input) {
  const command = input.trim().toLowerCase()
  if (!command) return

  if (command === 'rs' || command === 'reload-config') {
    applyReloadedConfig()
    return
  }

  if (command === 'rf' || command === 'reload-frontend') {
    requestFrontendReload()
    return
  }

  if (command === 'help' || command === '?') {
    printCommandHelp()
    return
  }

  console.log(`Unknown command: ${command}`)
  printCommandHelp()
}

if (process.stdin.isTTY) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  rl.on('line', handleStdinCommand)
} else {
  console.log('Stdin commands disabled because stdin is not a TTY.')
}

// --- Start server ---
const PORT = process.env.PORT || 15101
const HOST = process.env.HOST || '0.0.0.0'
httpServer.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}${BASE_PATH}`)
  if (process.stdin.isTTY) {
    printCommandHelp()
  }
})
