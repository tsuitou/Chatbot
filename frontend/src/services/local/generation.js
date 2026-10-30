import { getRuntime } from './runtime'

// Browser-only replacement for services/socket.js (swapped in by
// vite.config.js for the PWA build). Runs the generation in the page and
// reports through the same handlers, with the same event shapes the server
// sends over the socket.

/**
 * @typedef {import('../socket').SocketHandlers} SocketHandlers
 * @typedef {{ chatId: string, requestId: string, controller: AbortController, reason: string | null }} Generation
 */

/** @type {SocketHandlers} */
let handlers = {
  onChunk: () => {},
  onEnd: () => {},
  onError: () => {},
  onDisconnect: () => {},
  onConnectionChange: () => {},
}

/** @type {Generation | null} */
let activeGeneration = null
let connected = false

/** @param {Partial<SocketHandlers>} next */
export const registerSocketHandlers = ({
  onChunk,
  onEnd,
  onError,
  onDisconnect,
  onConnectionChange,
}) => {
  if (onChunk) handlers.onChunk = onChunk
  if (onEnd) handlers.onEnd = onEnd
  if (onError) handlers.onError = onError
  if (onDisconnect) handlers.onDisconnect = onDisconnect
  if (onConnectionChange) {
    handlers.onConnectionChange = onConnectionChange
    // The app connects before the session store registers its handlers.
    if (connected) onConnectionChange('connected')
  }
}

// There is no server to lose, so the app is connected from the start.
export const connectSocket = () => {
  connected = true
  handlers.onConnectionChange('connected')
}

export const disconnectSocket = () => {}

/** @param {Generation | null} generation */
function abortGeneration(generation, reason) {
  if (!generation || generation.controller.signal.aborted) return false
  generation.reason = reason
  generation.controller.abort()
  return true
}

async function deliverChunk(chunk) {
  try {
    return await handlers.onChunk(chunk)
  } catch (error) {
    console.error('Failed to handle stream chunk:', error)
    return false
  }
}

async function runGeneration(rawPayload) {
  // Plain JSON, as the server would receive it: detached from reactive state.
  const payload = JSON.parse(JSON.stringify(rawPayload))
  const { chatId, requestId } = payload

  abortGeneration(activeGeneration, 'superseded')
  /** @type {Generation} */
  const generation = {
    chatId,
    requestId,
    controller: new AbortController(),
    reason: null,
  }
  activeGeneration = generation
  const { signal } = generation.controller
  const endAborted = () =>
    handlers.onEnd({
      ok: false,
      aborted: true,
      reason: generation.reason || 'aborted',
      chatId,
      requestId,
    })

  try {
    const job = (await getRuntime()).prepareGeneration(payload)
    for await (const chunk of job.run(signal)) {
      // Providers that ignore the signal keep streaming; stop reading instead.
      if (signal.aborted) break
      if ((await deliverChunk(chunk)) === false) {
        abortGeneration(generation, 'chunk_rejected')
      }
    }
    if (signal.aborted) endAborted()
    else handlers.onEnd({ ok: true, chatId, requestId })
  } catch (error) {
    if (signal.aborted) {
      endAborted()
      return
    }
    console.error('generation error:', error?.status, error?.message)
    const message = error?.message || 'generation failed'
    const status = Number(error?.status)
    handlers.onError({
      error: message,
      message,
      status: Number.isFinite(status) ? status : 500,
      chatId,
      requestId,
      metadata: error?.metadata,
    })
  } finally {
    if (activeGeneration === generation) activeGeneration = null
  }
}

export const startGeneration = (payload) => {
  void runGeneration(payload)
}

export const cancelBackendGeneration = ({ chatId, requestId }) => {
  if (
    activeGeneration?.chatId === chatId &&
    activeGeneration?.requestId === requestId
  ) {
    abortGeneration(activeGeneration, 'cancelled')
  }
}
