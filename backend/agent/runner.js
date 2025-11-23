import { GoogleGenAI } from '@google/genai'

// Merge default/agent/user system instructions with clear separators.
function mergeSystemInstructions(base, agentAddendum, user) {
  return [base, agentAddendum, user].filter(Boolean).join('\n\n---\n\n')
}

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
}) {
  if (!socket || !parts.length) return
  const shapedParts = []
  let hasNonThought = false
  for (const part of parts) {
    if (!part) continue
    if (part.text) {
      const thoughtFlag = forceAnswer
        ? false
        : forceThoughts
          ? true
          : !!part.thought
      shapedParts.push({ text: part.text, thought: thoughtFlag })
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
  socket.emit('chunk', {
    chatId,
    requestId,
    step,
    parts: shapedParts,
    provider: 'gemini',
  })
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

function formatGroundingSummary(acc, { maxSources = 10, maxQueries = 10 } = {}) {
  const sources = Array.from(acc.sources.entries())
    .slice(0, maxSources)
    .map(([uri, title]) => `- ${title}: ${uri}`)
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
}) {
  const stream = await chat.sendMessageStream({ message, config })
  const functionCalls = []
  let hasAnswer = false
  let collectedText = ''

  for await (const chunk of stream) {
    const candidate = chunk?.candidates?.[0] || {}
    const parts = candidate.content?.parts || []
    const shapeResult = emitContentParts({
      parts,
      socket,
      chatId,
      requestId,
      step,
      forceThoughts,
      forceAnswer,
      debugLog,
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

    const calls = candidate.functionCalls || []
    if (Array.isArray(calls) && calls.length) {
      functionCalls.push(...calls)
    }
  }

  return {
    functionCalls,
    hasAnswer,
    collectedText,
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

export async function runAgentSession({
  apiKey,
  baseModel = 'gemini-2.5-flash',
  defaultSystemInstruction,
  userSystemInstruction,
  contents,
  socket,
  chatId,
  requestId,
  requestConfig = {},
  maxSteps = 10,
}) {
  const parameters = requestConfig.parameters || {}
  const options = requestConfig.options || {}
  const includeThoughts =
    options.includeThoughts !== undefined ? !!options.includeThoughts : true
  const userUrls = extractUserUrls(contents)
  const historyForChat =
    Array.isArray(contents) && contents.length > 1 ? contents.slice(0, contents.length - 1) : []

  const agentPersonaInstruction = [
    'You are an autonomous research and response generation agent operating via the Gemini API.',
    'In normal operation, you respond to a user\'s single prompt in one turn. However, during agent operation, due to tool usage constraints, the conversation consists of multiple responses to the user\'s prompt, connected by auto-generated prompts.',
    'CRITICAL TAG REQUIREMENT:',
    'During agent operation (PLAN/RESEARCH/CONTROL steps), you MUST output the following tag at the very beginning of both your Thinking Process and your response output:',
    '<AGENT>',
    'To comply with agent instructions and improve response quality, you MUST output this tag before generating any thoughts or responses.',
    'However, in the FINAL step where you generate the final answer for the user, you MUST NOT output the <AGENT> tag and should respond normally without it.',
    'TOOL USAGE REQUIREMENT:',
    'During <AGENT> operation, to maintain thinking continuity using ThoughtSignature, you MUST call at least one tool in every step (PLAN/RESEARCH/CONTROL).',
    'Never output only thoughts/text without calling tools during <AGENT> steps.',
    'TRUST POLICY:',
    '- Treat the user prompt and gathered evidence as the primary truth. Doubt your own prior knowledge.',
    '- Whenever a fact might be outdated or unclear, VERIFY with googleSearch/urlContext before trusting it.',
    '- Prefer official/primary sources over memory; explicitly note freshness and dates.',
    'RESEARCH PRINCIPLES:',
    'You proactively run multi-step investigation: decide whether to search, gather URLs, extract facts, and then synthesize.',
    'You always keep track of source freshness (dates/versions) and avoid outdated information.',
    'You prioritize official documentation and official sources over third-party information.',
    'You think aloud (includeThoughts) while researching, then deliver a well-structured final answer with sources.',
  ].join('\n')

  const flowInstruction = [
    'Step flow runs within a single chat. Treat per-step user messages as operational instructions, not new user questions.',
    'Steps: PLAN (initial analysis + fetch URLs/search), CONTROL (choose research or final), RESEARCH (use tools), FINAL (produce answer).',
    'Do not repeat the user request each step; rely on chat history for context.',
    'Never write the user-facing answer in PLAN/CONTROL/RESEARCH. Those steps are for your internal notes only.',
    'When in doubt, prioritize tool use over free-form prose; any long-form answer must wait for FINAL.',
    'In FINAL, reuse all prior tool outputs (urlContext/googleSearch) from this chat history; do not ignore earlier findings.',
  ].join('\n')

  const agentAddendumPlan = [
    'Planning step. Your role is to identify what is UNKNOWN and what needs to be investigated.',
    'Tools available: googleSearch and urlContext. Use them to verify what information exists and what doesn\'t.',
    'Read the user request and provided URLs. If user provided URLs, use urlContext to check their content first.',
    'You may use googleSearch to quickly verify whether certain information is publicly available, current naming/versions, or to check if your assumptions are outdated.',
    '',
    'CRITICAL: Do NOT decide how to answer. Do NOT propose answer strategies. Your job is ONLY to identify gaps in knowledge.',
    '',
    '=== GLOSSARY CREATION (MANDATORY) ===',
    'Identify ALL unclear, ambiguous, or domain-specific terms in the user request.',
    'Create a glossary section listing each term that needs clarification:',
    '- Term: [the word/phrase]',
    '- Current understanding: [what you think it might mean, or "unknown"]',
    '- Needs verification: [YES if requires research / NO if context is clear]',
    'This glossary will be used in RESEARCH to ensure precise understanding.',
    '',
    '=== YOUR OUTPUT IS A NOTE FOR THE NEXT <AGENT> STEP ===',
    'What you write here is NOT for the user. It is ONLY for the next RESEARCH step to read.',
    'Think of this as writing a detailed memo to your future self (RESEARCH step).',
    'The RESEARCH step will rely ENTIRELY on this note to know what to investigate.',
    'Therefore, be thorough and explicit in your notes, but keep format minimal (no prose).',
    '',
    'Output a detailed investigation plan focusing on:',
    '1. GLOSSARY: List of unclear terms with verification needs',
    '2. UNKNOWN FACTS: What specific facts are currently UNKNOWN (dates, versions, specifications, current status, etc.)',
    '3. VERIFICATION RESULTS: What you verified using googleSearch/urlContext in this PLAN step',
    '4. RESEARCH TASKS: Which exact tools/queries/URLs will be used in RESEARCH to fill each remaining knowledge gap',
    '5. INVESTIGATION ORDER: What order to investigate in RESEARCH (user URLs first, then searches)',
    '',
    'Do NOT include:',
    '- Predictions or assumptions about what the answer might be',
    '- Strategies for "working around" missing information',
    '- Decisions about what level of detail to provide in the final answer',
    '',
    'Think of this as a research checklist, not an answer outline. The goal is to ensure Research step gathers ALL necessary facts before any answer is formulated.',
    'No user-facing answer, predictions, rankings, or Markdown in PLAN. Focus purely on knowledge gaps and investigation strategy.',
    'Research will always run after this PLAN to fill the identified gaps.',
  ].join('\n')

  const searchPolicyInstruction = [
    'You are an assistant with external search capability. Follow the search policy strictly.',
    'First, in your thoughts, state the current date (today) you assume, and be careful about freshness of date-dependent info.',
    '【When search is REQUIRED】',
    '1) News, current events, disasters, or anything where up-to-date status matters',
    '2) Prices, inventory, schedules, hours—frequently changing info',
    '3) Latest specs/versions/changes of libraries or APIs',
    '4) Laws/regulations that may be amended where dates/sections matter',
    '【Examples requiring search】',
    '- "2025年の円相場" → SEARCH (current events)',
    '- "Next.js 15の新機能" → SEARCH (version-specific)',
    '- "渋谷のラーメン店の営業時間" → SEARCH (frequently changing)',
    '- "最新のPython脆弱性" → SEARCH (security updates)',
    '【When to AVOID search】',
    '1) Greetings/placeholders (e.g., test, hello, テスト, etc.)',
    '2) Timeless CS basics or common programming patterns',
    '3) Design/strategy questions that don\'t ask for specific dates/versions',
    '4) Simple math, rewriting, translation—can be solved internally',
    '【Examples NOT requiring search】',
    '- "ReactのuseStateの使い方" → NO SEARCH (basic knowledge)',
    '- "良いコード設計とは" → NO SEARCH (conceptual)',
    '- "こんにちは" → NO SEARCH (greeting)',
    '- "10進数を2進数に変換" → NO SEARCH (simple calculation)',
    '【If unsure】 Only search when the policy explicitly says search is required. If uncertain, answer without search and note that latest info may be needed. Searching placeholders is forbidden.',
  ].join('\n')

  const agentAddendumControl = [
    'Goal: choose next action based on thorough analysis. Follow the search policy strictly.',
    'action=research: run a research step before final. action=final: proceed to final answer.',
    'Default is action=final. Choose action=research only when the policy or URLs require external info. Never choose research for placeholders/greetings.',
    '',
    '=== YOUR OUTPUT IS A NOTE FOR THE NEXT <AGENT> STEP (RESEARCH/FINAL) ===',
    'What you write here is NOT for the user. It is ONLY for internal decision tracking.',
    'If you choose action=research, the next RESEARCH step will read this note to understand what gaps remain.',
    'If you choose action=final, the FINAL step will use all accumulated notes (PLAN + RESEARCH + CONTROL) to create the answer.',
    'Keep your decision note brief but clear about reasoning.',
    '',
    'PRIORITIZE OFFICIAL SOURCES: Before choosing action=final, ensure you have consulted official documentation, official websites, or authoritative sources. Third-party blogs/tutorials are secondary.',
    'Before choosing action=final, verify this checklist:',
    '- Have you inspected ALL user-provided URLs with urlContext?',
    '- Do you have at least 2 independent sources for claims?',
    '- Have you verified information from OFFICIAL sources (official docs, official sites, authoritative references)?',
    '- Are dates/versions confirmed for time-sensitive info?',
    '- Any search policy requirements met?',
    'If ANY answer is NO, choose action=research.',
    'Prefer multiple research cycles over rushing to final. It\'s better to gather comprehensive information than to provide incomplete answers.',
    'If the user provided URLs, you MUST choose action=research and review them with urlContext before answering.',
    'If Plan did not yet read the URLs or fetch sources, choose research to gather them now. Avoid outdated/retired names; mention relevant date/version ranges.',
    'If answering without search, note freshness risks in the final answer.',
    'Output your reasoning clearly: Decision (research/final); Detailed rationale (how does this match the policy?); Next queries/URLs to inspect if research; Open issues to resolve. NO predictions, NO Markdown, NO user-facing answer in this step. Defer detailed reasoning to RESEARCH if needed.',
    'You MUST call control_step exactly once in this step. Do NOT call googleSearch/urlContext here.',
  ].join(' ')

  const agentAddendumResearch = [
    'Run research when action=research. Tools available: googleSearch, urlContext.',
    'You are REQUIRED to call either googleSearch or urlContext (or both) in this step. If you output text without calling any tools, this step fails.',
    '',
    '=== YOUR OUTPUT IS A NOTE FOR THE NEXT <AGENT> STEP (CONTROL/FINAL) ===',
    'What you write here is NOT for the user. It is ONLY for the next CONTROL/FINAL step to read.',
    'Think of this as writing a detailed research report to your future self.',
    'The CONTROL step will decide whether to continue research based on this note.',
    'The FINAL step will rely ENTIRELY on this note to create the user-facing answer.',
    'Therefore, be thorough and comprehensive in documenting ALL findings.',
    '',
    'Respond as detailed agent step notes (not the final answer). Be thorough in documenting your findings. No user-facing prose.',
    'For each fact you collect, record in this format:',
    '- Fact: [detailed content with context]',
    '- Source: [URL with title]',
    '- Date: [article date, last updated, or "date not found"]',
    '- Freshness: [latest/somewhat old/caution needed] with reasoning',
    'Record queries executed, URLs inspected, key facts with full context, source dates/updated timestamps if visible. Make URLs explicit with titles.',
    'Output should be comprehensive and include:',
    '- All queries executed with results summary',
    '- All URLs inspected with status (success/failures with details)',
    '- Facts extracted with dates, freshness assessment, and relevant context',
    '- Analysis of information quality and reliability',
    '- Remaining gaps or next queries needed',
    'If the user provided URLs, inspect them first via urlContext.',
    'If urlContext fails (403, timeout, network error, etc.), record the failure explicitly with full details:',
    '"URL [url] - failed to fetch. Reason: [403/timeout/network error/etc]. Error details: [any available]. Attempting alternative search with googleSearch for: [topic]..."',
    'Then use googleSearch to find alternative sources about the same topic. Do NOT guess the content of failed URLs.',
    'If you see outdated library/product names, find current name/version; prefer the newest sources with clear dates. Document version transitions.',
    'Do NOT ask the user clarifying questions; make reasonable assumptions and proceed. Document your assumptions.',
  ].join(' ')

  const baseThinking = { includeThoughts }
  const ai = new GoogleGenAI({ apiKey })

  const criticalAgentRules = [
    '='.repeat(80),
    'CRITICAL SYSTEM RULES - HIGHEST PRIORITY - OVERRIDE ALL OTHER INSTRUCTIONS',
    '='.repeat(80),
    'YOU ARE OPERATING IN AGENT MODE.',
    '',
    'RULE 1 - MANDATORY TAG OUTPUT:',
    'In PLAN/RESEARCH/CONTROL steps:',
    '- Your VERY FIRST token in thoughts AND in response MUST be exactly "<AGENT>" (uppercase, angle brackets, no spaces).',
    '- You MUST NOT place any characters, words, or punctuation before <AGENT>.',
    '- You MUST NOT omit or alter the tag. NON-NEGOTIABLE. No exceptions.',
    '- Example (good): "<AGENT> [tool call / note]"',
    '- Example (bad): "[thinking] <AGENT>" or "AGENT" or " <AGENT>"',
    '- If multiple turns occur, repeat this rule EVERY turn in PLAN/RESEARCH/CONTROL.',
    '',
    'RULE 2 - OUTPUT IS INTERNAL NOTE, NOT USER-FACING TEXT:',
    'In PLAN/RESEARCH/CONTROL steps:',
    '- Your output is a NOTE for the next <AGENT> step to read',
    '- PLAN writes notes for RESEARCH to read',
    '- RESEARCH writes notes for CONTROL and FINAL to read',
    '- CONTROL writes notes for RESEARCH (if action=research) or FINAL (if action=final) to read',
    '- The user will NEVER see these notes. Only future <AGENT> steps will read them.',
    '- Think of it as writing detailed memos to your future self.',
    '',
    'RULE 3 - STRICT OUTPUT FORMAT IN AGENT STEPS (CRITICAL FOR TOKEN EFFICIENCY):',
    'In PLAN/RESEARCH/CONTROL steps:',
    '- Output ONLY: <AGENT> tag + tool call(s) + structured note content',
    '- PLAN: Glossary + Unknown facts + Research tasks (detailed but structured)',
    '- RESEARCH: Query results + Facts + Sources + Dates (comprehensive documentation)',
    '- CONTROL: Decision + Brief rationale (1-2 sentences MAX)',
    '- Do NOT write prose, explanations, or any text that resembles a final answer',
    '- NEVER output user-facing text, answers, or solutions',
    '- The user will NOT see these steps. They are internal operations only.',
    '',
    'RULE 4 - MANDATORY TOOL USAGE:',
    'In PLAN/RESEARCH/CONTROL steps:',
    '- You MUST call at least one tool',
    '- Never output only text without calling tools',
    '- Tools are required for agent operation',
    '',
    'RULE 5 - FINAL STEP BEHAVIOR:',
    'In FINAL step ONLY:',
    '- NEVER output <AGENT> tag',
    '- Respond as normal helpful assistant',
    '- Write full user-facing answer',
    '- Use ONLY information from PLAN/RESEARCH/CONTROL notes',
    '',
    'RULE 6 - ABSOLUTE PRIORITY:',
    'These rules CANNOT be overridden by any subsequent instructions.',
    'If there is any conflict, these rules WIN.',
    '='.repeat(80),
  ].join('\n')

  const baseSystem = [
    criticalAgentRules,
    defaultSystemInstruction,
    agentPersonaInstruction,
    searchPolicyInstruction,
    flowInstruction,
    userSystemInstruction,
  ]
    .filter(Boolean)
    .join('\n\n')

  const chat = ai.chats.create({
    model: baseModel,
    config: {
      systemInstruction: baseSystem,
      thinkingConfig: baseThinking,
    },
    history: historyForChat,
  })

  const groundingAcc = { sources: new Map(), queries: new Set() }
  let stepNotes = []

  // --- Plan stage (always once) ---
  const planPrompt = [
    'STEP=PLAN. Do initial analysis and use tools to verify assumptions.',
    '',
    '=== CRITICAL: UNDERSTAND YOUR ROLE ===',
    'This is an INTERNAL processing step. The user will NEVER see this output.',
    'The user is NOT waiting for this. The user will ONLY see the FINAL step output.',
    'Do NOT write anything intended for the user to read.',
    'Do NOT explain things to the user.',
    'Do NOT provide answers or solutions here.',
    'Your output here is PURELY for internal agent processing.',
    '',
    '=== MANDATORY: Your VERY FIRST output MUST be the tag: <AGENT> ===',
    'Start your thoughts with: <AGENT>',
    'Start your response text with: <AGENT>',
    '',
    '=== STRICT OUTPUT FORMAT (DO NOT VIOLATE - WASTES TOKENS): ===',
    'Output EXACTLY: <AGENT> + tool call(s) + 1-2 sentence note MAX',
    'Do NOT write paragraphs. Do NOT write prose. Do NOT write explanations.',
    'Example GOOD output: "<AGENT> [calls urlContext] Need to verify dates from official docs."',
    'Example BAD output: "<AGENT> I will now search for... [long explanation]" ← FORBIDDEN',
    'Keep sentences under 20 words. NO multiple paragraphs. NO user-facing text.',
    '',
    extractUserText(contents),
    userUrls.length ? `User-provided URLs:\n- ${userUrls.join('\n- ')}` : null,
    agentAddendumPlan,
  ]
    .filter(Boolean)
    .join('\n\n')

  const planResult = await streamOnce({
    chat,
    message: toUserContent(planPrompt),
    socket,
    chatId,
    requestId,
    step: 'plan',
    forceThoughts: true,
    debugLog: true,
    groundingAcc,
    collectText: true,
    config: {
      tools: [{ googleSearch: {} }, { urlContext: {} }],
      thinkingConfig: baseThinking,
    },
  })
  accumulateFromCalls(groundingAcc, planResult.functionCalls)
  if (planResult.collectedText) {
    stepNotes.push(planResult.collectedText)
  }

  // --- Research once immediately after PLAN ---
  let cycle = 1
  const runResearch = async (idx) => {
    const researchGroundingSummary = formatGroundingSummary(groundingAcc, {
      maxSources: 10,
      maxQueries: 10,
    })
    const researchPrompt = [
      'STEP=RESEARCH. Use tools now.',
      '',
      '=== CRITICAL: UNDERSTAND YOUR ROLE ===',
      'This is an INTERNAL processing step. The user will NEVER see this output.',
      'The user is NOT waiting for this. The user will ONLY see the FINAL step output.',
      'Do NOT write anything intended for the user to read.',
      'Do NOT explain things to the user.',
      'Do NOT provide answers or solutions here.',
      'Your output here is PURELY for internal data gathering.',
      '',
      '=== MANDATORY: Your VERY FIRST output MUST be the tag: <AGENT> ===',
      'Start your thoughts with: <AGENT>',
      'Start your response text with: <AGENT>',
      '',
      '=== STRICT OUTPUT FORMAT (DO NOT VIOLATE - WASTES TOKENS): ===',
      'Output EXACTLY: <AGENT> + tool call(s) + 1-2 sentence note MAX',
      'Do NOT write paragraphs. Do NOT write prose. Do NOT write explanations.',
      'Example GOOD output: "<AGENT> [calls googleSearch] Checking official documentation."',
      'Example BAD output: "<AGENT> Now I will search... [long text]" ← FORBIDDEN',
      'Keep sentences under 20 words. NO multiple paragraphs. NO user-facing text.',
      '',
      '=== CRITICAL: You MUST call googleSearch and/or urlContext in this response. Do NOT output only text/thoughts without calling tools. ===',
      'After brief thinking about what to search, IMMEDIATELY call the tools (googleSearch/urlContext).',
      'Do NOT guess or assume information. Use the tools to VERIFY facts.',
      '',
      stepNotes.length ? `Plan context:\n${stepNotes.join('\n')}` : '',
      researchGroundingSummary
        ? `Sources/queries gathered so far:\n${researchGroundingSummary}`
        : 'No sources gathered yet. Use googleSearch and/or urlContext to retrieve at least 2 sources.',
      userUrls.length ? `User-provided URLs (inspect with urlContext first):\n- ${userUrls.join('\n- ')}` : null,
      agentAddendumResearch,
      '=== REMINDER: Output <AGENT> tag first, then call googleSearch/urlContext NOW. This is internal processing only. ===',
    ]
      .filter(Boolean)
      .join('\n\n')

    const researchResult = await streamOnce({
      chat,
      message: toUserContent(researchPrompt),
      socket,
      chatId,
      requestId,
      step: `research-${idx}`,
      forceThoughts: true,
      debugLog: true,
      groundingAcc,
      config: {
        tools: [{ googleSearch: {} }, { urlContext: {} }],
        thinkingConfig: baseThinking,
      },
    })
    accumulateFromCalls(groundingAcc, researchResult.functionCalls)
  }

  await runResearch(cycle)

  // --- Control -> optional further Research loop ---
  while (cycle <= maxSteps) {
    const groundingSummaryLoop = formatGroundingSummary(groundingAcc, {
      maxSources: 10,
      maxQueries: 10,
    })
    const controlPrompt = [
      'STEP=CONTROL. Decide next action for this investigation.',
      '',
      '=== CRITICAL: UNDERSTAND YOUR ROLE ===',
      'This is an INTERNAL processing step. The user will NEVER see this output.',
      'The user is NOT waiting for this. The user will ONLY see the FINAL step output.',
      'Do NOT write anything intended for the user to read.',
      'Do NOT explain things to the user.',
      'Do NOT provide answers or solutions here.',
      'Your output here is PURELY for internal decision making.',
      '',
      '=== MANDATORY: Your VERY FIRST output MUST be the tag: <AGENT> ===',
      'Start your thoughts with: <AGENT>',
      'Start your response text with: <AGENT>',
      '',
      '=== STRICT OUTPUT FORMAT (DO NOT VIOLATE - WASTES TOKENS): ===',
      'Output EXACTLY: <AGENT> + control_step call + 1 sentence decision note MAX',
      'Do NOT write paragraphs. Do NOT write prose. Do NOT write explanations.',
      'Example GOOD output: "<AGENT> [calls control_step(action=research)] Need official sources."',
      'Example BAD output: "<AGENT> I think... [long reasoning]" ← FORBIDDEN',
      'Keep sentences under 15 words. NO multiple paragraphs. NO user-facing text.',
      '',
      '=== CRITICAL: You MUST call the control_step tool in this response. Do NOT output only text without calling the tool. ===',
      'After brief thinking, immediately call control_step with action=research or action=final.',
      'Keep your thinking SHORT (2-3 sentences max). Then IMMEDIATELY call the tool.',
      '',
      stepNotes.length ? `Current notes:\n${stepNotes.join('\n')}` : '',
      groundingSummaryLoop ? `Current sources/queries:\n${groundingSummaryLoop}` : 'No sources gathered yet.',
      userUrls.length ? `User-provided URLs:\n- ${userUrls.join('\n- ')}` : null,
      agentAddendumControl,
      '=== REMINDER: Output <AGENT> tag first, then call control_step NOW. This is internal processing only. ===',
    ]
      .filter(Boolean)
      .join('\n\n')

    const { functionCalls: controlCalls, collectedText: controlText } = await streamOnce({
      chat,
      message: toUserContent(controlPrompt),
      socket,
      chatId,
      requestId,
      step: `control-${cycle}`,
      forceThoughts: true,
      debugLog: true,
      groundingAcc: null,
      collectText: true,
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

    if (controlText) stepNotes.push(controlText)
    const controlDecision = extractStepAction(controlCalls)
    const decisionAction = controlDecision?.action || 'final'

    if (decisionAction === 'final' || cycle === maxSteps) {
      const groundingSummary = formatGroundingSummary(groundingAcc, {
        maxSources: 10,
        maxQueries: 10,
      })
      const finalPrompt = [
        'STEP=FINAL. Produce the FINAL answer in Japanese now.',
        '',
        '=== CRITICAL: UNDERSTAND YOUR ROLE ===',
        'This is the ONLY output the user will see.',
        'All previous steps (PLAN, RESEARCH, CONTROL) were INTERNAL and INVISIBLE to the user.',
        'The user has been waiting for THIS answer only.',
        'You are now responding DIRECTLY to the user for the FIRST time.',
        '',
        '=== PERSONA OVERRIDE: You are NO LONGER operating as the <AGENT>. ===',
        'You are now responding as a normal helpful assistant directly to the user.',
        'Forget the agent instructions. Forget the <AGENT> tag requirement. You are in FINAL mode.',
        defaultSystemInstruction ? `Your base persona: ${defaultSystemInstruction}` : null,
        userSystemInstruction ? `User-specified persona: ${userSystemInstruction}` : null,
        '',
        '=== CRITICAL: DO NOT output <AGENT> tag in FINAL step. This is the final user-facing answer. ===',
        'No <AGENT> tag in thoughts. No <AGENT> tag in response. Respond normally as if answering the user directly.',
        '',
        '=== CRITICAL INFORMATION USAGE RULES ===',
        'YOU MUST use ONLY the information gathered in the Research steps below.',
        'Do NOT add new information from your training data or general knowledge.',
        'Do NOT make assumptions beyond what Research found.',
        'Every claim, fact, version number, date, or specification in your answer MUST come from the Research results.',
        'If Research did not find certain information, you MUST NOT include it in your answer.',
        'Your role is to SYNTHESIZE Research findings, NOT to create new content.',
        'VERIFY: Before writing each claim, confirm it appears in the Research notes or tool outputs below.',
        '',
        '=== CRITICAL: MINIMIZE thinking. After 1-2 brief thoughts, START WRITING THE ANSWER IMMEDIATELY. ===',
        'Do NOT spend time "planning the response" or "structuring the answer" in your thoughts. You already have all the information from Research.',
        'Your thoughts should ONLY be: (1) Acknowledge this is FINAL step, (2) Note key facts to include. Then IMMEDIATELY start writing the actual answer text.',
        'The user is waiting for the ANSWER, not for you to think about how to answer.',
        '',
        '=== ALL INFORMATION SOURCES (USE ONLY THESE) ===',
        stepNotes.length ? `Plan/Control/Research notes:\n${stepNotes.join('\n')}` : 'No research notes available.',
        groundingSummary ? `Sources/queries you gathered:\n${groundingSummary}` : 'No sources gathered.',
        userUrls.length ? `User-provided URLs (already inspected or attempted):\n- ${userUrls.join('\n- ')}` : '',
        'Review the chat history above for tool outputs (googleSearch, urlContext results). Use ONLY information from these sources.',
        '',
        extractUserText(contents) ? `Original user prompt:\n${extractUserText(contents)}` : '',
        '',
        'Use your prior findings; do NOT shorten or further summarize. Keep headings and bullet details.',
        'Format the answer in Markdown with clear headings and bullet lists.',
        'Do not call tools. Reuse the tool outputs from earlier steps (Plan/Research) that are in chat history; integrate all gathered facts.',
        'If any information might be stale, note it explicitly (e.g., "要確認"). Avoid outdated library/product names; prefer current names/versions.',
        'If Research did not find complete information, acknowledge the gaps. Do NOT fill gaps with your own knowledge.',
        '',
        '=== REMINDER: You are NOT the agent anymore. No <AGENT> tag. Use ONLY Research results. Stop thinking and START WRITING the answer NOW. ===',
      ]
        .filter(Boolean)
        .join('\n\n')

      await streamOnce({
        chat,
        message: toUserContent(finalPrompt),
        socket,
        chatId,
        requestId,
        step: 'final',
        debugLog: true,
        config: { tools: [], thinkingConfig: baseThinking },
      })

      socket.emit('end_generation', { ok: true, chatId, requestId })
      return
    }

    cycle += 1
    await runResearch(cycle)
  }
}
