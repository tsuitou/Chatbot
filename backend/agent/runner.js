import { GoogleGenAI } from '@google/genai'
import {
  agentAddendumClarify,
  agentAddendumControl,
  agentAddendumPlan,
  agentAddendumResearch,
  agentPersonaInstruction,
  clarifyTurnPrompt,
  controlTurnPrompt,
  criticalAgentRules,
  finalTurnPrompt,
  finalSystemInstruction,
  flowInstruction,
  planTurnPrompt,
  researchTurnPrompt,
  searchPolicyInstruction,
} from './prompts.js'

// Extract control_step action from function calls (handles both object and JSON string args).
function extractStepAction(functionCalls) {
  if (!Array.isArray(functionCalls)) return null
  for (const call of functionCalls) {
    if (call?.name !== 'control_step') continue
    let args = call.args || call.arguments
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args)
      } catch {
        args = null
      }
    }
    if (args && typeof args === 'object') {
      const action = args.action || args.step
      const notes = args.notes || args.message || null
      if (action) return { action, notes }
    }
  }
  return null
}

// Track the last step to detect step transitions
let lastEmittedStep = null

// Mandatory instruction injected into user prompts to enforce urlContext grounding
const mandatoryFinalUrlInstruction =
  'MANDATORY: Final answer must cite and be grounded in urlContext (browse) results for all FINAL_URLS. If URLs cannot be fetched, state the failure and do not answer from memory.'

// Build urlContextMetadata from groundingMetadata if present
function buildUrlContextMetadata(meta) {
  if (!meta || typeof meta !== 'object') return null
  if (meta.urlContextMetadata) return meta.urlContextMetadata
  if (Array.isArray(meta.urlContexts)) return { urlContexts: meta.urlContexts }
  if (Array.isArray(meta.groundingChunks)) {
    const urlContexts = meta.groundingChunks
      .map((chunk) => ({
        uri: chunk?.web?.uri,
        title: chunk?.web?.title,
        passages: chunk?.web?.passages,
      }))
      .filter((c) => c.uri)
    if (urlContexts.length) return { urlContexts }
  }
  return null
}

// Convert Gemini parts into thoughts/answer friendly chunks for the frontend.
function emitContentParts({
  parts = [],
  socket,
  chatId,
  requestId,
  step,
  forceThoughts = false,
  forceAnswer = false,
  debugLog = false,
  urlContextMetadata = null,
}) {
  if (!socket) return
  // Allow emitting metadata-only final chunks by injecting an empty part
  const baseParts =
    step === 'final' && urlContextMetadata && (!parts || !parts.length)
      ? [{ text: '' }]
      : parts || []
  const shapedParts = []
  let hasNonThought = false

  // If FINAL has metadata but no parts, emit a placeholder empty part so frontends receive the metadata chunk
  // Detect step transition and add newline
  const isStepTransition = lastEmittedStep !== null && lastEmittedStep !== step

  for (let i = 0; i < baseParts.length; i++) {
    const part = baseParts[i]
    if (!part) continue
    if (part.text) {
      const thoughtFlag = forceAnswer
        ? false
        : forceThoughts
          ? true
          : !!part.thought

      let text = part.text

      // Add newline at step transition (only for first part)
      if (i === 0 && isStepTransition) {
        text = '\n\n' + text
      }
      // Add newline between thought and answer content
      else if (shapedParts.length > 0 && shapedParts[shapedParts.length - 1].thought && !thoughtFlag) {
        text = '\n' + text
      }

      shapedParts.push({ text, thought: thoughtFlag })
      if (!thoughtFlag) hasNonThought = true
      if (debugLog) {
        console.debug(
          '[agent-debug] part text:',
          JSON.stringify(part.text),
          'thought:',
          thoughtFlag,
          'step:',
          step
        )
      }
    }
  }

  if (!shapedParts.length) return

  lastEmittedStep = step

  // Only emit urlContextMetadata on FINAL
  const chunkPayload = {
    chatId,
    requestId,
    step,
    parts: shapedParts,
    provider: 'gemini',
  }
  if (step === 'final' && urlContextMetadata) {
    const grounding = groundingFromUrlContext(urlContextMetadata)
    if (grounding) {
      chunkPayload.grounding = grounding
    }
    chunkPayload.urlContextMetadata = urlContextMetadata
  }
  socket.emit('chunk', chunkPayload)
  return { hasNonThought }
}

function updateGrounding(acc, candidate) {
  const grounding = candidate?.groundingMetadata || candidate?.grounding
  if (!grounding) return
  if (Array.isArray(grounding.webSearchQueries)) {
    for (const q of grounding.webSearchQueries) {
      const trimmed = typeof q === 'string' ? q.trim() : ''
      if (trimmed) acc.queries.add(trimmed)
    }
  }
  if (Array.isArray(grounding.groundingChunks)) {
    for (const chunk of grounding.groundingChunks) {
      const uri = chunk.web?.uri
      const title = chunk.web?.title
      if (uri && title) {
        acc.sources.set(uri, title)
      }
    }
  }
}

function accumulateFromCalls(acc, functionCalls) {
  if (!acc || !Array.isArray(functionCalls)) return
  for (const call of functionCalls) {
    const name = call?.name
    let args = call?.args || call?.arguments
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args)
      } catch {
        args = null
      }
    }
    if (!args || typeof args !== 'object') continue
    if (name === 'googleSearch' && args.query) {
      const q = String(args.query).trim()
      if (q) acc.queries.add(q)
    }
    if (name === 'urlContext' && args.url) {
      const url = String(args.url).trim()
      if (url) acc.sources.set(url, '(from urlContext)')
    }
  }
}

function buildGroundingMetadata(acc) {
  if (!acc) return null
  const sources = []
  if (acc.sources instanceof Map) {
    for (const [uri, title] of acc.sources.entries()) {
      if (uri && title) {
        sources.push({ uri, title })
      }
    }
  }

  const webSearchQueries =
    acc.queries instanceof Set
      ? Array.from(acc.queries)
          .map((q) => (typeof q === 'string' ? q.trim() : ''))
          .filter(Boolean)
      : []

  if (!sources.length && !webSearchQueries.length) return null
  return { sources, webSearchQueries }
}

