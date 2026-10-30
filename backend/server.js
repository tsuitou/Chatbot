import express from 'express'
import cors from 'cors'
import { createServer } from 'http'
import { Server } from 'socket.io'
import multer from 'multer'
import fs from 'fs'
import path from 'path'
import readline from 'readline'
import os from 'os'
import { fileURLToPath } from 'url'
import dotenv from 'dotenv'
import { createRuntime } from './runtime.js'
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
// Socket.IO frames carry the whole request (history + base64-inline attachments),
// so the buffer must exceed MAX_UPLOAD_FILE_SIZE: base64 inflates payloads by ~4/3
// and the conversation history adds more on top. Default to that headroom and
// allow an explicit override via MAX_SOCKET_BUFFER_SIZE.
const MAX_SOCKET_BUFFER_SIZE = parseByteSize(
  process.env.MAX_SOCKET_BUFFER_SIZE,
  Math.ceil(MAX_UPLOAD_FILE_SIZE * (4 / 3)) + 2 * 1024 * 1024
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
  runtime.setDefaultSystemInstruction(
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
  maxHttpBufferSize: MAX_SOCKET_BUFFER_SIZE,
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
        openrouter: String(parsed.openrouter || '').trim(),
      }
    }
  } catch {}
  // Plain text: auto-detect provider by key prefix
  if (trimmed.startsWith('sk-or-')) return { openrouter: trimmed }
  if (trimmed.startsWith('sk-ant-')) return { claude: trimmed }
  return { gemini: trimmed }
}

function hasProviderKey(keys) {
  return Boolean(keys?.gemini || keys?.claude || keys?.openrouter)
}

function resolveProviderKeys() {
  const keys = {
    gemini: '',
    claude: '',
    openrouter: '',
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
      keys.openrouter ||= parsed.openrouter || ''
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
        // Rename key to key_valid to prevent accidental distribution.
        const validKeyPath = keyPath.replace(/key$/, 'key_valid')
        try {
          // renameSync overwrites the destination on POSIX but throws on Windows
          // when it already exists; remove it first for consistent behavior.
          if (fs.existsSync(validKeyPath)) {
            fs.rmSync(validKeyPath, { force: true })
          }
          fs.renameSync(keyPath, validKeyPath)
          console.log(`Renamed ${path.basename(keyPath)} to ${path.basename(validKeyPath)} for security`)
        } catch (renameError) {
          console.warn(`Could not rename key file: ${renameError.message}`)
        }
        keys.gemini ||= parsed.gemini || ''
        keys.claude ||= parsed.claude || ''
        keys.openrouter ||= parsed.openrouter || ''
      }
    } catch (error) {
      console.warn(`Failed to read API key from ${keyPath}:`, error)
    }
  }

  return keys
}

const providerKeys = resolveProviderKeys()
if (
  !providerKeys.gemini &&
  !providerKeys.claude &&
  !providerKeys.openrouter &&
  !(process.env.OPENAI_COMPAT_CONFIG || '').trim()
) {
  console.warn('\n======================================================================')
  console.warn('⚠️  Warning: No provider API key found.')
  console.warn('The server will start, but no model will be available until a key is configured.')
  console.warn('To enable a provider, place a "key" file containing your API key(s) in the execution directory.')
  console.warn('Format (JSON or text):')
  console.warn('  JSON:  {"gemini": "YOUR_GEMINI_KEY", "claude": "YOUR_CLAUDE_KEY", "openrouter": "YOUR_OPENROUTER_KEY"}')
  console.warn('  Plain: YOUR_GEMINI_KEY')
  console.warn('======================================================================\n')
}

const connectionInfo = {}

function loadCapabilities(providerId) {
  const capPath = resolveFirstExisting(path.join('capabilities', `${providerId}.json`), 'file')
  if (!capPath) {
    console.warn(`No capabilities file found for ${providerId}.`)
    return null
  }
  try {
    return JSON.parse(fs.readFileSync(capPath, 'utf-8'))
  } catch (error) {
    console.warn(`Failed to load capabilities from ${capPath}:`, error)
    return null
  }
}

