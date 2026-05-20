import { GoogleGenAI } from '@google/genai'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_RETENTION_DAYS = 55
const AGENT_TOOLS_FILE = 'agent-tools.json'

const runtimeFilename = fileURLToPath(import.meta.url)
const runtimeDirname = path.dirname(runtimeFilename)
const backendRoot = path.resolve(runtimeDirname, '..')
const projectRoot = path.resolve(backendRoot, '..')
const baseDirs = Array.from(new Set([runtimeDirname, backendRoot, projectRoot, process.cwd()]))

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

function normalizeDateOnly(date = new Date()) {
  return date.toISOString().slice(0, 10)
}

function addDays(date, days) {
  const next = new Date(date)
  next.setUTCDate(next.getUTCDate() + days)
  return next
}

function supportsServerSideToolInvocations(modelName) {
  const normalized = String(modelName || '').toLowerCase()
  return normalized.includes('gemini-3') || normalized.includes('gemini-4')
}

function resolveRetentionDays() {
  const parsed = Number.parseInt(
    process.env.DEEP_RESEARCH_RETENTION_DAYS || '',
    10
  )
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RETENTION_DAYS
}

function readAgentToolsRaw() {
  const resolved = resolveFirstExisting(AGENT_TOOLS_FILE, 'file')
  if (resolved) return fs.readFileSync(resolved, 'utf8')
  console.warn('[deep-research-agent] failed to read agent tools file:', AGENT_TOOLS_FILE)
  return ''
}

function parseAgentTools(raw = readAgentToolsRaw()) {
  if (!raw || !String(raw).trim()) return []
  const text = String(raw).trim()
  let values = []
  try {
    const parsed = JSON.parse(text)
    if (Array.isArray(parsed)) values = parsed
  } catch {
    values = []
  }

  const normalized = values
    .map((value) => {
      if (!value || typeof value !== 'object') return null
      const name = String(value.name || '').trim()
      if (!name) return null
      return {
        name,
        description: String(value.description || '').trim(),
      }
    })
    .filter(Boolean)

  const seen = new Set()
  return normalized.filter((tool) => {
    if (seen.has(tool.name)) return false
    seen.add(tool.name)
    return true
  })
}

function resolveAgentTools() {
  return parseAgentTools()
}

function hasAgentTool(tools, name) {
  return Array.isArray(tools) && tools.some((tool) => tool.name === name)
}

function hasDeepResearchTool(tools) {
  return Array.isArray(tools) && tools.length > 0
}

function formatToolKnowledge(tools) {
  if (!Array.isArray(tools) || !tools.length) {
    return 'Available Deep Research agents: none. Answer directly from local chat history.'
  }
  return [
    'Available Deep Research agents are provided as JSON. Choose the appropriate agent by its name and pass that exact name in the function call `agent` argument. Do not invent agent names.',
    JSON.stringify(
      tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
      })),
      null,
      2
    ),
    'Supported actions for each agent: plan, refine, run',
  ].join('\n')
}

function buildDeepResearchToolConfig(agentTools) {
  if (!hasDeepResearchTool(agentTools)) return []
  const agentJson = JSON.stringify(agentTools, null, 2)
  return [
    {
      functionDeclarations: [
        {
          name: 'deep_research_plan',
          description:
            'Start a new Gemini Deep Research planning interaction only. Use this only when the user explicitly asks for web research, current information, source collection, broad comparison, investigation, or Deep Research and there is no active planning session being continued. Do not use this for approval or execution of an existing plan. Do not use this for ordinary explanations, tutorials, definitions, math derivations, coding help, summaries of existing chat content, or questions that can be answered from general model knowledge.',
          parameters: {
            type: 'object',
            properties: {
              input: {
                type: 'string',
                description: 'The research request to plan.',
              },
              agent: {
                type: 'string',
                description: `Required Deep Research agent name. Choose exactly one name from this JSON list: ${agentJson}`,
              },
            },
            required: ['input', 'agent'],
          },
        },
        {
          name: 'deep_research_refine',
          description:
            'Revise the latest non-expired Deep Research planning interaction. Use this when the latest session is still planning and the user asks to change, add, remove, narrow, broaden, or otherwise edit the plan. Do not use this to execute an approved plan.',
          parameters: {
            type: 'object',
            properties: {
              instruction: {
                type: 'string',
                description: 'How the current research plan should be revised.',
              },
              agent: {
                type: 'string',
                description: `Required Deep Research agent name. Choose exactly one name from this JSON list: ${agentJson}`,
              },
            },
            required: ['instruction', 'agent'],
          },
        },
        {
          name: 'deep_research_run',
          description:
            'Execute the latest non-expired Deep Research plan. Use this when the latest session is still planning and the user approves the plan or asks to proceed, start, run, execute, continue with the plan, or produce the research report. This is the only tool that runs Deep Research with collaborative_planning=false.',
          parameters: {
            type: 'object',
            properties: {
              instruction: {
                type: 'string',
                description:
                  'Optional execution instruction or approval text from the user.',
              },
              agent: {
                type: 'string',
                description: `Required Deep Research agent name. Choose exactly one name from this JSON list: ${agentJson}`,
              },
            },
            required: ['agent'],
          },
        },
      ],
    },
  ]
}

