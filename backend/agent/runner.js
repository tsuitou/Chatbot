import { GoogleGenAI } from '@google/genai'
import {
  agentAddendumClarify,
  agentFormatRules,
  agentPersonaInstruction,
  clarifyTurnPrompt,
  criticalAgentRules,
  finalTurnPrompt,
  flowInstruction,
  commonAgentPolicies,
  searchPolicyInstruction,
  buildPlanPrompt,
} from './prompts.js'

// Track the last emitted step to add breathing room between phases
let lastEmittedStep = null

// NOTE: Do not auto-inject URL-related instructions into user prompts.
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
  grounding = null,
}) {
  if (!socket) return
  // IMPORTANT: allow metadata-only chunks on FINAL so the frontend can receive grounding even
  // when the model emits it in a chunk without text parts.
  const allowEmptyPart = step === 'final' && grounding && typeof grounding === 'object'
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

  }

  if (!shapedParts.length) {
    if (!allowEmptyPart) return shapedParts
    shapedParts.push({ text: '', thought: !!forceThoughts && !forceAnswer })
  }

  lastEmittedStep = step

  // Match backend/providers/gemini.js: emit groundingMetadata as `grounding` (when present).
  const chunkPayload = {
    chatId,
    requestId,
    step,
    parts: shapedParts,
    provider: 'gemini',
  }
  if (step === 'final' && grounding && typeof grounding === 'object') {
    chunkPayload.grounding = grounding
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

function mergeGroundingChunks(existing = [], incoming = []) {
  const map = new Map()
  const add = (chunk) => {
    if (!chunk || typeof chunk !== 'object') return
    const uri = chunk?.web?.uri
    const key = uri || JSON.stringify(chunk)
    if (!map.has(key)) map.set(key, chunk)
  }
  for (const c of existing) add(c)
  for (const c of incoming) add(c)
  return Array.from(map.values())
}

function mergeWebSearchQueries(existing = [], incoming = []) {
  const set = new Set()
  const add = (q) => {
    const t = typeof q === 'string' ? q.trim() : ''
    if (t) set.add(t)
  }
  for (const q of existing) add(q)
  for (const q of incoming) add(q)
  return Array.from(set)
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

function summarizeTokenUsage(tokenUsage) {
  const all = [
    tokenUsage?.precheck || null,
    tokenUsage?.clarify || null,
    tokenUsage?.plan || null,
    tokenUsage?.final || null,
  ].filter(Boolean)

  const sumField = (m, key) => (m && typeof m[key] === 'number' ? m[key] : 0)

  const breakdown = {
    prompt: all.reduce((acc, m) => acc + sumField(m, 'promptTokenCount'), 0),
    tool: all.reduce((acc, m) => acc + sumField(m, 'toolUsePromptTokenCount'), 0),
    output: all.reduce((acc, m) => acc + sumField(m, 'candidatesTokenCount'), 0),
    thoughts: all.reduce((acc, m) => acc + sumField(m, 'thoughtsTokenCount'), 0),
    total: all.reduce((acc, m) => acc + sumField(m, 'totalTokenCount'), 0),
  }

  const stepTotal = (m) => sumField(m, 'totalTokenCount')

  return {
    steps: {
      precheck: stepTotal(tokenUsage?.precheck || null),
      clarify: stepTotal(tokenUsage?.clarify || null),
      plan: stepTotal(tokenUsage?.plan || null),
      final: stepTotal(tokenUsage?.final || null),
    },
    breakdown,
  }
}

function formatFunctionCallForLog(call) {
  const name = call?.name ? String(call.name) : '(unknown)'
  let args = call?.args ?? call?.arguments
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args)
    } catch {
      // keep as string
    }
  }
  let argsText = ''
  try {
    argsText = args === undefined ? '' : JSON.stringify(args, null, 2)
  } catch {
    argsText = String(args)
  }
  if (argsText && argsText.length > 4000) {
    argsText = argsText.slice(0, 4000) + '\n…(truncated)'
  }
  return `\n[FUNCTION_CALL]\nname: ${name}${argsText ? `\nargs:\n${argsText}` : ''}\n`
}