// OpenAI-compatible endpoints (vLLM etc.): OPENAI_COMPAT_CONFIG points to a
// JSON file describing one endpoint or an array of them.
function loadOpenAICompatConfig() {
  const raw = (process.env.OPENAI_COMPAT_CONFIG || '').trim()
  if (!raw) return null
  const configPath = path.isAbsolute(raw)
    ? raw
    : resolveFirstExisting(raw, 'file') || path.resolve(process.cwd(), raw)
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'))
  } catch (error) {
    console.warn(`Failed to load OpenAI-compatible config from ${configPath}:`, error.message)
    return null
  }
}

const runtime = createRuntime({
  keys: providerKeys,
  settings: {
    geminiModelFilter: process.env.GEMINI_MODEL_FILTER,
    claudeModelFilter: process.env.CLAUDE_MODEL_FILTER,
    defaultModel: process.env.DEFAULT_MODEL,
    systemInstructionMode,
    openrouterModels: process.env.OPENROUTER_MODELS,
    openrouterAppUrl: process.env.OPENROUTER_APP_URL,
    openrouterAppTitle: process.env.OPENROUTER_APP_TITLE,
  },
  capabilities: Object.fromEntries(
    ['gemini', 'claude', 'openrouter', 'openai-compat'].map((id) => [id, loadCapabilities(id)])
  ),
  openaiCompatConfig: loadOpenAICompatConfig(),
  defaultSystemInstruction,
})
if (runtime.openaiCompatIds.length) {
  console.log(
    `Registered ${runtime.openaiCompatIds.length} OpenAI-compatible endpoint(s): ${runtime.openaiCompatIds.join(', ')}`
  )
}

// Ensure uploads dir exists for Multer temp files. In packaged (SEA) builds the
// runtime dir may be read-only, so fall back to the OS temp dir.
let uploadsDir = path.resolve(runtimeDirname, 'uploads')
try {
  fs.mkdirSync(uploadsDir, { recursive: true })
} catch (error) {
  console.warn(
    `Could not create uploads dir at ${uploadsDir}: ${error.message}. Falling back to OS temp dir.`
  )
  uploadsDir = path.join(os.tmpdir(), 'chatbot-uploads')
  fs.mkdirSync(uploadsDir, { recursive: true })
}

// Best-effort cleanup of leftover temp files from a previous crash. Safe at
// startup because no requests are in flight yet.
try {
  for (const entry of fs.readdirSync(uploadsDir)) {
    try {
      fs.unlinkSync(path.join(uploadsDir, entry))
    } catch {}
  }
} catch {}

const upload = multer({
  dest: uploadsDir,
  limits: { fileSize: MAX_UPLOAD_FILE_SIZE },
})

// --- Helpers ---
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
const numberOr = (v, fallback) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}
const updateConnectionInfo = (id, newStatus)  => ( newStatus === 'disconnect' ? delete connectionInfo[id] : connectionInfo[id] = { status: newStatus }  )
const STREAM_CHUNK_ACK_TIMEOUT_MS = numberOr(
  process.env.STREAM_CHUNK_ACK_TIMEOUT_MS,
  5000
)

function emitWithAck(socket, event, payload, timeoutMs = STREAM_CHUNK_ACK_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    socket.timeout(timeoutMs).emit(event, payload, (error, response) => {
      if (error) {
        reject(error)
        return
      }
      if (response && response.ok === false) {
        reject(new Error(response.message || `${event} was not acknowledged`))
        return
      }
      resolve(response)
    })
  })
}

function abortGeneration(activeGeneration, reason) {
  if (!activeGeneration?.controller || activeGeneration.controller.signal.aborted) {
    return false
  }
  activeGeneration.abortReason = reason || 'aborted'
  activeGeneration.controller.abort()
  return true
}
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
    res.json(await runtime.listModelGroups())
  } catch (error) {
    console.error('models list error:', error?.status, error?.message)
    res.status(500).json({ error: 'Failed to fetch models', message: error?.message })
  }
})

