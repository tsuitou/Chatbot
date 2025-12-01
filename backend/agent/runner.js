import { GoogleGenAI } from '@google/genai'
import {
  agentAddendumClarify,
  agentAddendumPlan,
  agentPersonaInstruction,
  clarifyTurnPrompt,
  criticalAgentRules,
  finalTurnPrompt,
  finalSystemInstruction,
  flowInstruction,
  commonAgentPolicies,
  planTurnPrompt,
  searchPolicyInstruction,
  refineTurnPrompt,
} from './prompts.js'

// Track the last emitted step to add breathing room between phases
let lastEmittedStep = null

// Mandatory instruction injected into user prompts to keep grounding consistent and hide URLs
const mandatoryFinalUrlInstruction =
  'MANDATORY: Ground final answers in urlContext (google_browse) results for any fetched URLs. Do not include raw URLs in the response. If URLs cannot be fetched, state the failure and avoid answering from memory.'

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

// Convert urlContextMetadata (urlContexts array) into grounding-like shape for frontend consumption
function groundingFromUrlContext(urlContextMetadata) {
  if (!urlContextMetadata || !Array.isArray(urlContextMetadata.urlContexts)) return null
  const groundingChunks = urlContextMetadata.urlContexts
    .map((c) => {
      const uri = c?.uri || c?.url || c?.webPage?.uri || c?.webPage?.url
      const title = c?.title || c?.webPage?.title || null
      return uri ? { web: { uri, title: title || '(no title)' } } : null
    })
    .filter(Boolean)
  if (!groundingChunks.length) return null
  return { groundingChunks }
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
  const allowEmptyPart = step === 'final' && urlContextMetadata
  const baseParts = parts || []
  const shapedParts = []

  // Detect step transition and add newline
  const isStepTransition = lastEmittedStep !== null && lastEmittedStep !== step

  for (let i = 0; i < baseParts.length; i++) {
    const part = baseParts[i]
    if (!part) continue
    const hasTextField = part.text !== undefined && part.text !== null
    if (!hasTextField && !allowEmptyPart) continue

    const thoughtFlag = forceAnswer
      ? false
      : forceThoughts
        ? true
        : !!part.thought

    let text = hasTextField ? String(part.text) : ''

    // Skip truly empty text when metadata-only emission is not allowed
    if (!text && !allowEmptyPart) continue

    // Add newline at step transition (only for first part)
    if (i === 0 && isStepTransition && text) {
      text = '\n\n' + text
    }
    // Add newline between thought and answer content
    else if (text && shapedParts.length > 0 && shapedParts[shapedParts.length - 1].thought && !thoughtFlag) {
      text = '\n' + text
    }

    shapedParts.push({ text, thought: thoughtFlag })
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

  if (!shapedParts.length && allowEmptyPart) {
    shapedParts.push({ text: '', thought: !!forceThoughts && !forceAnswer })
  }

  if (!shapedParts.length) return shapedParts

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
  return shapedParts
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

// Merge urlContext arrays, de-duplicating by uri when available
function mergeUrlContexts(existing = [], incoming = []) {
  const map = new Map()
  const add = (item) => {
    if (!item) return
    const uri =
      item.uri ||
      item.url ||
      item.webPage?.uri ||
      item.webPage?.url ||
      item.web?.uri
    const key = uri || JSON.stringify(item)
    if (!map.has(key)) {
      map.set(key, item)
    }
  }
  for (const c of existing) add(c)
  for (const c of incoming) add(c)
  return Array.from(map.values())
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
  collectUrlContextMetadata = false,
  collectAnswerText = false,
  collectAnswerParts = false,
}) {
  const stream = await chat.sendMessageStream({ message, config })
  const functionCalls = []
  let usageMetadata = null
  let aggregatedUrlContexts = []
  const collectedAnswerParts = collectAnswerText ? [] : null
  const collectedAnswerPartsRaw = collectAnswerParts ? [] : null
  let collectedAnswerRole = null

  for await (const chunk of stream) {
    const candidate = chunk?.candidates?.[0] || {}
    const parts = candidate.content?.parts || []
    const contentRole = candidate?.content?.role
    let effectiveMeta = null
    if (collectUrlContextMetadata) {
      const urlMeta = buildUrlContextMetadata(candidate?.urlContextMetadata || candidate?.groundingMetadata || candidate?.grounding)
      if (urlMeta?.urlContexts?.length) {
        aggregatedUrlContexts = mergeUrlContexts(aggregatedUrlContexts, urlMeta.urlContexts)
      }
      if (step === 'final' && aggregatedUrlContexts.length) {
        effectiveMeta = { urlContexts: aggregatedUrlContexts }
      }
    }
    const shapedParts = emitContentParts({
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
    if (collectAnswerText && Array.isArray(shapedParts)) {
      for (const shapedPart of shapedParts) {
        if (!shapedPart) continue
        if (shapedPart.thought) continue
        if (typeof shapedPart.text === 'string' && shapedPart.text.length) {
          collectedAnswerParts.push(shapedPart.text)
        }
      }
    }
    if (collectAnswerParts && Array.isArray(shapedParts)) {
      for (const shapedPart of shapedParts) {
        if (!shapedPart) continue
        if (shapedPart.thought) continue
        if (typeof shapedPart.text === 'string' && shapedPart.text.length) {
          collectedAnswerPartsRaw.push({ text: shapedPart.text })
          if (!collectedAnswerRole && contentRole) {
            collectedAnswerRole = contentRole
          }
        }
      }
    }
    if (groundingAcc) {
      updateGrounding(groundingAcc, candidate)
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

  return {
    functionCalls,
    usageMetadata,
    urlContextMetadata: aggregatedUrlContexts.length ? { urlContexts: aggregatedUrlContexts } : null,
    answerText: collectAnswerText && collectedAnswerParts ? collectedAnswerParts.join('') : undefined,
    answerParts: collectAnswerParts && collectedAnswerPartsRaw ? collectedAnswerPartsRaw : undefined,
    answerRole: collectAnswerParts ? collectedAnswerRole : undefined,
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

function extractOriginalUserText(message) {
  if (typeof message === 'string') return message
  if (Array.isArray(message)) {
    const withRole = message.filter(
      (m) => m && typeof m === 'object' && typeof m.role === 'string'
    )
    const content = withRole.length ? withRole[withRole.length - 1] : null
    const parts = content?.parts
    if (Array.isArray(parts)) {
      return parts
        .map((p) => (p?.text ? String(p.text) : ''))
        .filter(Boolean)
        .join('\n')
    }
    return ''
  }
  if (message && typeof message === 'object' && Array.isArray(message.parts)) {
    return message.parts
      .map((p) => (p?.text ? String(p.text) : ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

function extractAssistantText(message) {
  if (!message || typeof message !== 'object' || !Array.isArray(message.parts)) return ''
  return message.parts
    .map((p) => (p?.text ? String(p.text) : ''))
    .filter(Boolean)
    .join('\n')
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
}) {
  // Reset per-session state
  lastEmittedStep = null

  // Resolve base model from args or environment
  const resolvedBaseModel = baseModel || process.env.AGENT_BASE_MODEL
  if (!resolvedBaseModel) {
    throw new Error('Agent base model is not configured (set AGENT_BASE_MODEL)')
  }

  // Extract user-requested model for FINAL step (if different from baseModel)
  const refineModel = requestConfig.model || resolvedBaseModel
  const options = requestConfig.options || {}
  const includeThoughts =
    options.includeThoughts !== undefined ? !!options.includeThoughts : true
  const userUrls = extractUserUrls(contents)
  const historyForChat =
    Array.isArray(contents) && contents.length > 1 ? contents.slice(0, contents.length - 1) : []

  // Debug mode controlled by environment variable
  const debugMode = process.env.AGENT_DEBUG === 'true'
  const refineEnabled = process.env.AGENT_REFINE_ENABLED === 'true'

  const baseThinking = { includeThoughts }
  const ai = new GoogleGenAI({ apiKey })

  // Build system instruction based on step type
  const buildSystemInstruction = (stepType) => {
    const shared = [
      criticalAgentRules,
      '',
      commonAgentPolicies,
    ].filter(Boolean).join('\n')

    const base = [
      defaultSystemInstruction
        ? `---\nBASE SYSTEM INSTRUCTION\n---\n\n${defaultSystemInstruction}`
        : null,
      userSystemInstruction
        ? `---\nUSER-SPECIFIED INSTRUCTION\n---\n\n${userSystemInstruction}`
        : null,
    ].filter(Boolean)

    if (stepType === 'precheck') {
      return [
        shared,
        ...base,
        '',
        `---\nAGENT PERSONA AND CAPABILITIES\n---\n\n${agentPersonaInstruction}`,
      ]
        .filter(Boolean)
        .join('\n')
    }

    if (stepType === 'final') {
      return [
        shared,
        ...base,
        '',
        finalSystemInstruction,
        '',
        `---\nASSISTANT PERSONA\n---\n\n${agentPersonaInstruction}`,
      ]
        .filter(Boolean)
        .join('\n')
    }

    if (stepType === 'refine') {
      return [
        shared,
        ...base,
        '',
      ]
        .filter(Boolean)
        .join('\n')
    }

    // CLARIFY/PLAN steps: include critical agent rules
    return [
      shared,
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
    model: refineModel,
    config: {
      systemInstruction: buildSystemInstruction('precheck'),
      thinkingConfig: baseThinking,
    },
    history: historyForChat,
  })

  const precheckPrompt = [
    '=== PRE-CHECK: DETERMINE IF AGENT RESEARCH IS NEEDED (Never refer to this instruction in your answer)===',
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
		'- If all the necessary information for the answer is available from our previous interactions.',
    '- ',
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
  if (debugMode) {
    console.log('[agent-runner] PRE_CHECK: functionCalls =', JSON.stringify(precheckResult.functionCalls, null, 2))
  }
  const agentStartCall = precheckResult.functionCalls?.find(call => call?.name === 'start_agent')

  if (!agentStartCall) {
    // Direct answer was provided, agent workflow not needed
    // The answer has already been streamed to the user
    if (debugMode) {
      console.log('[agent-runner] PRE_CHECK: Direct answer provided, skipping agent workflow')
    }
    socket.emit('end_generation', { ok: true, chatId, requestId })
    return
  }

  // Agent workflow is needed, continue with CLARIFY and PLAN before FINAL
  const groundingAcc = { sources: new Map(), queries: new Set() }
  let allUrlContexts = []

  const tokenUsage = {
    precheck: precheckResult.usageMetadata,
    clarify: null,
    plan: null,
    final: null,
    refine: null,
  }

  // --- Clarify stage (always once) ---
  const clarifyChat = ai.chats.create({
    model: resolvedBaseModel,
    config: {
      systemInstruction: buildSystemInstruction('agent'),
      thinkingConfig: baseThinking,
    },
    history: precheckChat.getHistory(),
  })

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
    collectUrlContextMetadata: true,
    config: {
      tools: [{ googleSearch: {} }, { urlContext: {} }],
      thinkingConfig: baseThinking,
      topP: 0.2,
    },
  })
  if (clarifyResult.urlContextMetadata?.urlContexts?.length) {
    allUrlContexts = mergeUrlContexts(allUrlContexts, clarifyResult.urlContextMetadata.urlContexts)
  }
  accumulateFromCalls(groundingAcc, clarifyResult.functionCalls)
  tokenUsage.clarify = clarifyResult.usageMetadata

  // --- Plan stage (always once) ---
  const planChat = ai.chats.create({
    model: resolvedBaseModel,
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
    'Use the chat history above (including CLARIFY) to inform your plan.',
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
    collectUrlContextMetadata: true,
    config: {
      tools: [{ googleSearch: {} }, { urlContext: {} }],
      thinkingConfig: baseThinking,
      topP: 0.2,
    },
  })
  if (planResult.urlContextMetadata?.urlContexts?.length) {
    allUrlContexts = mergeUrlContexts(allUrlContexts, planResult.urlContextMetadata.urlContexts)
  }
  accumulateFromCalls(groundingAcc, planResult.functionCalls)
  tokenUsage.plan = planResult.usageMetadata

  // --- FINAL: user-facing answer with optional searches ---
  const finalChat = ai.chats.create({
    model: resolvedBaseModel,
    config: {
      systemInstruction: buildSystemInstruction('final'),
      thinkingConfig: baseThinking,
			topP: 0.2,
    },
    history: planChat.getHistory(),
  })

  const finalPrompt = [
    'STEP=FINAL',
    '',
    `=== CURRENT DATE ===`,
    `Today's date: ${currentDate}`,
    'The user is asking this question on this date.',
    '',
    userUrls.length
      ? `User-provided URLs to inspect with urlContext: \n${userUrls.map((u) => `- ${u}`).join('\n')}`
      : null,
    '',
    finalTurnPrompt,
    '',
    '=== ORIGINAL USER REQUEST ===',
    extractUserText(contents)
      ? `${extractUserText(contents)}`
      : '(No user request text available)',
    '',
  ]
    .filter(Boolean)
    .join('\n')

  const finalResult = await streamOnce({
    chat: finalChat,
    message: toUserContent(finalPrompt),
    socket,
    chatId,
    requestId,
    step: 'final',
    debugLog: debugMode,
    collectUrlContextMetadata: true,
    forceThoughts: refineEnabled,
    groundingAcc,
    config: { tools: [{ googleSearch: {} }, { urlContext: {} }], thinkingConfig: baseThinking },
  })
  if (finalResult.urlContextMetadata?.urlContexts?.length) {
    allUrlContexts = mergeUrlContexts(allUrlContexts, finalResult.urlContextMetadata.urlContexts)
  }
  // Fallback: if no urlContextMetadata collected but grounding sources exist, convert them
  if (!allUrlContexts.length) {
    const groundingFromCalls = buildGroundingMetadata(groundingAcc)
    if (groundingFromCalls?.sources?.length) {
      const fallbackContexts = groundingFromCalls.sources
        .map((s) => (s?.uri ? { uri: s.uri, title: s.title || null } : null))
        .filter(Boolean)
      if (fallbackContexts.length) {
        allUrlContexts = mergeUrlContexts(allUrlContexts, fallbackContexts)
      }
    }
  }
  tokenUsage.final = finalResult.usageMetadata

  // --- REFINE: optional post-pass using urlContext only ---
  let refineResult = null
  const finalHistory = typeof finalChat.getHistory === 'function' ? finalChat.getHistory() : []
  const lastAssistantMessage = Array.isArray(finalHistory)
    ? [...finalHistory].reverse().find(
        (m) =>
          m &&
          m.role === 'model' &&
          Array.isArray(m.parts) &&
          m.parts.length
      )
    : null
  const lastAssistantText = extractAssistantText(lastAssistantMessage)

  if (refineEnabled && lastAssistantMessage) {
    const aggregatedUrlContexts = allUrlContexts.length
      ? allUrlContexts
      : finalResult.urlContextMetadata?.urlContexts || []
    const groundingFromCalls = buildGroundingMetadata(groundingAcc)
    const formattedUrls = aggregatedUrlContexts.length
      ? aggregatedUrlContexts
          .map((ctx) => {
            const uri =
              ctx?.uri ||
              ctx?.url ||
              ctx?.webPage?.uri ||
              ctx?.webPage?.url ||
              ctx?.web?.uri
            const title = ctx?.title || ctx?.webPage?.title || ctx?.web?.title
            return uri ? `- ${uri}${title ? ` (title: ${title})` : ''}` : null
          })
          .filter(Boolean)
          .join('\n')
      : groundingFromCalls?.sources?.length
        ? groundingFromCalls.sources
            .map((s) => (s?.uri ? `- ${s.uri}${s.title ? ` (title: ${s.title})` : ''}` : null))
            .filter(Boolean)
            .join('\n')
        : 'No URL metadata collected.'

    if (debugMode) {
      console.log('[agent-runner] REFINE url contexts:', JSON.stringify(aggregatedUrlContexts))
      console.log('[agent-runner] REFINE grounding sources:', JSON.stringify(groundingFromCalls?.sources || []))
    }

    const refineChat = ai.chats.create({
      model: refineModel,
      config: {
        systemInstruction: buildSystemInstruction('refine'),
        thinkingConfig: baseThinking,
      },
    })

    const originalUserText = extractOriginalUserText(contents)
    const refinePrompt = [
      `=== CURRENT DATE ===`,
      `Today's date: ${currentDate}`,
      '',
      'URL context metadata collected in FINAL:',
      formattedUrls,
      '',
      '=== PRIOR FINAL ANSWER ===',
      lastAssistantText ? lastAssistantText : '(No final answer text available)',
      '',
      '=== ORIGINAL USER REQUEST ===',
      originalUserText ? originalUserText : '(No user request text available)',
      '',
      refineTurnPrompt,
    ]
      .filter(Boolean)
      .join('\n')

    refineResult = await streamOnce({
      chat: refineChat,
      message: toUserContent(refinePrompt),
      socket,
      chatId,
      requestId,
      step: 'refine',
      debugLog: debugMode,
      collectUrlContextMetadata: true,
      collectAnswerText: true,
      groundingAcc,
      config: { tools: [{ urlContext: {} }], thinkingConfig: baseThinking, topP: 0.2 },
    })
    accumulateFromCalls(groundingAcc, refineResult.functionCalls)
    tokenUsage.refine = refineResult.usageMetadata
    if (refineResult.urlContextMetadata?.urlContexts?.length) {
      allUrlContexts = mergeUrlContexts(allUrlContexts, refineResult.urlContextMetadata.urlContexts)
    }
  }

  // Print total token usage summary with breakdown when debugging
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
    const finalTotal = sumTokens(tokenUsage.final)
    const refineTotal = sumTokens(tokenUsage.refine)
    const grandTotal = precheckTotal + clarifyTotal + planTotal + finalTotal + refineTotal

    const allMetadata = [
      tokenUsage.precheck,
      tokenUsage.clarify,
      tokenUsage.plan,
      tokenUsage.final,
      tokenUsage.refine,
    ].filter(Boolean)

    const totalPrompt = allMetadata.reduce((sum, m) => sum + sumPrompt(m), 0)
    const totalToolPrompt = allMetadata.reduce((sum, m) => sum + sumToolPrompt(m), 0)
    const totalOutput = allMetadata.reduce((sum, m) => sum + sumOutput(m), 0)
    const totalThoughts = allMetadata.reduce((sum, m) => sum + sumThoughts(m), 0)

    console.log(`PRE_CHECK:  ${precheckTotal.toLocaleString()} tokens`)
    console.log(`CLARIFY:    ${clarifyTotal.toLocaleString()} tokens`)
    console.log(`PLAN:       ${planTotal.toLocaleString()} tokens`)
    console.log(`FINAL:      ${finalTotal.toLocaleString()} tokens`)
    console.log(`REFINE:     ${refineTotal.toLocaleString()} tokens`)
    console.log(`───────────────────────────────────────`)
    console.log(`TOTAL:      ${grandTotal.toLocaleString()} tokens`)
    console.log(``)
    console.log(`BREAKDOWN:`)
    console.log(`  User Input + System:    ${totalPrompt.toLocaleString()} tokens (${grandTotal ? ((totalPrompt/grandTotal)*100).toFixed(1) : '0.0'}%)`)
    console.log(`  Tool Declarations:      ${totalToolPrompt.toLocaleString()} tokens (${grandTotal ? ((totalToolPrompt/grandTotal)*100).toFixed(1) : '0.0'}%)`)
    console.log(`  Model Output:           ${totalOutput.toLocaleString()} tokens (${grandTotal ? ((totalOutput/grandTotal)*100).toFixed(1) : '0.0'}%)`)
    console.log(`  Thoughts (Reasoning):   ${totalThoughts.toLocaleString()} tokens (${grandTotal ? ((totalThoughts/grandTotal)*100).toFixed(1) : '0.0'}%)`)
    console.log('==========================================\n')
  }

  const mergedUrlContextMetadata = (() => {
    const finalMeta = finalResult.urlContextMetadata
    const refineMeta = refineResult?.urlContextMetadata
    const mergedMeta = []
    if (Array.isArray(allUrlContexts) && allUrlContexts.length) {
      mergedMeta.push(...allUrlContexts)
    }
    if (finalMeta?.urlContexts?.length) {
      mergedMeta.push(...finalMeta.urlContexts)
    }
    if (refineMeta?.urlContexts?.length) {
      mergedMeta.push(...refineMeta.urlContexts)
    }
    const merged = mergeUrlContexts([], mergedMeta)
    if (merged.length) return { urlContexts: merged }
    // Fallback: convert groundingAcc sources when urlContexts missing
    const groundingFallback = buildGroundingMetadata(groundingAcc)
    if (groundingFallback?.sources?.length) {
      const fallback = groundingFallback.sources
        .map((s) => (s?.uri ? { uri: s.uri, title: s.title || null } : null))
        .filter(Boolean)
      const mergedFallback = mergeUrlContexts([], fallback)
      return mergedFallback.length ? { urlContexts: mergedFallback } : null
    }
    return null
  })()

  socket.emit('end_generation', {
    ok: true,
    chatId,
    requestId,
    urlContextMetadata: mergedUrlContextMetadata,
    grounding: buildGroundingMetadata(groundingAcc),
  })
}
