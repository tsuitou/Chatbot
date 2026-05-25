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
import { runAgentSession } from './agent/runner.js'
import { makeResolveFirstExisting } from './utils.js'

const normalizeBasePath = (raw) => {
  if (!raw || typeof raw !== 'string') return '/chatbot'
  const trimmed = raw.trim()
  const withLeading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  return withLeading.replace(/\/+$/, '') || '/chatbot'
}
const escapeForRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

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

// --- Config Loading ---
let defaultSystemInstruction;

function reloadConfig() {
  defaultSystemInstruction = process.env.DEFAULT_SYSTEM_INSTRUCTION ?? (() => {
    const candidate = resolveFirstExisting('system_instruction.txt', 'file')
    return candidate ? fs.readFileSync(candidate, 'utf-8') : undefined
  })()
  console.log('Config reloaded.')
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
    gemini: (process.env.GEMINI_API_KEY || '').trim(),
    claude: (process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY || '').trim(),
  }

  // First check for key_valid files
  const validCandidatePaths = Array.from(new Set([
    resolveFirstExisting('key_valid', 'file'),
    resolveFirstExisting(path.join('backend', 'key_valid'), 'file'),
  ].filter(Boolean)))

  for (const keyPath of validCandidatePaths) {
    try {
      const parsed = parseKeyFile(fs.readFileSync(keyPath, 'utf-8'))
      keys.gemini ||= parsed.gemini || ''
      keys.claude ||= parsed.claude || ''
    } catch (error) {
      console.warn(`Failed to read API key from ${keyPath}:`, error)
    }
  }

  // Then check for regular key files and rename them if they contain valid keys
  const candidatePaths = Array.from(new Set([
    resolveFirstExisting('key', 'file'),
    resolveFirstExisting(path.join('backend', 'key'), 'file'),
  ].filter(Boolean)))

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
  throw new Error('No provider API key found. Set GEMINI_API_KEY or CLAUDE_API_KEY.')
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
  ? new GeminiProvider(providerKeys.gemini, defaultSystemInstruction, { capabilitiesPath: geminiCapabilitiesPath })
  : null
const claudeProvider = providerKeys.claude
  ? new ClaudeProvider(providerKeys.claude, defaultSystemInstruction, { capabilitiesPath: claudeCapabilitiesPath })
  : null
const providerRegistry = createProviderRegistry([
  { id: 'gemini', label: 'Google Gemini', provider: geminiProvider },
  { id: 'claude', label: 'Anthropic Claude', provider: claudeProvider, modelPrefixes: ['claude-'] },
])

const DUMMY_MODEL_NAME = 'dummy'

// Agent model definitions: virtual name -> actual base model mapping
const AGENT_MODELS = {
  'agent-deep-research': true,
}

// Helper to check if a model name is an agent model
const isAgentModel = (modelName) => modelName in AGENT_MODELS

// Ensure uploads dir exists for Multer temp files
const uploadsDir = path.resolve(runtimeDirname, 'uploads')
fs.mkdirSync(uploadsDir, { recursive: true })

const upload = multer({ dest: uploadsDir })