// Get default model name (plain text). Prefer .env DEFAULT_MODEL
apiRouter.get('/models/default', async (_req, res) => {
  try {
    // Empty if none is configured
    return res.type('text/plain').send(runtime.defaultModel())
  } catch (error) {
    console.error('default-model error:', error?.status, error?.message)
    return res.status(500).type('text/plain').send('')
  }
})

apiRouter.get(/^\/models\/(.+)\/capabilities$/, async (req, res) => {
  try {
    res.json(await runtime.getModelCapabilities(req.params[0], req.query.provider))
  } catch (error) {
    if (error?.status === 404) {
      return res.status(404).json({ error: 'Provider not available', message: error.message })
    }
    console.error('capabilities error:', error?.status, error?.message)
    res.status(500).json({ error: 'Failed to get model capabilities', message: error?.message })
  }
})

// Upload file via Files API
apiRouter.post('/files/upload', handleUploadMiddleware, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.', message: 'No file uploaded.' })

  try {
    const file = await runtime.uploadFile(req.file.path, {
      mimeType: req.file.mimetype,
      displayName: req.file.originalname,
      model: req.query.model,
      provider: req.query.provider,
    })
    res.json(file)
  } catch (error) {
    const status = numberOr(error?.status, 500)
    if (status >= 500) console.error('upload error:', error?.status, error?.message)
    res.status(status).json({
      error:
        status === 404
          ? 'Provider not available'
          : status >= 500
            ? 'Failed to process file'
            : 'File upload unsupported',
      message: error?.message,
      ...(error?.provider ? { provider: error.provider, model: error.model } : {}),
    })
  } finally {
    cleanupUploadedFile(req.file)
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
  let activeGeneration = null
  updateConnectionInfo(socket.id, 'connected')
  console.log(connectionInfo)

  socket.on("disconnect", () => {
    abortGeneration(activeGeneration, 'disconnected')
    updateConnectionInfo(socket.id, 'disconnect')
    console.log(connectionInfo)
  });

  socket.on('cancel_generation', ({ chatId, requestId } = {}) => {
    if (activeGeneration?.chatId === chatId && activeGeneration?.requestId === requestId) {
      abortGeneration(activeGeneration, 'cancelled')
    }
  })

  socket.on('start_generation', async (data) => {
    const { chatId, requestId } = data ?? {}

    abortGeneration(activeGeneration, 'superseded')
    let generation = null

    const echoErr = (err) => {
      const status = numberOr(err?.status, 500)
      const message = err?.message || 'generation failed'
      socket.emit('error', { error: message, message, status, chatId, requestId, metadata: err?.metadata })
    }
    updateConnectionInfo(socket.id, 'generating')
    console.log(connectionInfo)
    try {
      const job = runtime.prepareGeneration(data)
      const controller = job.abortable ? new AbortController() : null
      activeGeneration = generation = {
        chatId,
        requestId,
        provider: job.providerId,
        controller,
        abortReason: null,
      }
      for await (const chunk of job.run(controller?.signal)) {
        if (controller) {
          try {
            await emitWithAck(socket, 'chunk', chunk)
          } catch (error) {
            abortGeneration(generation, 'chunk_ack_timeout')
            const err = new Error('Frontend did not acknowledge streamed output.')
            err.status = 499
            err.cause = error
            throw err
          }
        } else {
          socket.emit('chunk', chunk)
        }
      }
      socket.emit('end_generation', { ok: true, chatId, requestId })
    } catch (error) {
      if (generation?.controller?.signal.aborted) {
        socket.emit('end_generation', {
          ok: false,
          aborted: true,
          reason: generation.abortReason || 'aborted',
          chatId,
          requestId,
        })
        return
      }
      console.error('generation error:', error?.status, error?.message)
      echoErr(error)
    } finally {
      if (activeGeneration === generation) {
        activeGeneration = null
        if (socket.connected) updateConnectionInfo(socket.id, 'connected')
        console.log(connectionInfo)
      }
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