function textFromPart(part) {
  if (!part || typeof part !== 'object') return ''
  return typeof part.text === 'string' ? part.text : ''
}

function textFromContent(content) {
  if (!content) return ''
  if (typeof content === 'string') return content
  const list = Array.isArray(content) ? content : [content]
  return list
    .map((item) => {
      if (!item || typeof item !== 'object') return ''
      if (typeof item.text === 'string') return item.text
      if (Array.isArray(item.parts)) return item.parts.map(textFromPart).join('')
      return ''
    })
    .join('')
}

function extractUserText(contents = []) {
  const userTurns = Array.isArray(contents)
    ? contents.filter((item) => item?.role === 'user')
    : []
  const last = userTurns[userTurns.length - 1]
  return (last?.parts || []).map(textFromPart).filter(Boolean).join('\n').trim()
}

function extractAllText(contents = []) {
  if (!Array.isArray(contents)) return ''
  return contents
    .map((content) => (content.parts || []).map(textFromPart).join('\n'))
    .filter(Boolean)
    .join('\n\n')
}

function parseSessionBlocks(text) {
  const blocks = []
  const marker = 'Deep Research セッション'
  let index = 0
  while ((index = text.indexOf(marker, index)) !== -1) {
    const start = Math.max(0, text.lastIndexOf('---', index))
    const next = text.indexOf('\n---', index + marker.length)
    const end = next === -1 ? text.length : next
    const raw = text.slice(start, end)
    const block = { raw }
    for (const line of raw.split(/\r?\n/)) {
      const match = line.match(/^([A-Za-z_]+):\s*(.*)$/)
      if (match) block[match[1]] = match[2].trim()
    }
    blocks.push(block)
    index = end
  }
  return blocks
}

function latestSessionFromContents(contents) {
  const blocks = parseSessionBlocks(extractAllText(contents))
  return blocks[blocks.length - 1] || null
}

function countExistingSessions(contents) {
  return parseSessionBlocks(extractAllText(contents)).length
}

function createSessionId(contents, now = new Date()) {
  const n = countExistingSessions(contents) + 1
  return `dr_${normalizeDateOnly(now)}_${String(n).padStart(3, '0')}`
}

function isExpired(session, now = new Date()) {
  if (!session?.interaction_expires_at) return false
  const expires = new Date(`${session.interaction_expires_at}T23:59:59.999Z`)
  return Number.isFinite(expires.getTime()) && expires < now
}

function normalizeInteractionStatus(status, action) {
  if (status === 'completed') {
    if (action === 'plan' || action === 'refine') return 'planning'
    return 'completed'
  }
  if (status === 'failed') return 'failed'
  if (status === 'cancelled') return 'cancelled'
  return action === 'run' ? 'running' : 'planning'
}

function usageToMetadata(usage) {
  if (!usage) return null
  return {
    input: usage.total_input_tokens ?? null,
    output: usage.total_output_tokens ?? null,
    reasoning: usage.total_thought_tokens ?? null,
    toolUse: usage.total_tool_use_tokens ?? null,
    cached: usage.total_cached_tokens ?? null,
    total: usage.total_tokens ?? null,
    raw: usage,
  }
}

function getLastOutputStep(interaction) {
  const steps = Array.isArray(interaction?.steps) ? interaction.steps : []
  return [...steps].reverse().find((step) => step?.type === 'model_output')
}

function extractFinalOutput(interaction) {
  const output = getLastOutputStep(interaction)
  const content = Array.isArray(output?.content)
    ? output.content
    : Array.isArray(interaction?.outputs)
      ? interaction.outputs
      : []
  const annotations = []
  for (const item of content) {
    if (Array.isArray(item?.annotations)) annotations.push(...item.annotations)
  }
  return {
    text: content.map(textFromContent).join(''),
    annotations,
  }
}

