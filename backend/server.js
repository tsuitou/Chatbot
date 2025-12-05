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
import { runAgentSession } from './agent/runner.js'

// --- Path Helpers ---
const runtimeFilename = fileURLToPath(import.meta.url)
const runtimeDirname = path.dirname(runtimeFilename)
const projectRoot = path.resolve(runtimeDirname, '..')

const baseDirs = Array.from(new Set([runtimeDirname, projectRoot, process.cwd()]))

const resolveFirstExisting = (relativePath, type = 'file') => {
  for (const dir of baseDirs) {
    const candidate = path.resolve(dir, relativePath)
    try {
      const stat = fs.statSync(candidate)
      if (type === 'dir' ? stat.isDirectory() : stat.isFile()) return candidate
    } catch {}
  }
  return null
}

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

// --- Static Frontend ---
const staticDir = resolveFirstExisting('dist', 'dir') || resolveFirstExisting(path.join('frontend', 'dist'), 'dir')
if (staticDir) {
  app.use('/chatbot', express.static(staticDir))
  app.get(/^\/chatbot(?:\/.*)?$/, (_req, res) => {
    res.sendFile(path.join(staticDir, 'index.html'))
  })
  console.log(`Serving static assets from ${staticDir}`)
} else {
  console.warn('No static frontend dist directory found. Skipping static asset hosting.')
}

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
  maxHttpBufferSize: 50 * 1024 * 1024,
  path: '/chatbot/socket.io',
})

function resolveApiKey() {
  const envKey = (process.env.GEMINI_API_KEY || '').trim()
  if (envKey) return envKey

  // First check for key_valid files
  const validCandidatePaths = Array.from(new Set([
    resolveFirstExisting('key_valid', 'file'),
    resolveFirstExisting(path.join('backend', 'key_valid'), 'file'),
  ].filter(Boolean)))

  for (const keyPath of validCandidatePaths) {
    try {
      const raw = fs.readFileSync(keyPath, 'utf-8').trim()
      if (raw) return raw
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
      if (raw && raw.length > 10) { // Basic check for non-empty key
        // Rename key to key_valid to prevent accidental distribution
        const validKeyPath = keyPath.replace(/key$/, 'key_valid')
        try {
          fs.renameSync(keyPath, validKeyPath)
          console.log(`Renamed ${path.basename(keyPath)} to ${path.basename(validKeyPath)} for security`)
        } catch (renameError) {
          console.warn(`Could not rename key file: ${renameError.message}`)
        }
        return raw
      }
    } catch (error) {
      console.warn(`Failed to read API key from ${keyPath}:`, error)
    }
  }

  return null
}

const apiKey = resolveApiKey()
if (!apiKey) {
  throw new Error('GEMINI_API_KEY is not set and no key file found')
}

const filterKeywords = (process.env.MODEL_FILTER || '').split(',')
const connectionInfo = {}

// Initialize Provider
const capabilitiesPath = resolveFirstExisting(path.join('capabilities', 'gemini.json'), 'file')
const geminiProvider = new GeminiProvider(apiKey, defaultSystemInstruction, { capabilitiesPath });

const DUMMY_MODEL_NAME = 'dummy'

// Agent model definitions: virtual name -> actual base model mapping
const AGENT_MODELS = {
  'agent-gemini-2.5-flash': 'gemini-2.5-flash',
  'agent-gemini-2.5-pro': 'gemini-2.5-pro',
  'agent-gemini-3-pro-preview': 'gemini-3-pro-preview',
}

// Helper to check if a model name is an agent model
const isAgentModel = (modelName) => modelName in AGENT_MODELS
const getAgentBaseModel = (modelName) => AGENT_MODELS[modelName]

// Ensure uploads dir exists for Multer temp files
const uploadsDir = path.resolve(runtimeDirname, 'uploads')
fs.mkdirSync(uploadsDir, { recursive: true })

const upload = multer({ dest: uploadsDir })

// --- Helpers ---
const normalizeModelName = (name) => (name || '').replace(/^models\//, '')
const numberOr = (v, fallback) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}
const updateConnectionInfo = (id, newStatus)  => ( newStatus === 'disconnect' ? delete connectionInfo[id] : connectionInfo[id] = { status: newStatus }  )

// --- HTTP API ---

// Health check
app.get('/healthz', (_req, res) => res.json({ ok: true }))

// List models
app.get('/api/models', async (_req, res) => {
  try {
    const names = await geminiProvider.listModels(filterKeywords);
    if (!names.includes(DUMMY_MODEL_NAME)) names.unshift(DUMMY_MODEL_NAME);

    // Add all agent models to the list
    for (const agentModel of Object.keys(AGENT_MODELS).reverse()) {
      if (!names.includes(agentModel)) names.unshift(agentModel);
    }

    res.json(names)
  } catch (error) {
    console.error('models list error:', error?.status, error?.message)
    res.status(500).json({ error: 'Failed to fetch models', message: error?.message })
  }
})

// Get default model name (plain text). Prefer .env DEFAULT_MODEL
app.get('/api/models/default', async (_req, res) => {
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

// Get configurable ranges for a given model
app.get('/api/models/:modelName/config-ranges', async (req, res) => {
  try {
    const { modelName } = req.params
    if (normalizeModelName(modelName) === DUMMY_MODEL_NAME) {
      return res.json({
        temperature: { min: 0.0, max: 0.0 },
        topP: { min: 0.0, max: 0.0 },
        maxOutputTokens: { max: 0 },
      })
    }
    
    const ranges = await geminiProvider.getModelConfigRanges(modelName);
    res.json(ranges);
  } catch (error) {
    console.error('config-ranges error:', error?.status, error?.message)
    res.status(500).json({ error: 'Failed to get model config ranges', message: error?.message })
  }
})

// Upload file via Files API
app.post('/api/files/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.', message: 'No file uploaded.' })

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
      contents,
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
      if (!Array.isArray(contents)) throw new Error('contents must be an array')
      
      const normalizedModel = normalizeModelName(modelName)

      // Check if this is an agent model
      if (isAgentModel(normalizedModel)) {
        const userSelectedModel = getAgentBaseModel(normalizedModel)
        const configWithModel = { ...(config || {}), model: userSelectedModel }
        const agentBaseModel = process.env.AGENT_BASE_MODEL
        await runAgentSession({
          apiKey,
          baseModel: agentBaseModel,
          defaultSystemInstruction,
          userSystemInstruction: config?.systemInstruction,
          requestConfig: configWithModel,
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

      if (streaming) {
        const stream = geminiProvider.generateStream(modelName, contents, config || {}, chatId, requestId);
        for await (const chunk of stream) {
          socket.emit('chunk', chunk)
        }
        socket.emit('end_generation', { ok: true, chatId, requestId })
      } else {
        const response = await geminiProvider.generate(modelName, contents, config || {}, chatId, requestId);
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
    geminiProvider.setDefaultSystemInstruction(defaultSystemInstruction)
  }
});

// --- Start server ---
const PORT = process.env.PORT || 15101
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
	console.log('Type "rs" and press Enter to reload config.');
})
