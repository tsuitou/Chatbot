import express from 'express'
import cors from 'cors'
import { createServer } from 'http'
import { Server } from 'socket.io'
import { GoogleGenAI, createPartFromUri } from '@google/genai'
import multer from 'multer'
import fs from 'fs'
import path from 'path'
import readline from 'readline'
import dotenv from 'dotenv'

// --- Environment Loading ---
const runtimeFilename = typeof __filename === 'string'
  ? __filename
  : (process.argv[1] ? path.resolve(process.argv[1]) : process.execPath)
const runtimeDirname = typeof __dirname === 'string'
  ? __dirname
  : path.dirname(runtimeFilename)

function resolveEnvPath() {
  if (process.env.APP_ENV_FILE) {
    return process.env.APP_ENV_FILE
  }

  const cwdCandidate = path.resolve(process.cwd(), 'backend.env')
  if (fs.existsSync(cwdCandidate)) {
    return cwdCandidate
  }

  const siblingCandidate = path.resolve(runtimeDirname, 'backend.env')
  if (fs.existsSync(siblingCandidate)) {
    return siblingCandidate
  }

  return null
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
    const candidate = path.resolve(process.cwd(), 'system_instruction.txt')
    if (fs.existsSync(candidate)) {
      return fs.readFileSync(candidate, 'utf-8')
    }
    const sibling = path.resolve(runtimeDirname, 'system_instruction.txt')
    if (fs.existsSync(sibling)) {
      return fs.readFileSync(sibling, 'utf-8')
    }
    return undefined
  })()
  console.log('Config reloaded.')
}

// --- Init ---
reloadConfig();
const app = express()

// --- Static Frontend ---
const staticDir = path.join(runtimeDirname, 'dist')
app.use('/chatbot', express.static(staticDir))
app.get(/^\/chatbot(?:\/.*)?$/, (_req, res) => {
  res.sendFile(path.join(staticDir, 'index.html'))
})

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
const io = new Server(httpServer, { cors: { origin: allowed.length ? allowed : '*' }, maxHttpBufferSize: 20 * 1024 * 1024 })

function resolveApiKey() {
  const envKey = (process.env.GEMINI_API_KEY || '').trim()
  if (envKey) return envKey

  // First check for key_valid files
  const validCandidatePaths = [
    path.resolve(process.cwd(), 'key_valid'),
    path.resolve(runtimeDirname, 'key_valid'),
  ]

  for (const keyPath of validCandidatePaths) {
    try {
      if (fs.existsSync(keyPath)) {
        const raw = fs.readFileSync(keyPath, 'utf-8').trim()
        if (raw) return raw
      }
    } catch (error) {
      console.warn(`Failed to read API key from ${keyPath}:`, error)
    }
  }

  // Then check for regular key files and rename them if they contain valid keys
  const candidatePaths = [
    path.resolve(process.cwd(), 'key'),
    path.resolve(runtimeDirname, 'key'),
  ]

  for (const keyPath of candidatePaths) {
    try {
      if (fs.existsSync(keyPath)) {
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

const genAI = new GoogleGenAI({ apiKey })

const DUMMY_MODEL_NAME = 'dummy'

// Ensure uploads dir exists for Multer temp files
fs.mkdirSync('uploads', { recursive: true })



const upload = multer({ dest: 'uploads/' })

// --- Helpers ---
const normalizeModelName = (name) => (name || '').replace(/^models\//, '')
const numberOr = (v, fallback) => (v === undefined ? fallback : Number(v))
const updateConnectionInfo = (id, newStatus)  => ( newStatus === 'disconnect' ? delete connectionInfo[id] : connectionInfo[id] = { status: newStatus }  )

// --- HTTP API ---

// Health check
app.get('/healthz', (_req, res) => res.json({ ok: true }))

// List models
app.get('/api/models', async (_req, res) => {
  try {
    const pager = await genAI.models.list()
    const names = [DUMMY_MODEL_NAME]
    for await (const m of pager) {
      if (filterKeywords.some(keyword => m.name.includes(keyword.trim()))) {
        names.push(normalizeModelName(m.name))
      }
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

// Get configurable ranges for a given model (temperature, topP, maxOutputTokens, optional thinkingBudget ranges)
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
    const details = await genAI.models.get({ model: modelName })
    const maxOutputTokens = Number(details?.outputTokenLimit)

    const config = {
      temperature: { min: 0.0, max: 2.0},
      topP: { min: 0.0, max: 1.0},
      maxOutputTokens: { max: maxOutputTokens},
    }

    // Optional: thinkingBudget ranges from local file (best-effort)
    try {
      const txt = fs.readFileSync('thinking_budget_ranges.json', 'utf-8')
      const ranges = JSON.parse(txt)
      const hit = Array.isArray(ranges) ? ranges.find(r => modelName.includes(r.modelQuery)) : null
      if (hit?.ranges) config.thinkingBudget = { ranges: hit.ranges }
    } catch {}
    res.json(config)
  } catch (error) {
    console.error('config-ranges error:', error?.status, error?.message)
    res.status(500).json({ error: 'Failed to get model config ranges', message: error?.message })
  }
})

// Upload file via Files API returns the ACTIVE file metadata
app.post('/api/files/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.', message: 'No file uploaded.' })

  try {
    const uploaded = await genAI.files.upload({
      file: req.file.path,
      config: { mimeType: req.file.mimetype, displayName: req.file.originalname },
    })

    let file = await genAI.files.get({ name: uploaded.name })
    while (file.state === 'PROCESSING') {
      await new Promise(r => setTimeout(r, 2000))
      file = await genAI.files.get({ name: uploaded.name })
    }

    if (file.state !== 'ACTIVE') {
      throw new Error(`File processing failed: ${file.state}`)
    }

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
      if (!config.systemInstruction) config.systemInstruction = defaultSystemInstruction
      const normalizedModel = normalizeModelName(modelName)
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
			const textGeneration = {
					model: modelName,
					contents,
					config,
			}
			const imageGeneration = {
					model: modelName,
					contents,
			}
			const request = (modelName.includes('image')) ? imageGeneration : textGeneration 
      if (streaming) {
        const stream = await genAI.models.generateContentStream(request)
        for await (const chunk of stream) {
          socket.emit('chunk', {
            chatId,
            requestId,
            parts: chunk.candidates?.[0]?.content?.parts,
            usage: chunk.usageMetadata,
            finishReason: chunk.candidates?.[0]?.finishReason,
            grounding: chunk.candidates?.[0]?.groundingMetadata,
          })
        }
        socket.emit('end_generation', { ok: true, chatId, requestId })
      } else {
        const result = await genAI.models.generateContent(request)
        const response = result
        socket.emit('chunk', {
          chatId,
          requestId,
          parts: response?.candidates?.[0]?.content?.parts,
          usage: response?.usageMetadata,
          finishReason: response?.candidates?.[0]?.finishReason,
          grounding: response?.candidates?.[0]?.groundingMetadata,
        })
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
  }
});

// --- Start server ---
const PORT = process.env.PORT || 15101
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
	console.log('Type "rs" and press Enter to reload config.');
})