function buildSessionBlock({
  sessionId,
  agent,
  action,
  status,
  createdAt,
  completedAt,
  interactionId,
  previousInteractionId,
  expiresAt,
}) {
  const lines = [
    '',
    '',
    '---',
    'Deep Research セッション\n\n',
    `session_id: ${sessionId}\n\n`,
    `agent: ${agent}\n\n`,
    `mode: ${action}\n\n`,
    `status: ${status}\n\n`,
    `created_at: ${normalizeDateOnly(new Date(createdAt))}\n\n`,
  ]
  if (completedAt) {
    lines.push(`completed_at: ${normalizeDateOnly(new Date(completedAt))}\n\n`)
  }
  lines.push(`latest_interaction_id: ${interactionId}\n\n`)
  if (previousInteractionId) {
    lines.push(`previous_interaction_id: ${previousInteractionId}\n\n`)
  }
  lines.push(
    `interaction_expires_at: ${normalizeDateOnly(expiresAt)}\n\n`,
  )
  return lines.join('\n')
}

function emitPart(socket, { chatId, requestId, text, thought = false, metadata }) {
  if (!text && !metadata) return
  const payload = {
    chatId,
    requestId,
    provider: 'gemini',
  }
  if (text) payload.parts = [{ text, thought }]
  if (metadata) payload.metadata = metadata
  socket.emit('chunk', payload)
}

function normalizeThoughtDelta(delta) {
  if (delta?.type !== 'thought_summary') return ''
  return textFromContent(delta.content)
}

function buildMergedSystemInstruction({
  defaultSystemInstruction,
  userSystemInstruction,
  agentTools,
}) {
  return [
    userSystemInstruction || null,
    defaultSystemInstruction || null,
    [
      'You are an agent that can use Gemini Deep Research when appropriate.',
      'Default to answering directly. Use Deep Research only when the user explicitly asks for research, investigation, current information, source collection, broad comparison, or continuation/execution of an existing Deep Research session.',
      'Do not use Deep Research for ordinary explanations, tutorials, definitions, mathematical derivations, coding help, or questions that can be answered from general model knowledge. For example, "Explain the Euler method" should be answered directly, not converted into a research plan.',
      'You decide whether to answer directly or use Deep Research from the local chat history and the latest Deep Research session block.',
      'Deep Research tool selection rules:',
      '- Use deep_research_plan only to start a new Deep Research session.',
      '- If the latest Deep Research session block has status: planning and the user approves the plan or asks to proceed, start, run, execute, continue with the plan, or produce the report, call deep_research_run. Do not call deep_research_plan for approval or execution turns.',
      '- If the latest Deep Research session block has status: planning and the user asks to change the plan, call deep_research_refine.',
      '- The session block field `mode: plan` means the previous API call used collaborative planning. It does not mean that the next turn should call deep_research_plan.',
      '- If the latest Deep Research session is completed or expired, answer from local chat history unless the user explicitly asks to start a new research session.',
      'Use the provided function tools to start, refine, or run Deep Research. Do not claim that Deep Research was used unless you called one of those tools.',
      'When Deep Research is used, preserve the session information in the chat text so future turns can continue from local history.',
      formatToolKnowledge(agentTools),
    ].join('\n'),
  ]
    .filter(Boolean)
    .join('\n\n')
}

function buildInteractionInputWithInstructions({
  action,
  userText,
  systemInstruction,
}) {
  const globalInstruction = systemInstruction
    ? [
        'System instructions to follow:',
        systemInstruction,
      ].join('\n')
    : null
  if (action === 'run') {
    return [
      'The user approved the current Deep Research plan. Execute the research now.',
      userText ? `Additional user instruction: ${userText}` : null,
      globalInstruction,
    ]
      .filter(Boolean)
      .join('\n\n')
  }
  if (action === 'refine') {
    return [
      'Revise the current Deep Research plan according to the user instruction.',
      userText || 'Refine the plan.',
      globalInstruction,
    ].join('\n\n')
  }
  return [userText || 'Create a Deep Research plan.', globalInstruction]
    .filter(Boolean)
    .join('\n\n')
}

function parseFunctionArgs(args) {
  if (!args) return {}
  if (typeof args === 'string') {
    try {
      return JSON.parse(args)
    } catch {
      return {}
    }
  }
  return typeof args === 'object' ? args : {}
}

function functionCallFromChunk(chunk) {
  const candidate = chunk?.candidates?.[0]
  const parts = candidate?.content?.parts || []
  for (const part of parts) {
    if (part?.functionCall) return part.functionCall
  }
  const calls = candidate?.functionCalls || chunk?.functionCalls
  return Array.isArray(calls) ? calls[0] : null
}