// --- Helpers ---
const normalizeModelName = (name) => (name || '').replace(/^models\//, '')
const resolveProviderId = (modelName, hint) =>
  providerRegistry.resolveProviderId(modelName, hint) || 'gemini'
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

// --- HTTP API ---
const apiRouter = express.Router()

// Health check under BASE_PATH
app.get(`${BASE_PATH}/healthz`, (_req, res) => res.json({ ok: true }))

// List models
apiRouter.get('/models', async (_req, res) => {
  try {
    const groups = [
      {
        provider: 'virtual',
        label: 'Special',
        models: [
          DUMMY_MODEL_NAME,
          ...(geminiProvider ? Object.keys(AGENT_MODELS) : []),
        ],
      },
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

// Get configurable ranges for a given model.
// Use a regex route so model names may include slashes (e.g. "publishers/.../models/...").
apiRouter.get(/^\/models\/(.+)\/config-ranges$/, async (req, res) => {
  try {
    const modelName = req.params[0]
    if (normalizeModelName(modelName) === DUMMY_MODEL_NAME) {
      return res.json({
        temperature: { min: 0.0, max: 0.0 },
        topP: { min: 0.0, max: 0.0 },
        maxOutputTokens: { max: 0 },
      })
    }
    if (isAgentModel(normalizeModelName(modelName))) {
      return res.json({
        temperature: { min: 0.0, max: 0.0 },
        topP: { min: 0.0, max: 1.0 },
        maxOutputTokens: { max: 0 },
      })
    }

    const providerId = resolveProviderId(modelName, req.query.provider)
    const ranges = await providerRegistry
      .get(providerId)
      ?.getModelConfigRanges(modelName)
    if (!ranges) {
      return res.status(404).json({ error: 'Provider not available', message: 'Provider not available for model.' })
    }
    res.json(ranges);
  } catch (error) {
    console.error('config-ranges error:', error?.status, error?.message)
    res.status(500).json({ error: 'Failed to get model config ranges', message: error?.message })
  }
})

// Upload file via Files API
apiRouter.post('/files/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.', message: 'No file uploaded.' })
  if (!geminiProvider) return res.status(503).json({ error: 'Gemini provider unavailable', message: 'Gemini provider unavailable.' })

  try {
    const file = await geminiProvider.uploadFile(req.file.path, req.file.mimetype, req.file.originalname);
    try { fs.unlinkSync(req.file.path) } catch {}
    res.json(file)
  } catch (error) {
    console.error('upload error:', error?.status, error?.message)
    try { if (req.file?.path) fs.unlinkSync(req.file.path) } catch {}
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
      contents,
      messages,
      model: modelName,
      config,
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

      // Check if this is an agent model
      if (isAgentModel(normalizedModel)) {
        if (!providerKeys.gemini) throw new Error('Gemini API key is required for agent models')
        if (!Array.isArray(contents)) throw new Error('contents must be an array')
        const agentBaseModel = process.env.AGENT_BASE_MODEL
        await runAgentSession({
          apiKey: providerKeys.gemini,
          baseModel: agentBaseModel,
          defaultSystemInstruction,
          userSystemInstruction: config?.systemInstruction,
          requestConfig: config || {},
          contents,
          socket,
          chatId,
          requestId,
        })
        return
      }

      if (normalizedModel === DUMMY_MODEL_NAME) {
        const chunkPayload = {
          chatId,
          requestId,
          parts: [{ text: '' }],
        }
        socket.emit('chunk', chunkPayload)
        socket.emit('end_generation', { ok: true, chatId, requestId, finishReason: 'stop' })
        return
      }

      const providerInstance = providerRegistry.get(providerId)
      if (!providerInstance) throw new Error(`${providerId || 'Requested'} provider is not configured`)
      const history = messages ?? contents
      if (!Array.isArray(history)) throw new Error('messages must be an array')
      if (streaming) {
        const stream = providerInstance.generateStream(modelName, history, config || {}, chatId, requestId);
        for await (const chunk of stream) {
          socket.emit('chunk', chunk)
        }
        socket.emit('end_generation', { ok: true, chatId, requestId })
      } else {
        const response = await providerInstance.generate(modelName, history, config || {}, chatId, requestId);
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

// --- Stdin for reload ---
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

rl.on('line', (input) => {
  if (input.trim() === 'rs') {
    reloadConfig();
    geminiProvider?.setDefaultSystemInstruction(defaultSystemInstruction)
    claudeProvider?.setDefaultSystemInstruction(defaultSystemInstruction)
  }
});

// --- Start server ---
const PORT = process.env.PORT || 15101
const HOST = process.env.HOST || '0.0.0.0'
httpServer.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}${BASE_PATH}`)
	console.log('Type "rs" and press Enter to reload config.');
})
