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

  // Debug mode controlled by environment variable
  const debugMode = process.env.AGENT_DEBUG === 'true'

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
    '=== PLAN STEP: IDENTIFY WHAT IS UNKNOWN ===',
    '',
    'Your role in this step:',
    '1. Clarify unclear terms by searching (MANDATORY)',
    '2. Check user-provided URLs if any (MANDATORY)',
    '3. Identify what facts are still UNKNOWN',
    '4. Create a research plan for the RESEARCH step',
    '',
    '=== PHASE 1: TERM CLARIFICATION (MANDATORY) ===',
    'Identify ALL unclear, ambiguous, technical, or version-specific terms in the user request.',
    'For EACH unclear term:',
    '- Use googleSearch to find: official name, current version, correct spelling, what it refers to',
    '- Document findings in GLOSSARY section',
    '',
    'Example terms requiring clarification:',
    '- Technology names: "Next.js" → verify current version',
    '- API names: "OpenAI API" → verify current API version/endpoint names',
    '- Product names: "ChatGPT" → verify current model names/versions',
    '- Ambiguous terms: "新しいバージョン" → search to find what "new" actually means',
    '',
    '=== PHASE 2: USER URL INSPECTION (IF PROVIDED) ===',
    'If user provided URLs:',
    '- Use urlContext to access EACH URL',
    '- Document what each URL is about',
    '- Note any failures (403, timeout, etc.) for RESEARCH to handle',
    '',
    '=== PHASE 3: UNKNOWN FACTS IDENTIFICATION ===',
    'After clarifying terms and checking URLs, identify what facts are STILL unknown:',
    '- Specific feature details',
    '- Implementation examples',
    '- Comparisons or benchmarks',
    '- Dates, timelines, availability',
    '- Compatibility information',
    '',
    '=== PHASE 4: RESEARCH PLAN CREATION ===',
    'For each UNKNOWN fact, specify:',
    '- What needs to be searched',
    '- Which tool to use (googleSearch or urlContext)',
    '- Suggested search queries or URLs',
    '',
    '=== OUTPUT FORMAT (REQUIRED) ===',
    'Structure your output as follows:',
    '',
    '<PLAN_OUTPUT>',
    'GLOSSARY:',
    '- [Term]: [Verified meaning/version from googleSearch]',
    '- [Term]: [Verified meaning/version from googleSearch]',
    '',
    'USER_URL_SUMMARY:',
    '- [URL]: [Brief summary of content from urlContext, or "failed to fetch - reason"]',
    '',
    'UNKNOWN_FACTS:',
    '- [Specific unknown fact 1]',
    '- [Specific unknown fact 2]',
    '',
    'RESEARCH_PLAN:',
    '- For [unknown fact 1]: googleSearch "[suggested query]"',
    '- For [unknown fact 2]: urlContext "[specific URL]"',
    '</PLAN_OUTPUT>',
    '',
    '=== IMPORTANT REMINDERS ===',
    '- This output is NOT for the user. It is an internal note for RESEARCH step.',
    '- Do NOT write answers or solutions here.',
    '- Do NOT make predictions about what the answer will be.',
    '- Focus ONLY on: what we know (GLOSSARY), what we checked (USER_URL_SUMMARY), what we don\'t know (UNKNOWN_FACTS), and how to find it (RESEARCH_PLAN).',
  ].join('\n')

  const searchPolicyInstruction = [
    '=== SEARCH POLICY ===',
    '',
    'Context awareness: Always consider the current date and information freshness.',
    '',
    '【WHEN TO USE SEARCH TOOLS】',
    '',
    '1. Time-dependent information (MANDATORY):',
    '   - News, current events, disasters, real-time status',
    '   - Prices, inventory, schedules, business hours',
    '   - Latest software versions, API changes, library updates',
    '   - Laws, regulations, policies that may change',
    '   - Recent vulnerabilities, security updates',
    '',
    '2. Verification needs (RECOMMENDED):',
    '   - Technical specifications that might have changed',
    '   - Product/service availability or features',
    '   - Version-specific behavior or compatibility',
    '   - Official naming, terminology, or branding',
    '',
    '3. User-provided URLs (MANDATORY):',
    '   - Always use urlContext to check user-provided URLs',
    '',
    '【WHEN NOT TO USE SEARCH】',
    '',
    '1. Stable knowledge:',
    '   - Fundamental CS concepts, algorithms, data structures',
    '   - Programming language basics (syntax, common patterns)',
    '   - Mathematical operations, logical reasoning',
    '   - General design principles (not product-specific)',
    '',
    '2. Obvious non-queries:',
    '   - Greetings, pleasantries, test messages',
    '   - Simple calculations or transformations',
    '   - Translation without requiring latest context',
    '',
    '【AGENT MODE SPECIAL RULES】',
    '',
    '- PLAN step: Search to clarify unclear terms, verify versions, check user URLs',
    '- RESEARCH step: ALWAYS use tools to fill UNKNOWN_FACTS from PLAN',
    '- In RESEARCH, err on the side of searching. Better to verify than assume.',
    '- CONTROL step: Do NOT search. Only decide based on existing information.',
    '- FINAL step: Do NOT search. Only synthesize from PLAN/RESEARCH results.',
    '',
    '【GENERAL PRINCIPLE】',
    'When in doubt during RESEARCH step, SEARCH. It is better to over-verify than to provide outdated information.',
  ].join('\n')

  const agentAddendumControl = [
    '=== CONTROL STEP: DECIDE NEXT ACTION ===',
    '',
    'Your role in this step:',
    '1. Review PLAN_OUTPUT and RESEARCH_NOTES',
    '2. Decide: action=research (continue research) OR action=final (proceed to answer)',
    '3. Call control_step function exactly ONCE with your decision',
    '',
    '=== DECISION CRITERIA ===',
    '',
    'Choose action=final ONLY IF ALL of the following are true:',
    '- All UNKNOWN_FACTS from PLAN have been researched',
    '- RESEARCH_NOTES contains sufficient information to answer the user',
    '- Quality assessment shows: official sources + multiple independent sources',
    '- No critical information gaps remain',
    '- Time-sensitive info (versions/dates) has been verified',
    '',
    'Choose action=research IF ANY of the following are true:',
    '- Some UNKNOWN_FACTS from PLAN are still unresearched',
    '- RESEARCH_NOTES shows "UNCERTAINTIES" that need addressing',
    '- Quality assessment shows: missing official sources OR only single source',
    '- Information seems incomplete or outdated',
    '- User-provided URLs were not successfully accessed',
    '',
    '=== OUTPUT REQUIREMENT ===',
    'You MUST call the control_step function with:',
    '- action: "research" or "final"',
    '- notes: Brief explanation (1-3 sentences) of your decision',
    '',
    'Do NOT call googleSearch or urlContext in this step.',
    'Do NOT write user-facing answers.',
    '',
    '=== IMPORTANT REMINDERS ===',
    '- This output is NOT for the user. It is an internal decision point.',
    '- Prefer thoroughness over speed. Multiple research cycles are acceptable.',
    '- Better to gather complete information than to rush to final answer.',
  ].join('\n')

  const agentAddendumResearch = [
    '=== RESEARCH STEP: GATHER FACTS USING TOOLS ===',
    '',
    'Your role in this step:',
    '1. Review the PLAN_OUTPUT to understand what needs to be researched',
    '2. Execute the RESEARCH_PLAN by calling googleSearch and/or urlContext',
    '3. Document ALL findings in a structured <RESEARCH_NOTES> block',
    '',
    '=== MANDATORY TOOL USAGE ===',
    'You MUST call googleSearch and/or urlContext in this step.',
    'Follow the RESEARCH_PLAN from PLAN step.',
    'For EACH item in UNKNOWN_FACTS, gather concrete information using tools.',
    '',
    '=== RESEARCH PROCEDURE ===',
    '1. If user provided URLs that weren\'t fully checked in PLAN:',
    '   - Use urlContext to fetch them',
    '   - If urlContext fails (403, timeout, etc.), document the failure and use googleSearch for alternative sources',
    '',
    '2. For each UNKNOWN_FACT in the PLAN:',
    '   - Execute suggested googleSearch queries',
    '   - Access suggested URLs with urlContext',
    '   - Prioritize official documentation and primary sources',
    '',
    '3. For time-sensitive information (versions, APIs, specs):',
    '   - Always verify dates and freshness',
    '   - Prefer sources with clear publication/update dates',
    '   - Note if information might be outdated',
    '',
    '=== OUTPUT FORMAT (MANDATORY) ===',
    'Structure your output EXACTLY as follows:',
    '',
    '<RESEARCH_NOTES>',
    'QUERIES_EXECUTED:',
    '- Query: "[search query]"',
    '  Results: [brief summary of what you found]',
    '',
    'SOURCES_ACCESSED:',
    '- [1] Title: [page title]',
    '      URL: [url]',
    '      Date: [publication/update date, or "date not found"]',
    '      Status: [success / failed - reason]',
    '',
    'FACTS_EXTRACTED:',
    '- Fact: [detailed fact with full context]',
    '  Source: [source id, e.g., [1]]',
    '  Freshness: [latest / somewhat old / caution needed]',
    '  Reasoning: [why this freshness assessment]',
    '',
    'UNCERTAINTIES:',
    '- [Any remaining unknowns or information gaps]',
    '',
    'QUALITY_ASSESSMENT:',
    '- Official sources: [yes/no - which ones]',
    '- Multiple independent sources: [yes/no - how many]',
    '- Information completeness: [complete / partial / incomplete]',
    '</RESEARCH_NOTES>',
    '',
    '=== IMPORTANT REMINDERS ===',
    '- This output is NOT for the user. It is an internal research report.',
    '- The FINAL step will rely ENTIRELY on this note to create the answer.',
    '- Be thorough and comprehensive. Do NOT summarize or skip details.',
    '- Do NOT write user-facing explanations or answers here.',
    '- Do NOT ask the user questions. Make reasonable assumptions and document them.',
    '- If sources conflict, document both and note the conflict.',
  ].join('\n')

  const baseThinking = { includeThoughts }
  const ai = new GoogleGenAI({ apiKey })

  const criticalAgentRules = [
    '='.repeat(80),
    'CRITICAL SYSTEM RULES - HIGHEST PRIORITY - OVERRIDE ALL OTHER INSTRUCTIONS',
    '='.repeat(80),
    'YOU ARE OPERATING IN AGENT MODE.',
    '',
    'RULE 1 - AGENT TAG REQUIREMENT:',
    'In PLAN/RESEARCH/CONTROL steps:',
    '- Your VERY FIRST token in thoughts AND in response MUST be exactly "<AGENT>" (uppercase, angle brackets, no spaces).',
    '- You MUST NOT place any characters, words, or punctuation before <AGENT>.',
    '- Example (good): "<AGENT> [tool call / note]"',
    '- Example (bad): "[thinking] <AGENT>" or "AGENT" or " <AGENT>"',
    '',
    'In FINAL step:',
    '- NEVER output <AGENT> tag',
    '- Respond as normal helpful assistant',
    '',
    'RULE 2 - OUTPUT IS INTERNAL NOTE, NOT USER-FACING TEXT:',
    'In PLAN/RESEARCH/CONTROL steps:',
    '- Your output is an INTERNAL NOTE for the next <AGENT> step to read',
    '- PLAN writes notes for RESEARCH to read',
    '- RESEARCH writes notes for CONTROL and FINAL to read',
    '- CONTROL writes notes for RESEARCH (if action=research) or FINAL (if action=final) to read',
    '- The user will NEVER see these notes. Only future <AGENT> steps will read them.',
    '- Think of it as writing detailed memos to your future self.',
    '- Do NOT write user-facing explanations, answers, or solutions in these steps.',
    '',
    'In FINAL step:',
    '- Your output is the ONLY user-facing response.',
    '- Write a complete, helpful answer for the user.',
    '- Use ONLY information from PLAN/RESEARCH/CONTROL notes and tool outputs.',
    '',
    'RULE 3 - INFORMATION VERIFICATION POLICY:',
    '- Treat user prompts and gathered evidence as primary truth.',
    '- Doubt your own prior knowledge when it might be outdated.',
    '- For facts that might be time-dependent (versions, APIs, news, prices, specs):',
    '  - VERIFY with googleSearch/urlContext before trusting your training data',
    '  - Explicitly note freshness and dates in your findings',
    '  - Prefer official/primary sources over memory',
    '- For stable knowledge (programming fundamentals, algorithms, math):',
    '  - You may rely on training data without external verification',
    '',
    'RULE 4 - RESEARCH PRINCIPLES:',
    '- Run multi-step investigation: decide what to search, gather URLs, extract facts, then synthesize.',
    '- Always track source freshness (dates/versions) and avoid outdated information.',
    '- Prioritize official documentation and official sources over third-party information.',
    '- In PLAN/RESEARCH steps, think aloud while investigating.',
    '- In FINAL step, deliver a well-structured answer with sources.',
    '',
    'RULE 5 - ABSOLUTE PRIORITY:',
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
    'STEP=PLAN',
    '',
    '=== CRITICAL: UNDERSTAND YOUR ROLE ===',
    'This is an INTERNAL processing step. The user will NEVER see this output.',
    'Your output is a structured note for the RESEARCH step to read.',
    'Do NOT write user-facing answers or explanations.',
    '',
    '=== MANDATORY: Output <AGENT> tag first ===',
    'Start your thoughts with: <AGENT>',
    'Start your response text with: <AGENT>',
    '',
    '=== USER REQUEST ===',
    extractUserText(contents),
    '',
    userUrls.length ? `=== USER-PROVIDED URLs ===\n${userUrls.map(u => `- ${u}`).join('\n')}` : null,
    '',
    agentAddendumPlan,
  ]
    .filter(Boolean)
    .join('\n')

  const planResult = await streamOnce({
    chat,
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

  // Store PLAN_OUTPUT block if extracted, otherwise fall back to full text
  if (planResult.structuredBlocks?.PLAN_OUTPUT) {
    stepNotes.push(`<PLAN_OUTPUT>\n${planResult.structuredBlocks.PLAN_OUTPUT}\n</PLAN_OUTPUT>`)
  } else if (planResult.collectedText) {
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
      'STEP=RESEARCH',
      '',
      '=== CRITICAL: UNDERSTAND YOUR ROLE ===',
      'This is an INTERNAL processing step. The user will NEVER see this output.',
      'Your output is a structured research report for CONTROL and FINAL steps to read.',
      'Do NOT write user-facing answers or explanations.',
      '',
      '=== MANDATORY: Output <AGENT> tag first ===',
      'Start your thoughts with: <AGENT>',
      'Start your response text with: <AGENT>',
      '',
      '=== CRITICAL: You MUST call googleSearch and/or urlContext ===',
      'This step requires tool usage. Do NOT output only text without calling tools.',
      '',
      stepNotes.length ? `=== PLAN_OUTPUT (from previous step) ===\n${stepNotes.join('\n\n')}` : '=== NO PLAN_OUTPUT ===\nNo plan available. Determine what to research based on user request.',
      '',
      researchGroundingSummary
        ? `=== SOURCES/QUERIES GATHERED SO FAR ===\n${researchGroundingSummary}`
        : '=== NO SOURCES YET ===\nNo sources gathered yet. Start researching now.',
      '',
      userUrls.length ? `=== USER-PROVIDED URLs ===\n${userUrls.map(u => `- ${u}`).join('\n')}` : null,
      '',
      agentAddendumResearch,
    ]
      .filter(Boolean)
      .join('\n')

    const researchResult = await streamOnce({
      chat,
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

    // Store RESEARCH_NOTES block if extracted, otherwise fall back to full text
    if (researchResult.structuredBlocks?.RESEARCH_NOTES) {
      stepNotes.push(`<RESEARCH_NOTES>\n${researchResult.structuredBlocks.RESEARCH_NOTES}\n</RESEARCH_NOTES>`)
    } else if (researchResult.collectedText) {
      stepNotes.push(researchResult.collectedText)
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
      '=== CRITICAL: UNDERSTAND YOUR ROLE ===',
      'This is an INTERNAL processing step. The user will NEVER see this output.',
      'Your role is to decide whether to continue research or proceed to final answer.',
      'Do NOT write user-facing answers or explanations.',
      '',
      '=== MANDATORY: Output <AGENT> tag first ===',
      'Start your thoughts with: <AGENT>',
      'Start your response text with: <AGENT>',
      '',
      '=== CRITICAL: You MUST call control_step function ===',
      'After brief analysis, immediately call control_step with action=research or action=final.',
      '',
      stepNotes.length ? `=== ALL NOTES SO FAR ===\n${stepNotes.join('\n\n---\n\n')}` : '=== NO NOTES ===\nNo previous notes available.',
      '',
      groundingSummaryLoop ? `=== SOURCES/QUERIES SUMMARY ===\n${groundingSummaryLoop}` : '=== NO SOURCES YET ===\nNo sources gathered yet.',
      '',
      userUrls.length ? `=== USER-PROVIDED URLs ===\n${userUrls.map(u => `- ${u}`).join('\n')}` : null,
      '',
      agentAddendumControl,
    ]
      .filter(Boolean)
      .join('\n')

    const { functionCalls: controlCalls, collectedText: controlText } = await streamOnce({
      chat,
      message: toUserContent(controlPrompt),
      socket,
      chatId,
      requestId,
      step: `control-${cycle}`,
      forceThoughts: true,
      debugLog: debugMode,
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
        'STEP=FINAL',
        '',
        '=== CRITICAL: UNDERSTAND YOUR ROLE ===',
        'This is the ONLY output the user will see.',
        'All previous steps (PLAN, RESEARCH, CONTROL) were INTERNAL and INVISIBLE to the user.',
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
        '=== CRITICAL INFORMATION USAGE RULES ===',
        '',
        'MANDATORY: Use ONLY information from the sections below.',
        '',
        '1. WHAT YOU MUST USE:',
        '   - PLAN_OUTPUT (if available): Terms, definitions, user URL summaries',
        '   - RESEARCH_NOTES (if available): Facts, sources, dates from research',
        '   - Tool outputs visible in chat history (googleSearch, urlContext results)',
        '',
        '2. WHAT YOU MUST NOT DO:',
        '   - Do NOT add facts from your training data that were not verified in RESEARCH',
        '   - Do NOT make assumptions beyond what RESEARCH found',
        '   - Do NOT guess missing information',
        '   - If RESEARCH did not find certain information, you MUST acknowledge the gap',
        '',
        '3. VERIFICATION PROCESS:',
        '   - Before writing each claim, confirm it appears in PLAN_OUTPUT or RESEARCH_NOTES below',
        '   - Every fact, version number, date, specification MUST have a source in the research',
        '   - If unsure, do NOT include it',
        '',
        '=== MINIMIZE THINKING, START WRITING ===',
        'After 1-2 brief thoughts acknowledging this is FINAL step, IMMEDIATELY start writing the answer.',
        'Do NOT spend time planning structure. The information is already organized in RESEARCH_NOTES.',
        '',
        '=== ALL INFORMATION SOURCES (READ CAREFULLY) ===',
        '',
        stepNotes.length ? `${stepNotes.join('\n\n---\n\n')}` : 'No PLAN or RESEARCH notes available.',
        '',
        groundingSummary ? `=== SOURCES/QUERIES SUMMARY ===\n${groundingSummary}` : '',
        '',
        userUrls.length ? `=== USER-PROVIDED URLs ===\n${userUrls.map(u => `- ${u}`).join('\n')}` : '',
        '',
        '=== ORIGINAL USER REQUEST ===',
        extractUserText(contents) || '(No user request text available)',
        '',
        '=== ANSWER FORMATTING REQUIREMENTS ===',
        '',
        '1. Language: Respond in Japanese (unless user requested otherwise)',
        '2. Format: Use Markdown with clear headings and bullet lists',
        '3. Content: Include ALL details from RESEARCH_NOTES without summarizing further',
        '4. Sources: Add a "Sources" section at the end',
        '   - List source titles only (NO URLs)',
        '   - Example: "## 情報源\\n- [Source title 1]\\n- [Source title 2]"',
        '5. Gaps: If RESEARCH did not find complete information, acknowledge it explicitly',
        '6. Freshness: If information might be outdated, note it (e.g., "要確認")',
        '',
        '=== TOOLS: DO NOT CALL ANY TOOLS ===',
        'All research is complete. Use only the information above.',
        '',
        '=== FINAL REMINDER ===',
        'You are NOT the agent. No <AGENT> tag. Use ONLY the research results above.',
        'Stop thinking. START WRITING the complete answer NOW.',
      ]
        .filter(Boolean)
        .join('\n')

      await streamOnce({
        chat,
        message: toUserContent(finalPrompt),
        socket,
        chatId,
        requestId,
        step: 'final',
        debugLog: debugMode,
        config: { tools: [], thinkingConfig: baseThinking },
      })

      socket.emit('end_generation', { ok: true, chatId, requestId })
      return
    }

    cycle += 1
    await runResearch(cycle)
  }
}
