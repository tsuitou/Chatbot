import { GoogleGenAI } from '@google/genai'

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

  // Detect step transition and add newline
  const isStepTransition = lastEmittedStep !== null && lastEmittedStep !== step

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
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
    '=== AGENT WORKFLOW ===',
    '',
    'You operate in 5 steps within a single chat session:',
    '1. CLARIFY: Verify current names and versions of all mentioned technologies',
    '2. PLAN: Identify unknowns, check user URLs, create research plan',
    '3. RESEARCH: Execute research plan with tools, document findings',
    '4. CONTROL: Decide if research is complete or needs continuation',
    '5. FINAL: Synthesize all findings into user-facing answer',
    '',
    'Context continuity:',
    '- Each step receives structured notes from previous steps',
    '- CLARIFY creates verified terminology glossary for PLAN',
    '- PLAN creates research strategy for RESEARCH',
    '- RESEARCH creates factual notes for CONTROL and FINAL',
    '- CONTROL decides whether to loop back to RESEARCH or proceed to FINAL',
    '- All tool outputs remain in chat history via Thought Signature',
    '',
    'Step-specific prompts you receive are operational instructions to guide that step.',
    'The original user question remains constant throughout all steps.',
    'Never write user-facing answers in CLARIFY/PLAN/RESEARCH/CONTROL - those are internal notes only.',
    'All comprehensive answers must wait for the FINAL step.',
  ].join('\n')

  const urlOutputPolicy = [
    '=== URL OUTPUT POLICY ===',
    'You have access to source URLs and search results in context.',
    'DO NOT output any URLs in your response text.',
    'Refer to sources by title or number only (e.g., "Official Documentation", "Source [1]").',
    'URLs are for your internal reference, not for output.',
  ].join('\n')

  const agentAddendumClarify = [
    '=== CLARIFY STEP: VERIFY CURRENT TERMINOLOGY ===',
    '',
    'Your role in this step:',
    '1. Extract ALL technology/library/API/tool names mentioned in user request',
    '2. For EACH name, verify the current official name and latest version',
    '3. Use googleSearch to confirm current state (NOT your training data)',
    '4. Output a concise glossary of verified terms',
    '',
    'CRITICAL: This step is ONLY about terminology verification.',
    'Do NOT plan research strategy. Do NOT analyze implementation details.',
    'Just verify: "What is this called now? What\'s the latest version?"',
    '',
    urlOutputPolicy,
    '',
    '=== EXTRACTION: IDENTIFY ALL TERMS ===',
    '',
    'Extract from user request:',
    '- Programming languages (e.g., "Python", "JavaScript", "Node.js")',
    '- Frameworks/Libraries (e.g., "React", "Next.js", "Express")',
    '- APIs/Services (e.g., "Gemini API", "OpenAI API")',
    '- Tools/Platforms (e.g., "npm", "Docker", "Vercel")',
    '- Models (e.g., "GPT-4", "Gemini 2.0")',
    '- Any proper noun that might have versions or alternatives',
    '',
    '=== VERIFICATION: CHECK EACH TERM ===',
    '',
    'For EACH extracted term, use googleSearch to verify:',
    '',
    '1. Official current name',
    '   - Search: "[term] official name" or "[term] current version"',
    '   - Check if it\'s been renamed, deprecated, or replaced',
    '   - Example: "Nano Banana" might actually be "Gemini SDK"',
    '',
    '2. Latest stable version',
    '   - Search: "[verified name] latest version" or "[verified name] current stable"',
    '   - Get the actual version number and release date',
    '   - Example: "React latest version" → "React 19.0.0 (December 2024)"',
    '',
    '3. Quick reality check',
    '   - Does this technology actually exist?',
    '   - Is it still actively maintained?',
    '   - Any major breaking changes recently?',
    '',
    'Search strategy:',
    '- Keep queries simple and direct',
    '- Prioritize official sources (official sites, GitHub releases, npm registry)',
    '- If not found, try alternative spellings or search for "what is [term]"',
    '',
    '=== OUTPUT FORMAT (MANDATORY - USE STRUCTURED TAGS) ===',
    '',
    'ALL your response text MUST be enclosed in <CLARIFY_OUTPUT></CLARIFY_OUTPUT> tags.',
    'NO text should appear outside these tags.',
    '',
    'Required structure:',
    '',
    '<CLARIFY_OUTPUT>',
    'VERIFIED_TERMS:',
    '- [Original term from user]: [Official current name]',
    '  Latest version: [X.Y.Z (release date)]',
    '  Status: [active / deprecated / replaced by X]',
    '  Official source: [e.g., "Official docs", "npm registry", "GitHub releases"]',
    '',
    '(Repeat for each term extracted)',
    '',
    'CORRECTIONS:',
    '- [If user term was incorrect]: [Original] → [Corrected name]',
    '  Reason: [e.g., "Typo", "Old name", "Alias"]',
    '',
    '(Only include if corrections were needed, otherwise write "None")',
    '',
    'NOTES:',
    '- [Any important observations about terminology or versions]',
    '- [Any deprecations or major changes to be aware of]',
    '',
    '(Brief notes only - 1-3 items maximum)',
    '</CLARIFY_OUTPUT>',
    '',
    '=== CRITICAL REMINDERS ===',
    '- This is a LIGHTWEIGHT step - keep it fast and focused',
    '- Do NOT create research plans here - that\'s PLAN step\'s job',
    '- Do NOT fetch detailed documentation - just verify names and versions',
    '- Do NOT analyze user requirements - just verify terminology',
    '- Use googleSearch ONLY for terminology verification',
    '- Output goes to PLAN step, not to user',
    '',
    '=== EXAMPLE ===',
    '',
    'User request: "How to use Nano Banana with Nxt.js 15?"',
    '',
    'Your searches:',
    '1. "Nano Banana official name" → discover it\'s actually "Google Generative AI SDK"',
    '2. "Google Generative AI SDK latest version" → "v0.21.0 (Jan 2025)"',
    '3. "Nxt.js" → no results → try "Next.js" → "Next.js 15.1.0 (Dec 2024)"',
    '',
    'Your output:',
    '<CLARIFY_OUTPUT>',
    'VERIFIED_TERMS:',
    '- Nano Banana: Google Generative AI SDK (@google/generative-ai)',
    '  Latest version: 0.21.0 (January 2025)',
    '  Status: active',
    '  Official source: npm registry, Google AI docs',
    '',
    '- Nxt.js: Next.js',
    '  Latest version: 15.1.0 (December 2024)',
    '  Status: active',
    '  Official source: Next.js official site',
    '',
    'CORRECTIONS:',
    '- Nano Banana → Google Generative AI SDK (user used informal/internal name)',
    '- Nxt.js → Next.js (typo)',
    '',
    'NOTES:',
    '- Next.js 15 is the latest major version',
    '- Google Generative AI SDK has frequent updates, version checked Jan 2025',
    '</CLARIFY_OUTPUT>',
  ].join('\n')

  const agentAddendumPlan = [
    '=== PLAN STEP: IDENTIFY WHAT IS UNKNOWN ===',
    '',
    'Your role in this step:',
    '1. Review CLARIFY_OUTPUT to understand verified terminology and versions',
    '2. Check user-provided URLs if any (MANDATORY)',
    '3. Identify what facts are still UNKNOWN after terminology verification',
    '4. Create a detailed research plan for the RESEARCH step',
    '',
    'IMPORTANT: The CLARIFY step has already verified all technology names and versions.',
    'Use that verified information. Do NOT re-verify terminology.',
    'Focus on understanding WHAT the user wants to do with those technologies.',
    '',
    urlOutputPolicy,
    '',
    '=== PHASE 1: REVIEW CLARIFY_OUTPUT ===',
    '',
    'The CLARIFY step has already verified all technology names and their current versions.',
    'Review CLARIFY_OUTPUT to understand:',
    '- Verified official names (if user used informal names or typos)',
    '- Current stable versions with release dates',
    '- Any deprecations or replacements',
    '- Corrections made to user terminology',
    '',
    'Use this verified information as the foundation for your research plan.',
    'Do NOT re-search for technology names or versions already verified in CLARIFY_OUTPUT.',
    '',
    '=== PHASE 1.5: VERSION HANDLING ===',
    '',
    'CLARIFY_OUTPUT provides the latest versions.',
    'If user explicitly specified a different version:',
    '- Honor their specified version',
    '- Note the difference between their version and latest',
    '- Plan research for their specific version',
    '',
    'If user did NOT specify a version:',
    '- Use the latest version from CLARIFY_OUTPUT',
    '- Document this assumption in CONTEXT_INFERENCE',
    '',
    '=== PHASE 2: USER URL INSPECTION ===',
    '',
    'If user provided URLs in their request:',
    '- Use urlContext tool to access EACH URL',
    '- Document what each URL is about (page title, main topic, key info)',
    '- Note any access failures (403 Forbidden, 404 Not Found, timeout, etc.)',
    '- Failed URLs should be handled in RESEARCH step via alternative searches',
    '',
    'Example USER_URL_SUMMARY:',
    '- Source [1]: Official API reference for Gemini 2.0 - describes model parameters',
    '- Source [2]: Failed to fetch (403 Forbidden) - will search for alternative source',
    '',
    '=== PHASE 3: CONTEXT INFERENCE ===',
    '',
    'Objective: Infer implicit technical context from the user request to enhance search quality.',
    '',
    'Platform/Language inference (when not explicitly stated):',
    '- Mentions "npm", "package.json", "import" → likely Node.js/JavaScript',
    '- Mentions "pip", "__init__.py" → likely Python',
    '- Mentions "cargo", "Cargo.toml" → likely Rust',
    '- Mentions "gem", "Gemfile" → likely Ruby',
    '',
    'Version inference for common platforms:',
    '- "Node.js" without version → search for current LTS version',
    '- "Python" without version → assume Python 3.x, search for latest',
    '- "React" without version → search for current stable',
    '',
    'Search query enhancement strategy:',
    '- BAD (too vague): "library X usage"',
    '- GOOD (with context): "library X Node.js v22 usage example"',
    '- BAD (no platform): "image generation API"',
    '- GOOD (with platform): "Gemini API Node.js image generation example"',
    '',
    'Document in CONTEXT_INFERENCE:',
    '- Platform/Language: [inferred platform with version if determined]',
    '- Target Goal: [what user wants to achieve]',
    '- Key Assumptions: [any assumptions made about environment]',
    '',
    '=== PHASE 4: UNKNOWN FACTS IDENTIFICATION ===',
    '',
    'After completing entity resolution, URL checks, and context inference, identify what facts are STILL unknown:',
    '',
    'Categories of unknown facts:',
    '- Specific feature details: "Does X support Y feature?"',
    '- Implementation details: "How to implement Z with X?"',
    '- Code examples: "Syntax for calling X API"',
    '- Compatibility: "Does X work with Y version?"',
    '- Comparisons: "X vs Y for use case Z"',
    '- Availability: "Is X feature available in version Y?"',
    '- Best practices: "Recommended approach for X"',
    '',
    '=== PHASE 5: RESEARCH PLAN CREATION ===',
    '',
    'For EACH unknown fact identified, create a specific research action:',
    '',
    'Specify:',
    '1. What needs to be found',
    '2. Which tool to use (googleSearch or urlContext)',
    '3. Exact search query or URL to use',
    '4. Why this query will find the information',
    '',
    'Search query construction guidelines:',
    '- Include resolved entity name (not original ambiguous term)',
    '- Include platform/language context',
    '- Include version if known',
    '- Use specific intent keywords: "tutorial", "example", "documentation", "how to"',
    '',
    'Examples of good research plans:',
    '- For "How to generate images": googleSearch "Gemini 2.0 API Node.js image generation example code"',
    '- For "Supported formats": googleSearch "Gemini API supported image formats official documentation"',
    '- For "Authentication": urlContext for source [1] (official API reference)',
    '',
    '=== OUTPUT FORMAT (MANDATORY - USE STRUCTURED TAGS) ===',
    '',
    'ALL your response text MUST be enclosed in <PLAN_OUTPUT></PLAN_OUTPUT> tags.',
    'NO text should appear outside these tags in your response output.',
    '',
    'Required structure:',
    '',
    '<PLAN_OUTPUT>',
    'VERIFIED_TECHNOLOGIES:',
    '(From CLARIFY_OUTPUT - do not repeat full details, just reference)',
    '- [Technology 1]: [version from CLARIFY_OUTPUT]',
    '- [Technology 2]: [version from CLARIFY_OUTPUT]',
    '(If user specified different version, note: "User wants v[X], latest is v[Y]")',
    '',
    'CONTEXT_INFERENCE:',
    '- Platform/Language: [e.g., Node.js v22.x (inferred from npm mention)]',
    '- Target Goal: [e.g., Generate images using official Gemini API in Node.js application]',
    '- Key Assumptions: [e.g., User wants latest stable version, ESM module syntax]',
    '',
    'GLOSSARY:',
    '- [Technology/Library name]: [Verified meaning]',
    '  Version: [Latest version X.Y.Z, released [date]]',
    '  Official source: [source number if found]',
    '(Repeat for each technology mentioned)',
    '',
    'USER_URL_SUMMARY:',
    '- Source [1]: [Page title/description]',
    '  Content: [Key information found or "Failed to access - [reason]"]',
    '(Repeat for each user-provided URL)',
    '',
    'UNKNOWN_FACTS:',
    '- [Specific unknown fact 1]',
    '- [Specific unknown fact 2]',
    '- [Specific unknown fact 3]',
    '(Be specific: not "how to use X" but "syntax for calling X.generate() method")',
    '',
    'RESEARCH_PLAN:',
    '- For [unknown fact 1]: googleSearch "[context-enhanced query with platform/version]"',
    '  Rationale: [why this query will find the needed information]',
    '- For [unknown fact 2]: urlContext for source [#]',
    '  Rationale: [what information is expected from this source]',
    '(Repeat for each unknown fact)',
    '</PLAN_OUTPUT>',
    '',
    '=== CRITICAL REMINDERS ===',
    '- This output is NOT for the user - it is an internal note for RESEARCH step',
    '- Do NOT write user-facing answers or explanations here',
    '- Do NOT make predictions about what the final answer will be',
    '- Focus on: what we verified (GLOSSARY), what we checked (USER_URL_SUMMARY), what we don\'t know (UNKNOWN_FACTS), how to find it (RESEARCH_PLAN)',
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
    '【INTELLIGENT QUERY CONSTRUCTION】',
    '',
    '1. DO NOT SEARCH BLINDLY:',
    '   - Bad: "Nano Banana" (too vague, no context)',
    '   - Good: "Nano Banana library what is" (clarification intent)',
    '   - Good: "google gemini api nodejs image generation example" (specific with context)',
    '   - NOTE: These are example patterns, not actual current information',
    '',
    '2. ALWAYS INCLUDE CONTEXT:',
    '   - Add platform/language: "X library Node.js" not just "X library"',
    '   - Add version when known: "React 19 new features" not "React features"',
    '   - Add intent: "X official documentation" or "X tutorial example"',
    '   - NOTE: Version numbers in examples may be outdated - search for current versions',
    '',
    '3. HANDLING ZERO RESULTS:',
    '   - Assume the term might be:',
    '     a) A brand new release (search with "latest" or current year)',
    '     b) A misspelling (search "did you mean X")',
    '     c) An internal codename or alias (search "X codename" or "X alternative name")',
    '     d) Deprecated/replaced (search "X deprecated alternative")',
    '',
    '【AGENT MODE SPECIAL RULES】',
    '',
    '- PLAN step: Search to RESOLVE entity identity, verify versions, check user URLs',
    '- RESEARCH step: ALWAYS use tools to fill UNKNOWN_FACTS from PLAN',
    '- In RESEARCH, err on the side of searching. Better to verify than assume.',
    '- In RESEARCH, if a search fails, PIVOT to alternative queries immediately.',
    '- CONTROL step: Do NOT search. Only decide based on existing information.',
    '- FINAL step: Do NOT search. Only synthesize from PLAN/RESEARCH results.',
    '',
    '【GENERAL PRINCIPLE】',
    'When in doubt during RESEARCH step, SEARCH. It is better to over-verify than to provide outdated information.',
    'Never assume a library/tool exists just because the user named it. Verify existence first in PLAN.',
  ].join('\n')

  const agentAddendumControl = [
    '=== CONTROL STEP: DECIDE NEXT ACTION ===',
    '',
    'Your role in this step:',
    '1. Review PLAN_OUTPUT to understand what was originally needed',
    '2. Review RESEARCH_NOTES to assess what has been found',
    '3. Decide: action=research (continue research) OR action=final (proceed to answer)',
    '4. Call control_step function exactly ONCE with your decision',
    '',
    urlOutputPolicy,
    '',
    '=== DECISION CRITERIA ===',
    '',
    'Choose action=final ONLY IF ALL of the following are true:',
    '',
    '✓ Coverage:',
    '- All UNKNOWN_FACTS from PLAN have been researched',
    '- RESEARCH_NOTES contains sufficient information to answer the user comprehensively',
    '- No critical information gaps remain',
    '',
    '✓ Quality:',
    '- Official sources have been found and accessed',
    '- Multiple independent sources confirm key facts (when possible)',
    '- Information freshness has been verified for time-sensitive topics',
    '',
    '✓ Confidence:',
    '- QUALITY_ASSESSMENT in RESEARCH_NOTES shows "complete" or "partial" (not "incomplete")',
    '- Confidence level is "high" or "medium" (not "low")',
    '- UNCERTAINTIES section is empty or contains only minor unknowns',
    '',
    'Choose action=research IF ANY of the following are true:',
    '',
    '✗ Coverage gaps:',
    '- Some UNKNOWN_FACTS from PLAN are still unresearched',
    '- RESEARCH_NOTES shows "UNCERTAINTIES" that need addressing',
    '- Critical information is missing that would prevent a good answer',
    '',
    '✗ Quality issues:',
    '- Missing official sources - only third-party or community sources found',
    '- Only single source for critical claims (need corroboration)',
    '- Information seems incomplete or contradictory',
    '',
    '✗ Reliability concerns:',
    '- Time-sensitive information (versions/dates) has not been verified',
    '- User-provided URLs were not successfully accessed',
    '- QUALITY_ASSESSMENT shows "incomplete" or confidence is "low"',
    '',
    '=== DECISION PROCESS ===',
    '',
    'Step 1: Review coverage',
    '- Compare UNKNOWN_FACTS from PLAN with FACTS_EXTRACTED in RESEARCH_NOTES',
    '- Check if each unknown has been addressed',
    '- Note any gaps',
    '',
    'Step 2: Assess quality',
    '- Review SOURCES_ACCESSED - are there official sources?',
    '- Review QUALITY_ASSESSMENT - what does it recommend?',
    '- Check UNCERTAINTIES - are they minor or critical?',
    '',
    'Step 3: Make decision',
    '- If all coverage + quality + confidence criteria met → action=final',
    '- If any gaps or quality issues → action=research',
    '- When in doubt, prefer thoroughness: choose research',
    '',
    '=== OUTPUT FORMAT (MANDATORY - USE STRUCTURED TAGS) ===',
    '',
    'ALL your response text MUST be enclosed in <CONTROL_DECISION></CONTROL_DECISION> tags.',
    'NO text should appear outside these tags in your response output (except tool calls).',
    '',
    'Required structure:',
    '',
    '<CONTROL_DECISION>',
    'COVERAGE ANALYSIS:',
    '- UNKNOWN_FACTS from PLAN: [count]',
    '- Addressed in RESEARCH: [count / list which ones]',
    '- Remaining gaps: [list any unaddressed items, or "None"]',
    '',
    'QUALITY ANALYSIS:',
    '- Official sources: [yes/no - which ones]',
    '- Multiple sources: [yes/no - count]',
    '- Information freshness: [verified / needs verification / N/A]',
    '- Overall quality: [excellent / good / adequate / insufficient]',
    '',
    'CONFIDENCE ANALYSIS:',
    '- QUALITY_ASSESSMENT says: [what it says]',
    '- UNCERTAINTIES remaining: [list or "None"]',
    '- Confidence to answer user: [high / medium / low]',
    '',
    'DECISION:',
    'Action: [research / final]',
    'Reasoning: [1-3 sentences explaining why this decision]',
    '',
    'If action=research, what to research next:',
    '- [Specific gap 1 to address]',
    '- [Specific gap 2 to address]',
    '</CONTROL_DECISION>',
    '',
    'Then immediately call control_step function with:',
    '- action: "research" or "final"',
    '- notes: Your reasoning from above',
    '',
    '=== IMPORTANT CONSTRAINTS ===',
    '- Do NOT call googleSearch or urlContext in this step',
    '- Do NOT write user-facing answers',
    '- Do NOT output URLs',
    '',
    '=== PHILOSOPHY ===',
    '- Prefer thoroughness over speed',
    '- Multiple research cycles are ACCEPTABLE and ENCOURAGED',
    '- It is better to gather complete information than to rush to a final answer',
    '- The user expects a high-quality, well-researched answer',
    '- An extra research cycle now saves correction cycles later',
  ].join('\n')

  const agentAddendumResearch = [
    '=== RESEARCH STEP: GATHER FACTS USING TOOLS ===',
    '',
    'Your role in this step:',
    '1. Review the PLAN_OUTPUT to understand what needs to be researched',
    '2. Execute the RESEARCH_PLAN by calling googleSearch and/or urlContext',
    '3. Document ALL findings in a structured and comprehensive <RESEARCH_NOTES> block',
    '',
    urlOutputPolicy,
    '',
    '=== MANDATORY TOOL USAGE ===',
    '',
    'You MUST call googleSearch and/or urlContext in this step.',
    'Follow the RESEARCH_PLAN from PLAN step.',
    'For EACH item in UNKNOWN_FACTS, gather concrete information using tools.',
    '',
    '=== ADAPTIVE RESEARCH RULES ===',
    '',
    'If a search fails (zero results, irrelevant results, 404, timeout):',
    '',
    '1. DO NOT give up immediately',
    '2. PIVOT your approach using these strategies:',
    '',
    'Strategy A: Broader query',
    '- Failed: "Nano Banana SDK usage example"',
    '- Pivot: "Nano Banana SDK" or "Nano Banana documentation"',
    '',
    'Strategy B: Check for typos or alternative spellings',
    '- Failed: "Nxt.js server actions"',
    '- Pivot: "Next.js server actions" (corrected spelling)',
    '',
    'Strategy C: Search for what replaced it',
    '- Failed: "LibraryX API"',
    '- Pivot: "LibraryX deprecated alternative" or "what replaced LibraryX"',
    '',
    'Strategy D: Different language',
    '- Failed: "ライブラリX 使い方"',
    '- Pivot: "Library X tutorial" (try English)',
    '',
    'Strategy E: Search for the concept instead of specific term',
    '- Failed: "SpecificTool feature Y"',
    '- Pivot: "how to achieve Y in [platform]" (general approach)',
    '',
    '3. Document ALL pivots in QUERIES_EXECUTED',
    '',
    'Example documentation:',
    '- Query: "Nano Banana SDK Node.js"',
    '  Results: Zero results',
    '  Pivot: Searched "Nano Banana" → discovered it\'s actually called "Gemini SDK"',
    '  Final query: "Gemini SDK Node.js documentation"',
    '  Results: Found official documentation',
    '',
    '=== RESEARCH PROCEDURE ===',
    '',
    'Step 1: Handle user-provided URLs',
    '- If user provided URLs that weren\'t fully checked in PLAN step',
    '- Use urlContext to fetch them',
    '- If urlContext fails (403, timeout, etc.):',
    '  * Document the failure',
    '  * Use googleSearch to find alternative sources covering the same topic',
    '',
    'Step 2: Execute RESEARCH_PLAN for each UNKNOWN_FACT',
    '- Follow the queries suggested in PLAN',
    '- Enhance queries with context from PLAN (platform, version, etc.)',
    '- PRIORITIZE OFFICIAL DOCUMENTATION over third-party tutorials',
    '- When searching for code examples, verify:',
    '  * Import/package name matches the verified entity',
    '  * Syntax style matches the platform (ESM vs CommonJS, etc.)',
    '  * Version matches what was identified in PLAN',
    '',
    'Step 3: Verify freshness for time-sensitive information',
    '- For versions, APIs, specifications:',
    '  * Always check publication/update dates',
    '  * Prefer sources with clear date information',
    '  * Note if information might be outdated',
    '',
    'Step 4: Source evaluation',
    '- Hierarchy of trust:',
    '  1. Official documentation from the project/company',
    '  2. Official blog posts or release notes',
    '  3. Well-known tech sites (MDN, Stack Overflow accepted answers)',
    '  4. Recent blog posts from reputable sources',
    '  5. General tutorials or forums',
    '',
    '- If conflicting information appears:',
    '  * Note the conflict explicitly',
    '  * Prefer official sources',
    '  * Document both perspectives with source attribution',
    '',
    'Step 5: Version-specific research',
    '- Focus on LATEST/NEWEST version (as determined in PLAN) unless user specified otherwise',
    '- When gathering version-specific information:',
    '  * Primary focus: Latest stable version documentation and features',
    '  * Secondary: Note breaking changes from previous major versions (if relevant to understanding)',
    '  * Tertiary: Mention legacy versions only if they\'re still widely used',
    '- Document version numbers EXPLICITLY in all facts',
    '- If multiple versions mentioned in sources, clearly mark which is latest',
    '',
    '=== OUTPUT FORMAT (MANDATORY - USE STRUCTURED TAGS) ===',
    '',
    'ALL your response text MUST be enclosed in <RESEARCH_NOTES></RESEARCH_NOTES> tags.',
    'NO text should appear outside these tags in your response output.',
    '',
    'Required structure:',
    '',
    '<RESEARCH_NOTES>',
    'QUERIES_EXECUTED:',
    '- Query: "[exact search query used]"',
    '  Results: [brief summary of what you found - NO URLs in summary]',
    '  Pivots: [if query failed, what alternative approaches did you try?]',
    '  Outcome: [success / partial / failed]',
    '(Repeat for each query executed)',
    '',
    'ENTITY_DETAILS:',
    '- Target Technology: [Correct name and version identified]',
    '- Package/Tool Name: [e.g., npm package "@scope/name", pip package "name"]',
    '- Official Documentation: Source [#] (reference to SOURCES_ACCESSED below)',
    '- Key Metadata: [Language, platform, license, etc. if relevant]',
    '',
    'SOURCES_ACCESSED:',
    '- [1] Title: [Full page/article title]',
    '      Date: [Publication or last-update date, or "date not found"]',
    '      Type: [official docs / blog post / tutorial / forum / etc.]',
    '      Status: [successfully accessed / failed - reason]',
    '      Authority: [official / reputable / community / unknown]',
    '- [2] Title: ...',
    '(Number sources sequentially for easy reference)',
    '',
    'FACTS_EXTRACTED:',
    '- Fact: [Detailed fact with full technical context - be specific and comprehensive]',
    '  Source: [1] (reference to source number above)',
    '  Freshness: [latest / somewhat dated / outdated / caution needed]',
    '  Freshness reasoning: [Why this assessment - e.g., "published Dec 2024, matches current version"]',
    '  Confidence: [high / medium / low]',
    '  Additional context: [Any nuances, limitations, or caveats]',
    '(Repeat for each fact - err on the side of MORE facts rather than fewer)',
    '',
    'UNCERTAINTIES:',
    '- [Any remaining unknowns or information gaps after research]',
    '- [Questions that couldn\'t be fully answered]',
    '- [Conflicting information that couldn\'t be resolved]',
    '(If no uncertainties, write "None - all UNKNOWN_FACTS from PLAN have been addressed")',
    '',
    'QUALITY_ASSESSMENT:',
    '- Official sources found: [yes/no - list source numbers]',
    '- Multiple independent sources: [yes/no - count and list source numbers]',
    '- Information completeness: [complete / partial / incomplete]',
    '- Completeness reasoning: [Why this assessment]',
    '- Confidence in findings: [high / medium / low]',
    '- Recommended action: [proceed to final / need more research]',
    '</RESEARCH_NOTES>',
    '',
    '=== CRITICAL REMINDERS ===',
    '- ALL your response text MUST be inside <RESEARCH_NOTES></RESEARCH_NOTES> tags',
    '- This output is NOT for the user - it is an internal research report',
    '- The FINAL step will rely ENTIRELY on this note to create the answer',
    '- Be thorough and comprehensive - do NOT summarize or skip details',
    '- Include ALL facts you discovered, not just a subset',
    '- Do NOT write user-facing explanations or answers here',
    '- Do NOT ask the user questions - make reasonable assumptions and document them',
    '- If sources conflict, document BOTH perspectives with attribution',
  ].join('\n')

  const baseThinking = { includeThoughts }
  const ai = new GoogleGenAI({ apiKey })

  // Build system instruction based on step type
  const buildSystemInstruction = (stepType) => {
    const base = [
      defaultSystemInstruction
        ? `${'='.repeat(80)}\nBASE SYSTEM INSTRUCTION\n${'='.repeat(80)}\n\n${defaultSystemInstruction}`
        : null,
      userSystemInstruction
        ? `${'='.repeat(80)}\nUSER-SPECIFIED INSTRUCTION\n${'='.repeat(80)}\n\n${userSystemInstruction}`
        : null,
    ].filter(Boolean)

    if (stepType === 'final') {
      // FINAL step: no agent rules, just persona
      return [
        ...base,
        '',
        `${'='.repeat(80)}\nAGENT PERSONA AND CAPABILITIES\n${'='.repeat(80)}\n\n${agentPersonaInstruction}`,
      ]
        .filter(Boolean)
        .join('\n')
    }

    // PLAN/RESEARCH/CONTROL steps: include critical agent rules
    return [
      criticalAgentRules,
      '',
      ...base,
      '',
      `${'='.repeat(80)}\nAGENT PERSONA AND CAPABILITIES\n${'='.repeat(80)}\n\n${agentPersonaInstruction}`,
      '',
      `${'='.repeat(80)}\nSEARCH POLICY\n${'='.repeat(80)}\n\n${searchPolicyInstruction}`,
      '',
      `${'='.repeat(80)}\nAGENT WORKFLOW\n${'='.repeat(80)}\n\n${flowInstruction}`,
    ]
      .filter(Boolean)
      .join('\n')
  }

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

  // Note: We'll create step-specific chats with appropriate system instructions
  // Initial chat for PLAN/RESEARCH/CONTROL uses agent mode system
  const chat = ai.chats.create({
    model: baseModel,
    config: {
      systemInstruction: buildSystemInstruction('agent'),
      thinkingConfig: baseThinking,
    },
    history: historyForChat,
  })

  const groundingAcc = { sources: new Map(), queries: new Set() }
  let stepNotes = []
  let consecutiveResearch = 0
  const MAX_CONSECUTIVE_RESEARCH = 3

  // Get current date for context
  const currentDate = new Date().toISOString().split('T')[0] // YYYY-MM-DD format

  // --- Clarify stage (always once) - verify terminology first ---
  const clarifyPrompt = [
    'STEP=CLARIFY',
    '',
    `=== CURRENT DATE ===`,
    `Today's date: ${currentDate}`,
    'Use this date to determine what "latest" or "current" means.',
    'Search results should be evaluated based on this date.',
    '',
    '=== CRITICAL: UNDERSTAND YOUR ROLE ===',
    'This is a LIGHTWEIGHT terminology verification step.',
    'The user will NEVER see this output.',
    'Your output is a concise glossary for the PLAN step to use.',
    'Do NOT create research plans or analyze requirements.',
    '',
    '=== MANDATORY: Output <AGENT> tag first ===',
    'Start your thoughts with: <AGENT>',
    'Start your response text with: <AGENT>',
    '',
    '=== USER REQUEST ===',
    extractUserText(contents),
    '',
    agentAddendumClarify,
    '',
    '=== BEGIN OUTPUT ===',
    '',
  ]
    .filter(Boolean)
    .join('\n')

  const clarifyResult = await streamOnce({
    chat,
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
      tools: [{ googleSearch: {} }],
      thinkingConfig: baseThinking,
    },
  })
  accumulateFromCalls(groundingAcc, clarifyResult.functionCalls)

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

  // Format grounding summary from CLARIFY for PLAN
  const clarifyGroundingSummary = formatGroundingSummary(groundingAcc, {
    maxSources: 20,
    maxQueries: 20,
  })

  // --- Plan stage (always once) ---
  const planPrompt = [
    'STEP=PLAN',
    '',
    `=== CURRENT DATE ===`,
    `Today's date: ${currentDate}`,
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
    stepNotes.length
      ? `=== CLARIFY_OUTPUT (from previous step) ===\n\n${stepNotes.join('\n\n---\n\n')}\n`
      : '=== NO CLARIFY_OUTPUT ===\nNo terminology verification available.',
    '',
    clarifyGroundingSummary
      ? `=== SOURCES FOUND IN CLARIFY STEP ===\nThe CLARIFY step already searched and found these sources.\nThese are VERIFIED and TRUSTWORTHY - do not doubt them:\n\n${clarifyGroundingSummary}\n`
      : '',
    '',
    '=== USER REQUEST ===',
    extractUserText(contents),
    '',
    userUrls.length
      ? `=== USER-PROVIDED URLs ===\n${userUrls.map(u => `- ${u}`).join('\n')}\n`
      : null,
    '',
    agentAddendumPlan,
    '',
    '=== BEGIN OUTPUT ===',
    '',
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
      `=== CURRENT DATE ===`,
      `Today's date: ${currentDate}`,
      'Evaluate information freshness based on this date.',
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
      stepNotes.length
        ? `=== PLAN_OUTPUT (from previous step) ===\n\n${stepNotes.join('\n\n---\n\n')}\n`
        : '=== NO PLAN_OUTPUT ===\nNo plan available. Determine what to research based on user request.',
      '',
      researchGroundingSummary
        ? `=== SOURCES/QUERIES GATHERED SO FAR ===\n${researchGroundingSummary}\n`
        : '=== NO SOURCES YET ===\nNo sources gathered yet. Start researching now.',
      '',
      userUrls.length
        ? `=== USER-PROVIDED URLs ===\n${userUrls.map(u => `- ${u}`).join('\n')}\n`
        : null,
      '',
      agentAddendumResearch,
      '',
      '=== BEGIN OUTPUT ===',
      '',
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
      stepNotes.length
        ? `=== ALL NOTES SO FAR ===\n\n${stepNotes.join('\n\n---\n\n')}\n`
        : '=== NO NOTES ===\nNo previous notes available.',
      '',
      groundingSummaryLoop
        ? `=== SOURCES/QUERIES SUMMARY ===\n${groundingSummaryLoop}\n`
        : '=== NO SOURCES YET ===\nNo sources gathered yet.',
      '',
      userUrls.length
        ? `=== USER-PROVIDED URLs ===\n${userUrls.map(u => `- ${u}`).join('\n')}\n`
        : null,
      '',
      agentAddendumControl,
      '',
      '=== BEGIN OUTPUT ===',
      '',
    ]
      .filter(Boolean)
      .join('\n')

    const controlResult = await streamOnce({
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

    // Store CONTROL_DECISION block if extracted, otherwise try manual extraction
    if (controlResult.structuredBlocks?.CONTROL_DECISION) {
      stepNotes.push(`<CONTROL_DECISION>\n${controlResult.structuredBlocks.CONTROL_DECISION}\n</CONTROL_DECISION>`)
    } else if (controlResult.collectedText) {
      const manualExtract = extractStructuredBlock(controlResult.collectedText, 'CONTROL_DECISION')
      if (manualExtract) {
        stepNotes.push(`<CONTROL_DECISION>\n${manualExtract}\n</CONTROL_DECISION>`)
      } else {
        console.warn('[agent-runner] CONTROL_DECISION block not found, using full text')
        stepNotes.push(`<CONTROL_DECISION>\n[Extraction failed - raw output]:\n${controlResult.collectedText}\n</CONTROL_DECISION>`)
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

      // Filter out CONTROL_DECISION blocks for FINAL step (they are internal decision notes)
      const relevantNotes = stepNotes.filter(note => !note.includes('<CONTROL_DECISION>'))

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
        '   - PLAN_OUTPUT: Terms, definitions, user URL summaries',
        '   - RESEARCH_NOTES: Facts, sources, dates from research',
        '   - Tool outputs in chat history (googleSearch, urlContext results)',
        '',
        '2. SUPPORTING CONTEXT (you MAY use general background knowledge to):',
        '   - Explain fundamental concepts that help understand the research findings',
        '   - Provide context that makes technical information more accessible',
        '   - Fill in obvious logical connections between researched facts',
        '   - Use phrasing like "一般的に...", "基本的には..." to distinguish from researched facts',
        '',
        '3. WHAT YOU MUST NOT DO:',
        '   - Do NOT add specific facts (versions, dates, specs) not found in RESEARCH',
        '   - Do NOT contradict or override RESEARCH findings with training data',
        '   - Do NOT make specific claims about current state without RESEARCH verification',
        '   - If RESEARCH did not find certain information, acknowledge the gap explicitly',
        '',
        '=== RESPONSE APPROACH ===',
        '',
        'Thinking phase (thorough analysis):',
        '- Review and organize ALL information from RESEARCH_NOTES systematically',
        '- Identify key themes, patterns, and connections across sources',
        '- Plan the structure of your comprehensive answer',
        '- Consider how to present complex information clearly',
        '- Decide which facts need more context or explanation',
        '- Take the time needed to synthesize information properly',
        '',
        'Writing phase (comprehensive and detailed):',
        '- Write a COMPLETE, THOROUGH, and DETAILED answer',
        '- Do NOT rush or summarize - this is the final deliverable to the user',
        '- Include ALL relevant details from RESEARCH_NOTES',
        '- Organize information logically with clear structure',
        '- Provide sufficient context and explanation for each point',
        '- Aim for depth and completeness over brevity',
        '',
        '=== ALL INFORMATION SOURCES (READ CAREFULLY) ===',
        '',
        relevantNotes.length
          ? `${relevantNotes.join('\n\n---\n\n')}\n`
          : 'No PLAN or RESEARCH notes available.',
        '',
        groundingSummary
          ? `=== SOURCES/QUERIES SUMMARY ===\n${groundingSummary}\n`
          : '',
        '',
        userUrls.length
          ? `=== USER-PROVIDED URLs ===\n${userUrls.map(u => `- ${u}`).join('\n')}\n`
          : '',
        '',
        '=== ORIGINAL USER REQUEST ===',
        extractUserText(contents) || '(No user request text available)',
        '',
        '=== URL OUTPUT POLICY FOR FINAL ANSWER ===',
        '- Carefully check the ORIGINAL USER REQUEST above.',
        '- Do NOT include sources or references unless the user explicitly asked for them.',
        '- Keywords indicating URL request: "URL", "リンク", "ソース", "出典", "参考", "link".',
        '- If uncertain, omit sources. Grounding metadata will be sent separately.',
        '',
        '=== ANSWER FORMATTING REQUIREMENTS ===',
        '',
        '1. LANGUAGE:',
        '   - Respond in Japanese (unless user explicitly requested another language)',
        '   - Use natural, conversational tone appropriate to your persona',
        '',
        '2. STRUCTURE AND FORMAT:',
        '   - Use Markdown with clear hierarchical headings (##, ###)',
        '   - Employ bullet lists, numbered lists, and tables where appropriate',
        '   - Add code blocks for technical content (with language syntax highlighting)',
        '   - Use bold/italic for emphasis on key points',
        '   - Break up long paragraphs for readability',
        '',
        '3. CONTENT DEPTH AND COMPLETENESS - DETAILED IMPLEMENTATION:',
        '   - For EACH fact in RESEARCH_NOTES, include:',
        '     * The fact itself with full technical detail',
        '     * Context: why this fact matters',
        '     * Practical implications or examples',
        '     * Related information that enhances understanding',
        '   - When explaining concepts:',
        '     * Start with overview, then dive into specifics',
        '     * Include technical specifications (versions, parameters, syntax)',
        '     * Provide concrete examples or code snippets when relevant',
        '     * Explain edge cases or limitations',
        '   - Quality benchmark: Aim for 2-3 paragraphs per major topic',
        '   - Do NOT use phrases like "など", "...等", "簡単に言うと" that indicate summarization',
        '   - VERSION HANDLING:',
        '     * Focus on LATEST version (as identified in PLAN/RESEARCH)',
        '     * Clearly state version numbers when discussing features',
        '     * Note if older versions behave differently (with version numbers)',
        '     * Do NOT mix information from different versions without clarifying which is which',
        '',
        '4. SOURCES AND ATTRIBUTION (only if user requests):',
        '   - If the user explicitly asks for sources/URLs, add a "## 情報源" section.',
        '   - List source titles ONLY by default; include URLs only when the user asked for links.',
        '   - Maintain source numbering/IDs from RESEARCH_NOTES if you cite them.',
        '',
        '5. INFORMATION GAPS AND LIMITATIONS:',
        '   - If RESEARCH did not find complete information, acknowledge gaps explicitly',
        '   - Clearly distinguish between: verified facts, partial information, and unknowns',
        '   - Suggest what additional information might be needed',
        '',
        '6. FRESHNESS AND CURRENCY:',
        '   - Note dates/versions explicitly when mentioning time-sensitive information',
        '   - If information might be outdated, add "（要確認）" or similar caveats',
        '   - Highlight which information is current vs. historical',
        '',
        '=== TOOLS: DO NOT CALL ANY TOOLS ===',
        'All research is complete. Use only the information above.',
        '',
        '=== FINAL REMINDER ===',
        '',
        'Critical points:',
        '- You are NOT the agent anymore. No <AGENT> tag.',
        '- Use ONLY information from RESEARCH_NOTES and PLAN_OUTPUT above.',
        '- Do NOT add information from your training data.',
        '- Do NOT include URLs unless explicitly requested by the user.',
        '- This is the FINAL user-facing deliverable.',
        '- Write a comprehensive, detailed, well-structured answer.',
        '- The user has been waiting for THIS answer - make it worth the wait.',
        '',
        '=== BEGIN OUTPUT ===',
        '',
      ]
        .filter(Boolean)
        .join('\n')

      // Create a new chat for FINAL step with persona-focused system instruction (no agent rules)
      const finalChat = ai.chats.create({
        model: baseModel,
        config: {
          systemInstruction: buildSystemInstruction('final'),
          thinkingConfig: baseThinking,
        },
        history: chat.history,
      })

      await streamOnce({
        chat: finalChat,
        message: toUserContent(finalPrompt),
        socket,
        chatId,
        requestId,
        step: 'final',
        debugLog: debugMode,
        config: { tools: [], thinkingConfig: baseThinking },
      })

      const groundingMetadata = buildGroundingMetadata(groundingAcc)
      if (groundingMetadata) {
        socket.emit('chunk', {
          chatId,
          requestId,
          provider: 'gemini',
          metadata: { grounding: groundingMetadata },
        })
      }

      socket.emit('end_generation', { ok: true, chatId, requestId })
      return
    }

    cycle += 1
    await runResearch(cycle)
  }
}