// Convert urlContextMetadata (urlContexts array) into grounding-like shape for frontend consumption
function groundingFromUrlContext(urlContextMetadata) {
  if (!urlContextMetadata || !Array.isArray(urlContextMetadata.urlContexts)) return null
  const groundingChunks = urlContextMetadata.urlContexts
    .map((c) => {
      const uri = c?.uri
      const title = c?.title || c?.webPage?.title || null
      return uri ? { web: { uri, title: title || '(no title)' } } : null
    })
    .filter(Boolean)
  if (!groundingChunks.length) return null
  return { groundingChunks }
}

function formatGroundingSummary(acc, { maxSources = 10, maxQueries = 10 } = {}) {
  const sources = Array.from(acc.sources.entries())
    .slice(0, maxSources)
    .map(([uri, title]) => `- ${title || '(no title)'} (${uri})`)
  const queries = Array.from(acc.queries).slice(0, maxQueries)
  const parts = []
  if (sources.length) {
    parts.push('Known sources:\n' + sources.join('\n'))
  }
  if (queries.length) {
    parts.push('Search queries used:\n- ' + queries.join('\n- '))
  }
  return parts.join('\n\n')
}

async function streamOnce({
  chat,
  message,
  socket,
  chatId,
  requestId,
  step,
  config,
  forceThoughts = false,
  forceAnswer = false,
  debugLog = false,
  groundingAcc,
  collectText = false,
  extractBlocks = [],
  collectUrlContextMetadata = false,
}) {
  const stream = await chat.sendMessageStream({ message, config })
  const functionCalls = []
  let hasAnswer = false
  let collectedText = ''
  let usageMetadata = null
  let finalUrlContextMetadata = null
  let latestUrlMeta = null

  for await (const chunk of stream) {
    const candidate = chunk?.candidates?.[0] || {}
    const parts = candidate.content?.parts || []
    const urlMeta = collectUrlContextMetadata
      ? buildUrlContextMetadata(candidate?.urlContextMetadata || candidate?.groundingMetadata || candidate?.grounding)
      : null
    if (urlMeta) {
      finalUrlContextMetadata = urlMeta
      latestUrlMeta = urlMeta
    }
    if (!urlMeta && finalUrlContextMetadata) {
      // preserve earlier metadata for later text chunks
      latestUrlMeta = latestUrlMeta || finalUrlContextMetadata
    }
    const effectiveMeta = step === 'final' ? (urlMeta || latestUrlMeta || finalUrlContextMetadata) : null
    const shapeResult = emitContentParts({
      parts,
      socket,
      chatId,
      requestId,
      step,
      forceThoughts,
      forceAnswer,
      debugLog,
      // Only FINAL should surface urlContextMetadata to frontend
      urlContextMetadata: effectiveMeta,
    })
    if (shapeResult?.hasNonThought) {
      hasAnswer = true
    }
    if (groundingAcc) {
      updateGrounding(groundingAcc, candidate)
    }
    if (collectText && Array.isArray(parts)) {
      for (const part of parts) {
        if (part?.text) collectedText += part.text
      }
    }
    if (!forceThoughts && Array.isArray(parts)) {
      for (const part of parts) {
        if (part?.text && (forceAnswer || !part.thought)) {
          hasAnswer = true
          break
        }
      }
    }

    // Check for function calls in parts (new API format)
    for (const part of parts) {
      if (part?.functionCall) {
        functionCalls.push(part.functionCall)
      }
    }

    // Also check candidate.functionCalls (old API format)
    const calls = candidate.functionCalls || []
    if (Array.isArray(calls) && calls.length) {
      functionCalls.push(...calls)
    }

    // Capture usage metadata from chunk
    if (chunk?.usageMetadata) {
      usageMetadata = chunk.usageMetadata
    }
  }

  // Log token usage if available
  if (usageMetadata) {
    const { promptTokenCount, candidatesTokenCount, totalTokenCount, thoughtsTokenCount, toolUsePromptTokenCount } = usageMetadata
    console.log(`[agent-runner] ${step.toUpperCase()} tokens: prompt=${promptTokenCount || 0}, tool=${toolUsePromptTokenCount || 0}, output=${candidatesTokenCount || 0}, thoughts=${thoughtsTokenCount || 0}, total=${totalTokenCount || 0}`)
  }

  // Extract structured blocks if requested
  const structuredBlocks = {}
  if (Array.isArray(extractBlocks) && extractBlocks.length && collectedText) {
    for (const blockName of extractBlocks) {
      const extracted = extractStructuredBlock(collectedText, blockName)
      if (extracted) {
        structuredBlocks[blockName] = extracted
      }
    }
  }

  return {
    functionCalls,
    hasAnswer,
    collectedText,
    structuredBlocks,
    usageMetadata,
    urlContextMetadata: finalUrlContextMetadata,
  }
}

function toUserContent(message) {
  if (typeof message === 'string') {
    return {
      role: 'user',
      parts: [{ text: message }],
    }
  }
  if (Array.isArray(message)) {
    const withRole = message.filter(
      (m) => m && typeof m === 'object' && typeof m.role === 'string'
    )
    if (withRole.length > 0) {
      // Use the last content that has a role (e.g., user message with attachments)
      return withRole[withRole.length - 1]
    }
    // Treat as parts array
    return { role: 'user', parts: message }
  }
  if (message && typeof message === 'object') return message
  throw new Error('Invalid message type for chat.sendMessageStream')
}

function extractUserText(message) {
  const prefix = mandatoryFinalUrlInstruction
  if (typeof message === 'string') return `${prefix}\n${message}`
  if (Array.isArray(message)) {
    const withRole = message.filter(
      (m) => m && typeof m === 'object' && typeof m.role === 'string'
    )
    const content = withRole.length ? withRole[withRole.length - 1] : null
    const parts = content?.parts
    if (Array.isArray(parts)) {
      const base = parts
        .map((p) => (p?.text ? String(p.text) : ''))
        .filter(Boolean)
        .join('\n')
      return base ? `${prefix}\n${base}` : prefix
    }
    return prefix
  }
  if (message && typeof message === 'object' && Array.isArray(message.parts)) {
    const base = message.parts
      .map((p) => (p?.text ? String(p.text) : ''))
      .filter(Boolean)
      .join('\n')
    return base ? `${prefix}\n${base}` : prefix
  }
  return prefix
}