function formatFunctionResponseForLog(resp) {
  const name = resp?.name ? String(resp.name) : '(unknown)'
  let response = resp?.response ?? resp?.content ?? resp?.data
  let bodyText = ''
  try {
    bodyText = response === undefined ? '' : JSON.stringify(response, null, 2)
  } catch {
    bodyText = String(response)
  }
  if (bodyText && bodyText.length > 4000) {
    bodyText = bodyText.slice(0, 4000) + '\n…(truncated)'
  }
  return `\n[FUNCTION_RESPONSE]\nname: ${name}${bodyText ? `\nresponse:\n${bodyText}` : ''}\n`
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
  collectGroundingMetadata = false,
  collectAnswerText = false,
  collectAnswerParts = false,
  suppressEmit = false,
}) {
  const stream = await chat.sendMessageStream({ message, config })
  const functionCalls = []
  let usageMetadata = null
  let aggregatedGroundingChunks = []
  let aggregatedWebSearchQueries = []
  const collectedAnswerParts = collectAnswerText ? [] : null
  const collectedAnswerPartsRaw = collectAnswerParts ? [] : null
  let collectedAnswerRole = null
  const emittedToolEvents = new Set()

  for await (const chunk of stream) {
    const candidate = chunk?.candidates?.[0] || {}
    const parts = candidate.content?.parts || []
    const contentRole = candidate?.content?.role
    const groundingNow = candidate?.groundingMetadata || candidate?.grounding || null
    if (collectGroundingMetadata) {
      const grounding = candidate?.groundingMetadata || candidate?.grounding
      if (grounding?.groundingChunks?.length) {
        aggregatedGroundingChunks = mergeGroundingChunks(
          aggregatedGroundingChunks,
          grounding.groundingChunks
        )
      }
      if (grounding?.webSearchQueries?.length) {
        aggregatedWebSearchQueries = mergeWebSearchQueries(
          aggregatedWebSearchQueries,
          grounding.webSearchQueries
        )
      }
    }
    if (!suppressEmit) {
      const shapedParts = emitContentParts({
        parts,
        socket,
        chatId,
        requestId,
        step,
        forceThoughts,
        forceAnswer,
        debugLog,
        grounding: groundingNow,
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
    } else if (collectAnswerText || collectAnswerParts) {
      for (const part of parts) {
        const hasTextField = part?.text !== undefined && part?.text !== null
        if (!hasTextField) continue
        const thoughtFlag = forceAnswer
          ? false
          : forceThoughts
            ? true
            : !!part?.thought
        if (thoughtFlag) continue
        const text = String(part.text)
        if (!text) continue
        if (collectAnswerText && collectedAnswerParts) {
          collectedAnswerParts.push(text)
        }
        if (collectAnswerParts && collectedAnswerPartsRaw) {
          collectedAnswerPartsRaw.push({ text })
          if (!collectedAnswerRole && contentRole) {
            collectedAnswerRole = contentRole
          }
        }
      }
    }
    if (groundingAcc) {
      updateGrounding(groundingAcc, candidate)
    }

    const emitToolEvent = (text) => {
      if (suppressEmit) return
      if (!text) return
      emitContentParts({
        parts: [{ text }],
        socket,
        chatId,
        requestId,
        step,
        forceThoughts: true,
        forceAnswer: false,
        debugLog: debugLog,
        grounding: null,
      })
    }

    // Check for function calls and responses in parts (new API format)
    for (const part of parts) {
      if (part?.functionCall) {
        functionCalls.push(part.functionCall)
        const key = `call:${part.functionCall?.name}:${JSON.stringify(part.functionCall?.args ?? part.functionCall?.arguments ?? '')}`
        if (!emittedToolEvents.has(key)) {
          emittedToolEvents.add(key)
          emitToolEvent(formatFunctionCallForLog(part.functionCall))
        }
      }
      if (part?.functionResponse) {
        const resp = part.functionResponse
        const key = `resp:${resp?.name}:${JSON.stringify(resp?.response ?? resp?.content ?? resp?.data ?? '')}`
        if (!emittedToolEvents.has(key)) {
          emittedToolEvents.add(key)
          emitToolEvent(formatFunctionResponseForLog(resp))
        }
      }
    }

    // Also check candidate.functionCalls (old API format)
    const calls = candidate.functionCalls || []
    if (Array.isArray(calls) && calls.length) {
      for (const call of calls) {
        functionCalls.push(call)
        const key = `call_old:${call?.name}:${JSON.stringify(call?.args ?? call?.arguments ?? '')}`
        if (!emittedToolEvents.has(key)) {
          emittedToolEvents.add(key)
          emitToolEvent(formatFunctionCallForLog(call))
        }
      }
    }

    // Capture usage metadata from chunk
    if (chunk?.usageMetadata) {
      usageMetadata = chunk.usageMetadata
    }
  }

  // Log token usage if available
  if (debugLog && usageMetadata) {
    const { promptTokenCount, candidatesTokenCount, totalTokenCount, thoughtsTokenCount, toolUsePromptTokenCount } = usageMetadata
    console.log(`[agent-runner] ${step.toUpperCase()} tokens: prompt=${promptTokenCount || 0}, tool=${toolUsePromptTokenCount || 0}, output=${candidatesTokenCount || 0}, thoughts=${thoughtsTokenCount || 0}, total=${totalTokenCount || 0}`)
  }

  return {
    functionCalls,
    usageMetadata,
    groundingMetadata: collectGroundingMetadata
      ? {
          webSearchQueries: aggregatedWebSearchQueries,
          groundingChunks: aggregatedGroundingChunks,
        }
      : null,
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
  return extractOriginalUserText(message)
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

function findFirstUserIndexAfter(history, startIndex) {
  if (!Array.isArray(history)) return -1
  const from = typeof startIndex === 'number' && startIndex >= 0 ? startIndex : 0
  for (let i = from; i < history.length; i++) {
    const m = history[i]
    if (m && m.role === 'user') return i
  }
  return -1
}

function concatModelTextAfterIndex(history, startIndex) {
  if (!Array.isArray(history) || history.length === 0) return ''
  const from = typeof startIndex === 'number' && startIndex >= 0 ? startIndex + 1 : 0
  const chunks = []
  for (let i = from; i < history.length; i++) {
    const m = history[i]
    if (!m || m.role !== 'model') continue
    const text = extractAssistantText(m)
    if (text) chunks.push(text)
  }
  return chunks.join('\n')
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

  const sessionModel = requestConfig.model || resolvedBaseModel
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

  // Unified system instruction: Default + User + Agent (do not split by step)
  const unifiedSystemInstruction = [
    defaultSystemInstruction || null,
    userSystemInstruction || null,
    criticalAgentRules,
    commonAgentPolicies,
    agentFormatRules,
    agentPersonaInstruction,
    searchPolicyInstruction,
    flowInstruction,
  ]
    .filter(Boolean)
    .join('\n\n')

  const createSessionChat = ({ model, history, config = {} }) =>
    ai.chats.create({
      model,
      config: {
        systemInstruction: unifiedSystemInstruction || undefined,
        thinkingConfig: baseThinking,
        ...config,
      },
      history,
    })

  const runStep = async ({
    model,
    history,
    prompt,
    step,
    streamConfig,
    streamOptions = {},
    chatConfig = {},
  }) => {
    const baseLen = Array.isArray(history) ? history.length : 0
    const chat = createSessionChat({ model, history, config: chatConfig })
    const result = await streamOnce({
      chat,
      message: toUserContent(prompt),
      socket,
      chatId,
      requestId,
      step,
      debugLog: debugMode,
      ...streamOptions,
      config: streamConfig,
    })
    const nextHistory = typeof chat.getHistory === 'function' ? chat.getHistory() : history
    const userIndex = findFirstUserIndexAfter(nextHistory, baseLen)
    const stepText = concatModelTextAfterIndex(nextHistory, userIndex)
    return { chat, result, history: nextHistory, stepText }
  }

  // Get current date for context
  const currentDate = new Date().toLocaleDateString('en-CA') // YYYY-MM-DD in local time

  // --- PRE-CHECK: Determine if agent workflow is needed ---
  const precheckPrompt = [
    'STEP=PRECHECK',
    '',
    `Current date: ${currentDate}`,
    '',
    'Decide whether multi-step agent research is needed.',
    '',
    'IMPORTANT OUTPUT RULES:',
    '- If multi-step agent workflow is needed: call start_agent({ reason: "..." }) and do not answer the user.',
    '- Otherwise: answer the user directly (no function call).',
    '- 検索の実行が望まれていない時、これまでの情報で応答が可能な時は、むしろエージェント動作は邪魔になる。直接応答を行うこと',
    '',
    'Rule of thumb: if the answer needs current facts, external sources, or URL analysis -> start_agent.',
    '',
    '=== USER REQUEST ===',
    extractOriginalUserText(contents),
    '',
  ]
    .filter(Boolean)
    .join('\n')

  const { result: precheckResult } = await runStep({
    model: sessionModel,
    history: historyForChat,
    prompt: precheckPrompt,
    step: 'precheck',
    streamOptions: {
      forceThoughts: false,
      forceAnswer: false,
      groundingAcc: null,
      collectAnswerParts: true,
      suppressEmit: true,
    },
    streamConfig: {
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

  const tokenUsage = {
    precheck: precheckResult.usageMetadata,
    clarify: null,
    plan: null,
    final: null,
  }

  if (!agentStartCall) {
    // PRECHECK answered directly: emit as FINAL body (not thoughts).
    emitContentParts({
      parts: precheckResult.answerParts || [],
      socket,
      chatId,
      requestId,
      step: 'final',
      forceThoughts: false,
      forceAnswer: true,
      debugLog: debugMode,
      grounding: null,
    })
    socket.emit('end_generation', {
      ok: true,
      chatId,
      requestId,
      tokenUsage: summarizeTokenUsage(tokenUsage),
    })
    return
  }

  // Agent workflow is needed, continue with CLARIFY and PLAN before FINAL
  const groundingAcc = { sources: new Map(), queries: new Set() }

  // --- Clarify stage (always once) ---
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

  const { result: clarifyResult, history: clarifyHistory } = await runStep({
    model: resolvedBaseModel,
    history: historyForChat,
    prompt: clarifyPrompt,
    step: 'clarify',
    streamOptions: { forceThoughts: true, groundingAcc },
    streamConfig: {
      tools: [{ googleSearch: {} }],
      thinkingConfig: baseThinking,
      topP: 0.2,
    },
  })
  accumulateFromCalls(groundingAcc, clarifyResult.functionCalls)
  tokenUsage.clarify = clarifyResult.usageMetadata

  // --- PLAN stage (always once; no tools) ---
  const planPrompt = [
    'STEP=PLAN',
    '',
    `=== CURRENT DATE ===`,
    `Today's date: ${currentDate}`,
    '',
    '=== USER REQUEST ===',
    extractUserText(contents),
    '',
    buildPlanPrompt({ currentDate }),
    '',
  ]
    .filter(Boolean)
    .join('\n')

  const { result: planResult, history: planHistory } = await runStep({
    model: resolvedBaseModel,
    history: clarifyHistory,
    prompt: planPrompt,
    step: 'plan',
    streamOptions: { forceThoughts: true, groundingAcc },
    streamConfig: { thinkingConfig: baseThinking, topP: 0.2 },
  })

  tokenUsage.plan = planResult.usageMetadata
  let currentHistory = planHistory


  // --- FINAL: user-facing answer with optional searches ---
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

  const { result: finalResult } = await runStep({
    model: resolvedBaseModel,
    history: currentHistory,
    prompt: finalPrompt,
    step: 'final',
    streamOptions: { groundingAcc, collectGroundingMetadata: true },
    streamConfig: { tools: [{ googleSearch: {} }, { urlContext: {} }], thinkingConfig: baseThinking },
    chatConfig: { topP: 0.2 },
  })
  tokenUsage.final = finalResult.usageMetadata

  // Print total token usage summary with breakdown when debugging
  if (debugMode) {
    console.log('\n=== AGENT WORKFLOW TOKEN USAGE SUMMARY ===')
    const summary = summarizeTokenUsage(tokenUsage)
    const precheckTotal = summary.steps.precheck
    const clarifyTotal = summary.steps.clarify
    const planTotal = summary.steps.plan
    const finalTotal = summary.steps.final
    const grandTotal = summary.breakdown.total

    console.log(`PRECHECK:   ${precheckTotal.toLocaleString()} tokens`)
    console.log(`CLARIFY:    ${clarifyTotal.toLocaleString()} tokens`)
    console.log(`PLAN:       ${planTotal.toLocaleString()} tokens`)
    console.log(`FINAL:      ${finalTotal.toLocaleString()} tokens`)
    console.log(`───────────────────────────────────────`)
    console.log(`TOTAL:      ${grandTotal.toLocaleString()} tokens`)
    console.log(``)
    console.log(`BREAKDOWN:`)
    console.log(`  User Input + System:    ${summary.breakdown.prompt.toLocaleString()} tokens (${grandTotal ? ((summary.breakdown.prompt/grandTotal)*100).toFixed(1) : '0.0'}%)`)
    console.log(`  Tool Declarations:      ${summary.breakdown.tool.toLocaleString()} tokens (${grandTotal ? ((summary.breakdown.tool/grandTotal)*100).toFixed(1) : '0.0'}%)`)
    console.log(`  Model Output:           ${summary.breakdown.output.toLocaleString()} tokens (${grandTotal ? ((summary.breakdown.output/grandTotal)*100).toFixed(1) : '0.0'}%)`)
    console.log(`  Thoughts (Reasoning):   ${summary.breakdown.thoughts.toLocaleString()} tokens (${grandTotal ? ((summary.breakdown.thoughts/grandTotal)*100).toFixed(1) : '0.0'}%)`)
    console.log('==========================================\n')
  }

  socket.emit('end_generation', {
    ok: true,
    chatId,
    requestId,
    grounding: buildGroundingMetadata(groundingAcc),
    groundingMetadata: finalResult.groundingMetadata || null,
    tokenUsage: summarizeTokenUsage(tokenUsage),
  })
}