function actionFromFunctionName(name) {
  if (name === 'deep_research_plan') return 'plan'
  if (name === 'deep_research_refine') return 'refine'
  if (name === 'deep_research_run') return 'run'
  return null
}

function chooseResearchAgentFromArgs(args, agentTools) {
  const requestedAgent = typeof args.agent === 'string' ? args.agent.trim() : ''
  if (requestedAgent && hasAgentTool(agentTools, requestedAgent)) return requestedAgent
  return null
}

function textFromToolArgs(action, args, fallback) {
  if (action === 'plan') return String(args.input || fallback || '').trim()
  return String(args.instruction || fallback || '').trim()
}

function buildAgentModelConfig({ model, systemInstruction, requestConfig, agentTools }) {
  const config = {
    ...(requestConfig || {}),
    systemInstruction,
  }
  delete config.model
  delete config.options
  config.thinkingConfig = {
    ...(config.thinkingConfig || {}),
    includeThoughts: true,
  }
  if (supportsServerSideToolInvocations(model)) {
    config.toolConfig = {
      ...(config.toolConfig || {}),
      includeServerSideToolInvocations: true,
    }
  }
  const requestTools = Array.isArray(config.tools) ? config.tools.filter(Boolean) : []
  const deepResearchTools = buildDeepResearchToolConfig(agentTools)
  const tools = [...requestTools, ...deepResearchTools]
  if (tools.length) config.tools = tools
  else delete config.tools
  return config
}

async function streamAgentModelTurn({
  ai,
  model,
  contents,
  socket,
  chatId,
  requestId,
  systemInstruction,
  requestConfig,
  agentTools,
}) {
  const config = buildAgentModelConfig({
    model,
    systemInstruction,
    requestConfig,
    agentTools,
  })

  const stream = await ai.models.generateContentStream({
    model,
    contents,
    config,
  })

  let usage = null
  let functionCall = null
  for await (const chunk of stream) {
    usage = chunk?.usageMetadata || usage
    functionCall = functionCall || functionCallFromChunk(chunk)
    socket.emit('chunk', {
      chatId,
      requestId,
      parts: chunk?.candidates?.[0]?.content?.parts,
      usage: chunk?.usageMetadata,
      finishReason: chunk?.candidates?.[0]?.finishReason,
      grounding: chunk?.candidates?.[0]?.groundingMetadata,
      provider: 'gemini',
    })
  }
  return { functionCall, usage }
}

async function runDeepResearchInteraction({
  ai,
  socket,
  chatId,
  requestId,
  action,
  userText,
  systemInstruction,
  sessionId,
  previousInteractionId,
  agent,
  retentionDays,
}) {
  const now = new Date()
  const expiresAt = addDays(now, retentionDays)
  const params = {
    agent,
    input: buildInteractionInputWithInstructions({
      action,
      userText,
      systemInstruction,
    }),
    background: true,
    stream: true,
    agent_config: {
      type: 'deep-research',
      thinking_summaries: 'auto',
      collaborative_planning: action !== 'run',
      visualization: 'off',
    },
  }
  if (previousInteractionId) {
    params.previous_interaction_id = previousInteractionId
  }

  let interactionId = null
  let interactionStatus = 'in_progress'
  let streamedText = ''
  const streamedAnnotations = []

  const stream = await ai.interactions.create(params)

  for await (const event of stream) {
    if (event?.interaction?.id) {
      interactionId = event.interaction.id
      interactionStatus = event.interaction.status || interactionStatus
      emitPart(socket, {
        chatId,
        requestId,
        metadata: {
          provider: 'gemini',
          deepResearch: {
            sessionId,
            interactionId,
            action,
            agent,
            status: normalizeInteractionStatus(interactionStatus, action),
          },
        },
      })
      continue
    }

    if (event?.interaction_id) {
      interactionId = event.interaction_id
      interactionStatus = event.status || interactionStatus
      continue
    }

    if (event?.event_type !== 'step.delta') continue
    const delta = event.delta || {}
    if (delta.type === 'thought_summary') {
      const thoughts = normalizeThoughtDelta(delta)
      if (thoughts) {
        emitPart(socket, { chatId, requestId, text: thoughts, thought: true })
      }
    } else if (delta.type === 'text' && delta.text) {
      streamedText += delta.text
      emitPart(socket, { chatId, requestId, text: delta.text })
    } else if (delta.type === 'text_annotation_delta') {
      const annotations = Array.isArray(delta.annotations)
        ? delta.annotations
        : delta.annotation
          ? [delta.annotation]
          : []
      streamedAnnotations.push(...annotations)
    }
  }

  if (!interactionId) {
    throw new Error('Deep Research stream ended without interaction id')
  }

  const finalInteraction = await ai.interactions.get(
    interactionId,
    { include_input: true }
  )
  const final = extractFinalOutput(finalInteraction)
  const finalStatus = normalizeInteractionStatus(finalInteraction.status, action)
  const completedAt = new Date().toISOString()

  if (!streamedText.trim() && final.text) {
    emitPart(socket, { chatId, requestId, text: final.text })
  }

  emitPart(socket, {
    chatId,
    requestId,
    text: buildSessionBlock({
      sessionId,
      agent,
      action,
      status: finalStatus,
      createdAt: now,
      completedAt,
      interactionId,
      previousInteractionId,
      expiresAt,
    }),
    metadata: {
      provider: 'gemini',
      deepResearch: {
        sessionId,
        action,
        status: finalStatus,
        interactionStatus: finalInteraction.status,
        interactionId,
        previousInteractionId: previousInteractionId || null,
        agent,
        interactionExpiresAt: normalizeDateOnly(expiresAt),
        retentionDays,
        usage: usageToMetadata(finalInteraction.usage),
        annotations: final.annotations.length ? final.annotations : streamedAnnotations,
      },
    },
  })

  socket.emit('end_generation', {
    ok: true,
    chatId,
    requestId,
    finishReason: finalInteraction.status,
  })
}