function extractUserUrls(message) {
  const urls = new Set()
  const pushFromText = (text) => {
    const regex = /(https?:\/\/[^\s)<>"]+)/g
    let m
    while ((m = regex.exec(text)) !== null) {
      urls.add(m[1])
    }
  }
  if (typeof message === 'string') {
    pushFromText(message)
  } else if (Array.isArray(message)) {
    for (const item of message) {
      if (item?.parts) {
        for (const p of item.parts) {
          if (p?.text) pushFromText(String(p.text))
        }
      } else if (item?.text) {
        pushFromText(String(item.text))
      }
    }
  } else if (message && typeof message === 'object' && Array.isArray(message.parts)) {
    for (const p of message.parts) {
      if (p?.text) pushFromText(String(p.text))
    }
  }
  return Array.from(urls)
}

function buildThinkingConfig(parameters, includeThoughtsDefault = true) {
  const config = {}
  config.includeThoughts = includeThoughtsDefault
  return config
}

// Extract FINAL_URLS entries from RESEARCH_NOTES blocks
function extractFinalUrlsFromNotes(stepNotes = []) {
  const results = []
  const parseList = (text, regex) => {
    const match = text.match(regex)
    if (!match) return
    const lines = match[1].split('\n')
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('-')) continue
      const m = trimmed.match(/-\s*(.+?)\s*\((https?:\/\/[^\s)]+)\)\s*(?:-\s*(.+))?/)
      if (m) {
        results.push({
          title: m[1].trim(),
          url: m[2].trim(),
          authority: m[3]?.trim() || null,
        })
      }
    }
  }

  for (const note of stepNotes) {
    if (!note || typeof note !== 'string') continue
    if (note.includes('<CONTROL_DECISION>')) {
      parseList(note, /FINAL_URLS_READY:\s*([\s\S]*?)(?:\n{2,}|NEXT_RESEARCH_TARGETS:|<\/CONTROL_DECISION>)/i)
      continue
    }
    if (note.includes('<RESEARCH_NOTES>')) {
      parseList(note, /FINAL_URLS:\s*([\s\S]*?)(?:\n{2,}|<\/RESEARCH_NOTES>)/i)
    }
  }
  return results
}

// Extract structured blocks from agent output (e.g., <PLAN_OUTPUT>, <RESEARCH_NOTES>)
function extractStructuredBlock(text, blockName) {
  if (!text || typeof text !== 'string') return null
  const openTag = `<${blockName}>`
  const closeTag = `</${blockName}>`
  const startIdx = text.indexOf(openTag)
  if (startIdx === -1) return null
  const contentStart = startIdx + openTag.length
  const endIdx = text.indexOf(closeTag, contentStart)
  if (endIdx === -1) {
    // Block opened but not closed - return everything after opening tag
    return text.slice(contentStart).trim()
  }
  return text.slice(contentStart, endIdx).trim()
}