export async function runDeepResearchAgentSession({
  apiKey,
  baseModel,
  defaultSystemInstruction,
  userSystemInstruction,
  contents,
  socket,
  chatId,
  requestId,
  requestConfig = {},
  ai: injectedAi,
}) {
  const ai = injectedAi || new GoogleGenAI({ apiKey })
  const model = baseModel || process.env.AGENT_BASE_MODEL
  if (!model) {
    throw new Error('Agent base model is not configured (set AGENT_BASE_MODEL)')
  }
  const agentTools = resolveAgentTools()
  const systemInstruction = buildMergedSystemInstruction({
    defaultSystemInstruction,
    userSystemInstruction,
    agentTools,
  })

  const userText = extractUserText(contents)
  const agentTurn = await streamAgentModelTurn({
    ai,
    model,
    contents,
    socket,
    chatId,
    requestId,
    systemInstruction,
    requestConfig,
    agentTools,
  })
  const functionCall = agentTurn.functionCall
  if (!functionCall) {
    socket.emit('end_generation', {
      ok: true,
      chatId,
      requestId,
      tokenUsage: agentTurn.usage,
    })
    return
  }

  const retentionDays = resolveRetentionDays()
  if (!hasDeepResearchTool(agentTools)) {
    emitPart(socket, {
      chatId,
      requestId,
      text: 'No Deep Research agent is enabled in agent-tools.json.',
    })
    socket.emit('end_generation', { ok: true, chatId, requestId })
    return
  }

  const action = actionFromFunctionName(functionCall.name)
  if (!action) {
    emitPart(socket, {
      chatId,
      requestId,
      text: `Unsupported agent tool call: ${functionCall.name || '(unknown)'}`,
    })
    socket.emit('end_generation', { ok: true, chatId, requestId })
    return
  }

  const args = parseFunctionArgs(functionCall.args || functionCall.arguments)
  const latestSession = latestSessionFromContents(contents)
  const sessionId =
    latestSession && !isExpired(latestSession)
      ? latestSession.session_id || createSessionId(contents)
      : createSessionId(contents)
  const previousInteractionId =
    (action === 'refine' || action === 'run') &&
    latestSession &&
    !isExpired(latestSession)
      ? latestSession?.latest_interaction_id
      : null

  if ((action === 'refine' || action === 'run') && !previousInteractionId) {
    emitPart(socket, {
      chatId,
      requestId,
      text:
        'There is no active Deep Research planning session to continue. Start a new Deep Research plan first.',
    })
    socket.emit('end_generation', { ok: true, chatId, requestId })
    return
  }

  const agent = chooseResearchAgentFromArgs(args, agentTools)
  if (!agent) {
    emitPart(socket, {
      chatId,
      requestId,
      text:
        'Deep Research agent was not specified or is not enabled in agent-tools.json.',
    })
    socket.emit('end_generation', { ok: true, chatId, requestId })
    return
  }
  const researchText = textFromToolArgs(action, args, userText)

  await runDeepResearchInteraction({
    ai,
    socket,
    chatId,
    requestId,
    action,
    userText: researchText,
    systemInstruction,
    sessionId,
    previousInteractionId,
    agent,
    retentionDays,
  })
}