export async function runAgentSession({
  apiKey,
  baseModel,
  defaultSystemInstruction,
  userSystemInstruction,
  contents,
  socket,
  chatId,
  requestId,
  requestConfig = {},
  maxSteps = 10,
}) {
  // Extract user-requested model for FINAL step (if different from baseModel)
  const finalModel = requestConfig.model || baseModel
  const parameters = requestConfig.parameters || {}
  const options = requestConfig.options || {}
  const includeThoughts =
    options.includeThoughts !== undefined ? !!options.includeThoughts : true
  const userUrls = extractUserUrls(contents)
  const historyForChat =
    Array.isArray(contents) && contents.length > 1 ? contents.slice(0, contents.length - 1) : []

  // Debug mode controlled by environment variable
  const debugMode = process.env.AGENT_DEBUG === 'true'

  const baseThinking = { includeThoughts }
  const ai = new GoogleGenAI({ apiKey })

  // Build system instruction based on step type
  const buildSystemInstruction = (stepType) => {
    const base = [
      defaultSystemInstruction
        ? `---\nBASE SYSTEM INSTRUCTION\n---\n\n${defaultSystemInstruction}`
        : null,
      userSystemInstruction
        ? `---\nUSER-SPECIFIED INSTRUCTION\n---\n\n${userSystemInstruction}`
        : null,
    ].filter(Boolean)

    if (stepType === 'precheck') {
      // PRECHECK: personaのみ、エージェント規約なし
      return [
        ...base,
        '',
        `---\nAGENT PERSONA AND CAPABILITIES\n---\n\n${agentPersonaInstruction}`,
      ]
        .filter(Boolean)
        .join('\n')
    }

    if (stepType === 'final') {
      return [
        ...base,
        '',
        finalSystemInstruction,
        '',
        `---\nASSISTANT PERSONA\n---\n\n${agentPersonaInstruction}`,
      ]
        .filter(Boolean)
        .join('\n')
    }

    // CLARIFY/PLAN/RESEARCH/CONTROL steps: include critical agent rules
    return [
      criticalAgentRules,
      '',
      ...base,
      '',
      `---\nAGENT PERSONA AND CAPABILITIES\n---\n\n${agentPersonaInstruction}`,
      '',
      `---\nSEARCH POLICY\n---\n\n${searchPolicyInstruction}`,
      '',
      `---\nAGENT WORKFLOW\n---\n\n${flowInstruction}`,
    ]
      .filter(Boolean)
      .join('\n')
  }

  // Get current date for context
  const currentDate = new Date().toLocaleDateString('en-CA') // YYYY-MM-DD in local time

  // --- PRE-CHECK: Determine if agent workflow is needed ---
  const precheckChat = ai.chats.create({
    model: finalModel,
    config: {
      systemInstruction: buildSystemInstruction('precheck'),
      thinkingConfig: baseThinking,
    },
    history: historyForChat,
  })

  const precheckPrompt = [
    '=== PRE-CHECK: DETERMINE IF AGENT RESEARCH IS NEEDED ===',
    '',
    `Current date: ${currentDate}`,
    '',
    '⚡ CRITICAL: Make this decision IMMEDIATELY without extensive analysis.',
    'This is a simple binary choice - do not overthink it.',
    '',
    'Your task: Decide whether this user request requires multi-step research or can be answered directly.',
    '',
    '🔍 REQUIRES AGENT RESEARCH (call start_agent):',
    '- Factual questions about current events, versions, specifications',
    '- Technical how-to questions requiring up-to-date information',
    '- Questions about specific products, services, or technologies',
    '- Questions with user-provided URLs to analyze',
    '- Comparisons requiring current data',
    '- "What is the latest...", "How to use...", "Does X support Y..."',
    '',
    '✅ CAN ANSWER DIRECTLY (respond normally):',
    '- Greetings and casual conversation ("Hello", "How are you")',
    '- Opinion requests ("What do you think about...")',
    '- Creative tasks (writing, brainstorming, code generation from description)',
    '- Explanations of timeless concepts (algorithms, math, general programming)',
    '- Hypothetical scenarios',
    '- Tasks based purely on provided context (e.g., "summarize this text: ...")',
    '',
    '⚠️ DECISION LOGIC:',
    'If the answer quality would SIGNIFICANTLY improve with current web data → call start_agent',
    'If you can provide a complete, helpful answer with your training data → respond directly',
    '',
    '📋 EXECUTION:',
    '1. Read the user request',
    '2. Make instant decision: agent needed or not?',
    '3. If agent needed: call start_agent(reason: "brief reason") - DO NOT write answer',
    '4. If not needed: write answer directly - DO NOT call start_agent',
    '',
    'DO NOT spend time analyzing edge cases or uncertainties.',
    'DO NOT write lengthy reasoning about the decision.',
    'MAKE THE DECISION AND ACT IMMEDIATELY.',
    '',
    '=== USER REQUEST ===',
    extractUserText(contents),
    '',
  ]
    .filter(Boolean)
    .join('\n')

  const precheckResult = await streamOnce({
    chat: precheckChat,
    message: toUserContent(precheckPrompt),
    socket,
    chatId,
    requestId,
    step: 'precheck',
    forceThoughts: false,
    debugLog: debugMode,
    groundingAcc: null,
    collectText: false,
    extractBlocks: [],
    config: {
      tools: [
        {
          functionDeclarations: [
            {
              name: 'start_agent',
              description: 'Start the multi-step agent research workflow',
              parameters: {
                type: 'object',
                properties: {
                  reason: { type: 'string', description: 'Why agent research is needed' },
                },
                required: ['reason'],
              },
            },
          ],
        },
      ],
      thinkingConfig: baseThinking,
    },
  })

  // Check if start_agent was called
  console.log('[agent-runner] PRE_CHECK: functionCalls =', JSON.stringify(precheckResult.functionCalls, null, 2))
  const agentStartCall = precheckResult.functionCalls?.find(call => call?.name === 'start_agent')

  if (!agentStartCall) {
    // Direct answer was provided, agent workflow not needed
    // The answer has already been streamed to the user
    console.log('[agent-runner] PRE_CHECK: Direct answer provided, skipping agent workflow')
    socket.emit('end_generation', { ok: true, chatId, requestId })
    return
  }

  // Agent workflow is needed, continue with CLARIFY step
  const agentReason = agentStartCall.args?.reason || 'No reason provided'
  console.log(`[agent-runner] PRE_CHECK: Agent workflow needed - ${agentReason}`)

  const groundingAcc = { sources: new Map(), queries: new Set() }
  let stepNotes = []
  let consecutiveResearch = 0
  const MAX_CONSECUTIVE_RESEARCH = 3

  // Token usage tracking
  const tokenUsage = {
    precheck: precheckResult.usageMetadata,
    clarify: null,
    plan: null,
    research: [],
    control: [],
    final: null,
  }

  // --- Clarify stage (always once) - verify terminology first ---
  const clarifyChat = ai.chats.create({
    model: baseModel,
    config: {
      systemInstruction: buildSystemInstruction('agent'),
      thinkingConfig: baseThinking,
    },
    history: precheckChat.getHistory(),
  })

  // --- Clarify stage (always once) - verify terminology first ---
  const clarifyPrompt = [
    'STEP=CLARIFY',
    '',
    `=== CURRENT DATE ===`,
    `Today's date: ${currentDate}`,
    'Use this date to determine what "latest" or "current" means.',
    'Search results should be evaluated based on this date.',
    '',
    '=== USER REQUEST ===',
    extractUserText(contents),
    '',
    clarifyTurnPrompt,
    '',
    agentAddendumClarify,
    '',
    '=== BEGIN OUTPUT ===',
    '',
  ]
    .filter(Boolean)
    .join('\n')

  const clarifyResult = await streamOnce({
    chat: clarifyChat,
    message: toUserContent(clarifyPrompt),
    socket,
    chatId,
    requestId,
    step: 'clarify',
    forceThoughts: true,
    debugLog: debugMode,
    groundingAcc,
    collectText: true,
    extractBlocks: ['CLARIFY_OUTPUT'],
    config: {
      tools: [{ googleSearch: {} }, { urlContext: {} }],
      thinkingConfig: baseThinking,
    },
  })
  accumulateFromCalls(groundingAcc, clarifyResult.functionCalls)
  tokenUsage.clarify = clarifyResult.usageMetadata

  // Store CLARIFY_OUTPUT block
  if (clarifyResult.structuredBlocks?.CLARIFY_OUTPUT) {
    stepNotes.push(`<CLARIFY_OUTPUT>\n${clarifyResult.structuredBlocks.CLARIFY_OUTPUT}\n</CLARIFY_OUTPUT>`)
  } else if (clarifyResult.collectedText) {
    const manualExtract = extractStructuredBlock(clarifyResult.collectedText, 'CLARIFY_OUTPUT')
    if (manualExtract) {
      stepNotes.push(`<CLARIFY_OUTPUT>\n${manualExtract}\n</CLARIFY_OUTPUT>`)
    } else {
      console.warn('[agent-runner] CLARIFY_OUTPUT block not found, using full text')
      stepNotes.push(`<CLARIFY_OUTPUT>\n[Extraction failed - raw output]:\n${clarifyResult.collectedText}\n</CLARIFY_OUTPUT>`)
    }
  }

  const includeGroundingSummary = process.env.AGENT_INCLUDE_GROUNDING === 'true'
  // Format grounding summary from CLARIFY for PLAN (only if enabled)
  const clarifyGroundingSummary = includeGroundingSummary
    ? formatGroundingSummary(groundingAcc, { maxSources: 20, maxQueries: 20 })
    : null

  // --- Plan stage (always once) ---
  // planChat: baseModel for fast planning, inherits history from clarifyChat
  const planChat = ai.chats.create({
    model: baseModel,
    config: {
      systemInstruction: buildSystemInstruction('agent'),
      thinkingConfig: baseThinking,
    },
    history: clarifyChat.getHistory(),
  })
  const planPrompt = [
    'STEP=PLAN',
    '',
    `=== CURRENT DATE ===`,
    `Today's date: ${currentDate}`,
    '',
    stepNotes.length
      ? `=== CLARIFY_OUTPUT (from previous step) ===\n\n${stepNotes.join('\n\n---\n\n')}\n`
      : '=== NO CLARIFY_OUTPUT ===\nNo terminology verification available.',
    '',
    includeGroundingSummary && clarifyGroundingSummary
      ? `=== SOURCES FOUND IN CLARIFY STEP ===\nThe CLARIFY step already searched and found these sources.\nThese are VERIFIED and TRUSTWORTHY - do not doubt them:\n\n${clarifyGroundingSummary}\n`
      : '',
    '',
    planTurnPrompt,
    '',
    agentAddendumPlan,
    '',
    '=== BEGIN OUTPUT ===',
    '',
  ]
    .filter(Boolean)
    .join('\n')

  const planResult = await streamOnce({
    chat: planChat,
    message: toUserContent(planPrompt),
    socket,
    chatId,
    requestId,
    step: 'plan',
    forceThoughts: true,
    debugLog: debugMode,
    groundingAcc,
    collectText: true,
    extractBlocks: ['PLAN_OUTPUT'],
    config: {
      tools: [{ googleSearch: {} }, { urlContext: {} }],
      thinkingConfig: baseThinking,
    },
  })
  accumulateFromCalls(groundingAcc, planResult.functionCalls)
  tokenUsage.plan = planResult.usageMetadata

  // Store PLAN_OUTPUT block if extracted, otherwise try manual extraction
  if (planResult.structuredBlocks?.PLAN_OUTPUT) {
    stepNotes.push(`<PLAN_OUTPUT>\n${planResult.structuredBlocks.PLAN_OUTPUT}\n</PLAN_OUTPUT>`)
  } else if (planResult.collectedText) {
    const manualExtract = extractStructuredBlock(planResult.collectedText, 'PLAN_OUTPUT')
    if (manualExtract) {
      stepNotes.push(`<PLAN_OUTPUT>\n${manualExtract}\n</PLAN_OUTPUT>`)
    } else {
      console.warn('[agent-runner] PLAN_OUTPUT block not found, using full text')
      stepNotes.push(`<PLAN_OUTPUT>\n[Extraction failed - raw output]:\n${planResult.collectedText}\n</PLAN_OUTPUT>`)
    }
  }

  // --- Research/Control loop ---
  // researchChat: baseModel for fast iterative research loop, inherits history from planChat
  const researchChat = ai.chats.create({
    model: baseModel,
    config: {
      systemInstruction: buildSystemInstruction('agent'),
      thinkingConfig: baseThinking,
    },
    history: planChat.getHistory(),
  })

  let cycle = 1
  let lastControlTargets = null // Store NEXT_RESEARCH_TARGETS from previous CONTROL step

  const runResearch = async (idx) => {
    const researchGroundingSummary = includeGroundingSummary
      ? formatGroundingSummary(groundingAcc, { maxSources: 10, maxQueries: 10 })
      : null

    const researchPrompt = [
      'STEP=RESEARCH',
      '',
      `=== CURRENT DATE ===`,
      `Today's date: ${currentDate}`,
      'Evaluate information freshness based on this date.',
      '',
      lastControlTargets
        ? `=== PRIORITY TARGETS FROM CONTROL STEP ===\nThe CONTROL step identified these specific gaps to address:\n\n${lastControlTargets}\n\nFocus on these targets FIRST, then address any remaining items from PLAN_OUTPUT.\n`
        : '',
      '',
      stepNotes.length
        ? `=== PLAN_OUTPUT AND PREVIOUS RESEARCH ===\n\n${stepNotes.join('\n\n---\n\n')}\n`
        : '=== NO PLAN_OUTPUT ===\nNo plan available. Determine what to research based on user request.',
      '',
      includeGroundingSummary && researchGroundingSummary
        ? `=== SOURCES/QUERIES GATHERED SO FAR ===\n${researchGroundingSummary}\n`
        : '',
      '',
      userUrls.length
        ? `=== USER-PROVIDED URLs ===\n${userUrls.map(u => `- ${u}`).join('\n')}\n`
        : null,
      '',
      researchTurnPrompt,
      '',
      agentAddendumResearch,
      '',
      '=== BEGIN OUTPUT ===',
      '',
    ]
      .filter(Boolean)
      .join('\n')

    const researchResult = await streamOnce({
      chat: researchChat,
      message: toUserContent(researchPrompt),
      socket,
      chatId,
      requestId,
      step: `research-${idx}`,
      forceThoughts: true,
      debugLog: debugMode,
      groundingAcc,
      collectText: true,
      extractBlocks: ['RESEARCH_NOTES'],
      config: {
        tools: [{ googleSearch: {} }, { urlContext: {} }],
        thinkingConfig: baseThinking,
      },
    })
    accumulateFromCalls(groundingAcc, researchResult.functionCalls)
    tokenUsage.research.push(researchResult.usageMetadata)

    // Store RESEARCH_NOTES block if extracted, otherwise try manual extraction
    if (researchResult.structuredBlocks?.RESEARCH_NOTES) {
      stepNotes.push(`<RESEARCH_NOTES>\n${researchResult.structuredBlocks.RESEARCH_NOTES}\n</RESEARCH_NOTES>`)
    } else if (researchResult.collectedText) {
      const manualExtract = extractStructuredBlock(researchResult.collectedText, 'RESEARCH_NOTES')
      if (manualExtract) {
        stepNotes.push(`<RESEARCH_NOTES>\n${manualExtract}\n</RESEARCH_NOTES>`)
      } else {
        console.warn('[agent-runner] RESEARCH_NOTES block not found, using full text')
        stepNotes.push(`<RESEARCH_NOTES>\n[Extraction failed - raw output]:\n${researchResult.collectedText}\n</RESEARCH_NOTES>`)
      }
    }
  }

  await runResearch(cycle)

  // --- Control -> optional further Research loop ---
  while (cycle <= maxSteps) {
    const groundingSummaryLoop = formatGroundingSummary(groundingAcc, {
      maxSources: 10,
      maxQueries: 10,
    })
    const controlPrompt = [
      'STEP=CONTROL',
      '',
      stepNotes.length
        ? `=== ALL NOTES SO FAR ===\n\n${stepNotes.join('\n\n---\n\n')}\n`
        : '=== NO NOTES ===\nNo previous notes available.',
      '',
      includeGroundingSummary && groundingSummaryLoop
        ? `=== SOURCES/QUERIES SUMMARY ===\n${groundingSummaryLoop}\n`
        : '',
      '',
      userUrls.length
        ? `=== USER-PROVIDED URLs ===\n${userUrls.map(u => `- ${u}`).join('\n')}\n`
        : null,
      '',
      controlTurnPrompt,
      '',
      agentAddendumControl,
      '',
      '=== BEGIN OUTPUT ===',
      '',
    ]
      .filter(Boolean)
      .join('\n')

    const controlResult = await streamOnce({
      chat: researchChat,
      message: toUserContent(controlPrompt),
      socket,
      chatId,
      requestId,
      step: `control-${cycle}`,
      forceThoughts: true,
      debugLog: debugMode,
      groundingAcc: null,
      collectText: true,
      extractBlocks: ['CONTROL_DECISION'],
      config: {
        tools: [
          {
            functionDeclarations: [
              {
                name: 'control_step',
                description: 'Decide whether to continue research or finalize.',
                parameters: {
                  type: 'object',
                  properties: {
                    action: {
                      type: 'string',
                      enum: ['research', 'final'],
                    },
                    notes: { type: 'string' },
                  },
                  required: ['action'],
                },
              },
            ],
          },
        ],
        thinkingConfig: baseThinking,
      },
    })
    tokenUsage.control.push(controlResult.usageMetadata)

    // Store CONTROL_DECISION block if extracted, otherwise try manual extraction
    let controlDecisionText = null
    if (controlResult.structuredBlocks?.CONTROL_DECISION) {
      controlDecisionText = controlResult.structuredBlocks.CONTROL_DECISION
      stepNotes.push(`<CONTROL_DECISION>\n${controlDecisionText}\n</CONTROL_DECISION>`)
    } else if (controlResult.collectedText) {
      const manualExtract = extractStructuredBlock(controlResult.collectedText, 'CONTROL_DECISION')
      if (manualExtract) {
        controlDecisionText = manualExtract
        stepNotes.push(`<CONTROL_DECISION>\n${manualExtract}\n</CONTROL_DECISION>`)
      } else {
        console.warn('[agent-runner] CONTROL_DECISION block not found, using full text')
        stepNotes.push(`<CONTROL_DECISION>\n[Extraction failed - raw output]:\n${controlResult.collectedText}\n</CONTROL_DECISION>`)
      }
    }

    // Emit CONTROL_DECISION text to frontend for visibility (tool calls often produce no parts)
    if (socket && controlDecisionText) {
      emitContentParts({
        parts: [{ text: controlDecisionText, thought: true }],
        socket,
        chatId,
        requestId,
        step: `control-${cycle}`,
        forceThoughts: true,
        debugLog: debugMode,
      })
    }

    // Extract NEXT_RESEARCH_TARGETS from CONTROL_DECISION for next research cycle
    if (controlDecisionText) {
      const targetsMatch = controlDecisionText.match(/NEXT_RESEARCH_TARGETS:([\s\S]*?)(?:\n\n|$)/i)
      if (targetsMatch && targetsMatch[1]) {
        lastControlTargets = targetsMatch[1].trim()
      } else {
        lastControlTargets = null
      }
    }

    const controlCalls = controlResult.functionCalls
    const controlDecision = extractStepAction(controlCalls)
    let decisionAction = controlDecision?.action || 'final'

    // Infinite loop protection
    if (decisionAction === 'research') {
      consecutiveResearch += 1
      if (consecutiveResearch >= MAX_CONSECUTIVE_RESEARCH) {
        console.warn('[agent-runner] Max consecutive research reached, forcing final')
        decisionAction = 'final'
      }
    } else {
      consecutiveResearch = 0
    }

    if (decisionAction === 'final' || cycle === maxSteps) {
      const groundingSummary = formatGroundingSummary(groundingAcc, {
        maxSources: 10,
        maxQueries: 10,
      })
      const finalUrls = extractFinalUrlsFromNotes(stepNotes)
      if (debugMode) {
        console.log('[agent-runner] FINAL_URLS extracted:', finalUrls.length, finalUrls)
      }
      const finalUrlsSection = finalUrls.length
        ? `=== FINAL_URLS (fetch with urlContext before answering) ===\n${finalUrls
            .map((u, idx) => `[${idx + 1}] ${u.title} (${u.url})${u.authority ? ` - ${u.authority}` : ''}`)
            .join('\n')}\n`
        : '=== FINAL_URLS ===\nNone\n'

      const controlNotes = stepNotes.filter(note => note.includes('<CONTROL_DECISION>'))
      const controlHandoff = controlNotes.length ? controlNotes[controlNotes.length - 1] : null

      const finalPrompt = [
        'STEP=FINAL',
        '',
        `=== CURRENT DATE ===`,
        `Today's date: ${currentDate}`,
        'The user is asking this question on this date.',
        'When you mention dates or versions, this provides context.',
        '',
        '=== CRITICAL: UNDERSTAND YOUR ROLE ===',
        'This is the ONLY output the user will see.',
        'All previous steps (CLARIFY, PLAN, RESEARCH, CONTROL) were INTERNAL and INVISIBLE to the user.',
        'You are now responding DIRECTLY to the user for the FIRST time.',
        '',
        '=== PERSONA: You are NO LONGER the <AGENT> ===',
        'You are now a normal helpful assistant responding to the user.',
        defaultSystemInstruction ? `Your base persona:\n${defaultSystemInstruction}` : null,
        userSystemInstruction ? `User-specified persona:\n${userSystemInstruction}` : null,
        '',
        '=== CRITICAL: DO NOT output <AGENT> tag ===',
        'No <AGENT> tag in thoughts. No <AGENT> tag in response.',
        'Respond naturally as if having a direct conversation with the user.',
        '',
        '=== INFORMATION USAGE POLICY ===',
        '',
        '1. PRIMARY SOURCES (your main material):',
        '   - CONTROL_SUMMARY (latest CONTROL_DECISION block)',
        '   - Tool outputs in chat history (urlContext results you fetch for FINAL_URLS)',
        '',
        '2. SUPPORTING CONTEXT (you MAY use general background knowledge to):',
        '   - Explain fundamental concepts that help understand the CONTROL_SUMMARY facts',
        '   - Provide context that makes technical information more accessible',
        '   - Fill in obvious logical connections between CONTROL_SUMMARY items',
        '',
        '3. WHAT YOU MUST NOT DO:',
        '   - Do NOT add specific facts (versions, dates, specs) not found in CONTROL_SUMMARY or urlContext content',
        '   - Do NOT contradict or override CONTROL_SUMMARY findings with training data',
        '   - Do NOT make specific claims about current state without CONTROL_SUMMARY or urlContext support',
        '   - If CONTROL_SUMMARY does not cover something, acknowledge the gap explicitly',
        '',
        '=== RESPONSE APPROACH ===',
        '',
        '📋 YOUR ROLE: RESEARCH REPORT AUTHOR',
        'You are writing a comprehensive research report based on investigation findings.',
        'This is NOT a casual chat response - it is a detailed research deliverable.',
        '',
        'Report characteristics:',
        '  ✓ Exhaustive coverage of all researched facts',
        '  ✓ Structured and well-organized presentation',
        '  ✓ Technical depth with concrete details',
        '  ✓ Professional thoroughness worthy of the research effort',
        '',
        'Think of your output as:',
        '  - A technical report that someone would cite',
        '  - Documentation that answers every aspect of the question',
        '  - A reference document that captures all findings',
        '',
        'NOT as:',
        '  - A brief summary',
        '  - A quick answer',
        '  - Highlights only',
        '',
        '=== CONTROL HANDOFF (READ CAREFULLY) ===',
        '',
        'Use only CONTROL_SUMMARY and FINAL_URLS_READY from the CONTROL_DECISION below; other sections are informational.',
        controlHandoff || 'No CONTROL_DECISION available.',
        '',
        finalUrlsSection,
        '',
        includeGroundingSummary && groundingSummary
          ? `=== SOURCES/QUERIES SUMMARY ===\n${groundingSummary}\n`
          : '',
        '',
        userUrls.length
          ? `=== USER-PROVIDED URLs ===\n${userUrls.map(u => `- ${u}`).join('\n')}\n`
          : '',
        '',
        finalTurnPrompt,
        '',
        '=== ORIGINAL USER REQUEST ===',
        extractUserText(contents)
          ? `${extractUserText(contents)}\n\nMANDATORY: Always fetch and reference every provided URL before answering.`
          : '(No user request text available)\n\nMANDATORY: Always fetch and reference every provided URL before answering.',
        '',
        '=== URL OUTPUT POLICY FOR FINAL ANSWER ===',
        '- Carefully check the ORIGINAL USER REQUEST above.',
        '- Do NOT include sources or references unless the user explicitly asked for them.',
        '',
        '=== ANSWER FORMATTING REQUIREMENTS ===',
        '',
        '1. LANGUAGE:',
        '   - Use natural, conversational tone appropriate to your persona',
        '',
        '2. CONTENT REQUIREMENTS:',
        '',
        '   ⚠️ USE EVERY FACT FROM CONTROL_SUMMARY',
        '   - Your report MUST incorporate ALL facts listed in CONTROL_SUMMARY (FACTS_READY)',
        '   - Missing facts = incomplete report = FAILURE',
        '',
        '   For each fact, provide:',
        '     * Full technical detail available in CONTROL_SUMMARY and urlContext fetches',
        '     * Why it matters (context and relevance)',
        '     * Practical implications or concrete examples',
        '     * Code snippets, parameters, version numbers as applicable',
        '',
        '   Report depth expectations:',
        '     * 10+ facts → expect 1000+ word comprehensive report',
        '     * 20+ facts → expect 2000+ word detailed analysis',
        '     * Thoroughness > brevity - this is a research deliverable',
        '',
        '   VERSION HANDLING:',
        '     * Focus on LATEST version (as identified in PLAN/RESEARCH)',
        '     * Clearly state version numbers when discussing features',
        '     * Note if older versions behave differently (with version numbers)',
        '     * Do NOT mix information from different versions without clarifying which is which',
        '',
        '3. SOURCES AND ATTRIBUTION (only if user requests):',
        '   - If the user explicitly asks for sources/URLs, add a "## Sources" section.',
        '   - List source titles ONLY by default; include URLs only when the user asked for links.',
        '   - Maintain source numbering/IDs from CONTROL_SUMMARY if you cite them.',
        '',
        '4. INFORMATION GAPS AND LIMITATIONS:',
        '   - If CONTROL_SUMMARY does not contain complete information, acknowledge gaps explicitly',
        '   - Clearly distinguish between: verified facts, partial information, and unknowns',
        '   - Suggest what additional information might be needed',
        '',
        '6. FRESHNESS AND CURRENCY:',
        '   - Note dates/versions explicitly when mentioning time-sensitive information',
        '   - Highlight which information is current vs. historical',
        '',
        '=== REPORT QUALITY CHECKLIST ===',
        '',
        '✓ Every fact from CONTROL_SUMMARY is incorporated',
        '✓ Technical depth matches the research effort invested',
        '✓ Report is structured, organized, and comprehensive',
        '✓ Code examples, versions, parameters are included where researched',
        '✓ Explanations go beyond "what" to include "why" and "how"',
        '✓ Length reflects thoroughness (1000+ words for substantial research)',
        '✓ URLs excluded unless user explicitly requested sources',
        '',
        'This is a research report deliverable - not a chat summary.',
        'Make every researched fact count.',
        '',
        '=== BEGIN OUTPUT ===',
        '',
      ]
        .filter(Boolean)
        .join('\n')

      // Build a lightweight FINAL history: original front-end history + CONTROL handoff (no research/plan logs)
      const finalHistory = []
      if (Array.isArray(historyForChat)) {
        finalHistory.push(...historyForChat)
      }
      if (controlHandoff) {
        finalHistory.push({
          role: 'model',
          parts: [{ text: controlHandoff }],
        })
      }

      // Create a new chat for FINAL step with persona-focused system instruction (no agent rules)
      // Use finalModel (user-requested model) for high-quality final answer
      const finalChat = ai.chats.create({
        model: finalModel,
        config: {
          systemInstruction: buildSystemInstruction('final'),
          thinkingConfig: baseThinking,
        },
        history: finalHistory,
      })

      const finalResult = await streamOnce({
        chat: finalChat,
        message: toUserContent(finalPrompt),
        socket,
        chatId,
        requestId,
        step: 'final',
        debugLog: debugMode,
        collectUrlContextMetadata: true,
        config: { tools: [{ urlContext: {} }], thinkingConfig: baseThinking },
      })
      tokenUsage.final = finalResult.usageMetadata
      const finalUrlCalls =
        Array.isArray(finalResult.functionCalls) && finalResult.functionCalls.length
          ? finalResult.functionCalls.filter((c) => c?.name === 'urlContext')
          : []
      if (debugMode) {
        console.log('[agent-runner] FINAL function calls (urlContext only):', finalUrlCalls)
      }
      if (debugMode && finalResult.urlContextMetadata) {
        console.debug('[agent-runner] FINAL urlContextMetadata collected:', JSON.stringify(finalResult.urlContextMetadata, null, 2))
      }
      if (finalUrls.length && !finalUrlCalls.length) {
        console.warn('[agent-runner] FINAL expected urlContext calls for FINAL_URLS but none observed')
      }
      if (finalUrls.length && !finalResult.urlContextMetadata) {
        console.warn('[agent-runner] FINAL urlContextMetadata missing despite FINAL_URLS being present')
      }

      // Print total token usage summary with breakdown
      if (debugMode) {
        console.log('\n=== AGENT WORKFLOW TOKEN USAGE SUMMARY ===')

        const sumTokens = (metadata) => metadata ? (metadata.totalTokenCount || 0) : 0
        const sumPrompt = (metadata) => metadata ? (metadata.promptTokenCount || 0) : 0
        const sumToolPrompt = (metadata) => metadata ? (metadata.toolUsePromptTokenCount || 0) : 0
        const sumOutput = (metadata) => metadata ? (metadata.candidatesTokenCount || 0) : 0
        const sumThoughts = (metadata) => metadata ? (metadata.thoughtsTokenCount || 0) : 0

        const precheckTotal = sumTokens(tokenUsage.precheck)
        const clarifyTotal = sumTokens(tokenUsage.clarify)
        const planTotal = sumTokens(tokenUsage.plan)
        const researchTotal = tokenUsage.research.reduce((sum, m) => sum + sumTokens(m), 0)
        const controlTotal = tokenUsage.control.reduce((sum, m) => sum + sumTokens(m), 0)
        const finalTotal = sumTokens(tokenUsage.final)
        const grandTotal = precheckTotal + clarifyTotal + planTotal + researchTotal + controlTotal + finalTotal

        // Calculate breakdown totals
        const allMetadata = [
          tokenUsage.precheck,
          tokenUsage.clarify,
          tokenUsage.plan,
          ...tokenUsage.research,
          ...tokenUsage.control,
          tokenUsage.final,
        ].filter(Boolean)

        const totalPrompt = allMetadata.reduce((sum, m) => sum + sumPrompt(m), 0)
        const totalToolPrompt = allMetadata.reduce((sum, m) => sum + sumToolPrompt(m), 0)
        const totalOutput = allMetadata.reduce((sum, m) => sum + sumOutput(m), 0)
        const totalThoughts = allMetadata.reduce((sum, m) => sum + sumThoughts(m), 0)

        console.log(`PRE_CHECK:  ${precheckTotal.toLocaleString()} tokens`)
        console.log(`CLARIFY:    ${clarifyTotal.toLocaleString()} tokens`)
        console.log(`PLAN:       ${planTotal.toLocaleString()} tokens`)
        console.log(`RESEARCH:   ${researchTotal.toLocaleString()} tokens (${tokenUsage.research.length} cycles)`)
        console.log(`CONTROL:    ${controlTotal.toLocaleString()} tokens (${tokenUsage.control.length} cycles)`)
        console.log(`FINAL:      ${finalTotal.toLocaleString()} tokens`)
        console.log(`───────────────────────────────────────`)
        console.log(`TOTAL:      ${grandTotal.toLocaleString()} tokens`)
        console.log(``)
        console.log(`BREAKDOWN:`)
        console.log(`  User Input + System:    ${totalPrompt.toLocaleString()} tokens (${((totalPrompt/grandTotal)*100).toFixed(1)}%)`)
        console.log(`  Tool Declarations:      ${totalToolPrompt.toLocaleString()} tokens (${((totalToolPrompt/grandTotal)*100).toFixed(1)}%)`)
        console.log(`  Model Output:           ${totalOutput.toLocaleString()} tokens (${((totalOutput/grandTotal)*100).toFixed(1)}%)`)
        console.log(`  Thoughts (Reasoning):   ${totalThoughts.toLocaleString()} tokens (${((totalThoughts/grandTotal)*100).toFixed(1)}%)`)
        console.log('==========================================\n')
      }

      socket.emit('end_generation', {
        ok: true,
        chatId,
        requestId,
        urlContextMetadata: finalResult.urlContextMetadata || null,
      })
      return
    }

    cycle += 1
    await runResearch(cycle)
  }
}
