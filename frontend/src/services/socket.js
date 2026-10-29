import { io } from 'socket.io-client'

const resolveSocketUrl = () => {
  const raw = import.meta.env?.VITE_SOCKET_URL
  if (typeof raw === 'string' && raw.trim().length > 0) {
    return raw.trim()
  }

  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin
  }

  return ''
}

const resolveSocketPath = () => {
  const raw = import.meta.env?.VITE_SOCKET_PATH
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return '/chatbot/socket.io'
  }

  const path = raw.trim()
  return path.startsWith('/') ? path : `/${path}`
}

const socket = io(resolveSocketUrl(), {
  autoConnect: false,
  path: resolveSocketPath(),
})

/**
 * @typedef {'connecting' | 'connected' | 'disconnected'} ConnectionStatus
 * @typedef {object} SocketHandlers
 * @property {(chunk: import('../types').StreamChunk) => boolean | void | Promise<boolean | void>} onChunk
 *   Resolve to false to report the chunk as ignored in its ack.
 * @property {(result: { chatId: string, requestId: string, aborted?: boolean, reason?: string, finishReason?: string }) => void} onEnd
 * @property {(error: { chatId?: string, requestId?: string, error?: string, message?: string, metadata?: object }) => void} onError
 * @property {(reason: string) => void} onDisconnect
 * @property {(status: ConnectionStatus) => void} onConnectionChange
 */

/** @type {SocketHandlers} */
let handlers = {
  onChunk: () => {},
  onEnd: () => {},
  onError: () => {},
  onDisconnect: () => {},
  onConnectionChange: () => {},
}

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
  if (onConnectionChange) handlers.onConnectionChange = onConnectionChange
}

socket.on('connect', () => {
  console.log('Socket connected:', socket.id)
  handlers.onConnectionChange('connected')
})

socket.on('disconnect', (reason) => {
  console.log('Socket disconnected:', reason)
  handlers.onConnectionChange('disconnected')
  // The backend aborts any running generation when the socket drops, so the
  // in-flight request can never finish; let the store close it out.
  handlers.onDisconnect(reason)
  // socket.io does not retry after a server-initiated disconnect.
  if (reason === 'io server disconnect') {
    socket.connect()
  }
})

socket.io.on('reconnect_attempt', () => {
  handlers.onConnectionChange('connecting')
})

socket.on('chunk', async (rawChunk, ack) => {
  try {
    const handled = await handlers.onChunk(rawChunk)
    if (typeof ack === 'function') {
      ack(
        handled === false
          ? { ok: false, message: 'Chunk was ignored by the client.' }
          : { ok: true }
      )
    }
  } catch (error) {
    if (typeof ack === 'function') {
      ack({ ok: false, message: error?.message || 'Failed to handle chunk.' })
    }
    console.error('Failed to handle stream chunk:', error)
  }
})

socket.on('end_generation', (result) => {
  handlers.onEnd(result)
})

socket.on('error', (rawError) => {
  console.error('Socket error:', rawError)
  handlers.onError(rawError)
})

socket.on('frontend_reload', (payload) => {
  console.info('Frontend reload requested by backend:', payload)
  if (typeof window !== 'undefined' && window.location) {
    window.location.reload()
  }
})

export const connectSocket = () => {
  if (!socket.connected) {
    handlers.onConnectionChange('connecting')
    socket.connect()
  }
}

export const disconnectSocket = () => {
  if (socket.connected) {
    socket.disconnect()
  }
}

export const startGeneration = (payload) => {
  if (socket.connected) {
    socket.emit('start_generation', payload)
  } else {
    console.error('Socket not connected. Cannot start generation.')
    const error = {
      message: 'Not connected to the server.',
      chatId: payload.chatId,
      requestId: payload.requestId,
    }
    handlers.onError(error)
  }
}

export const cancelBackendGeneration = ({ chatId, requestId }) => {
  if (socket.connected && requestId) {
    socket.emit('cancel_generation', { chatId, requestId })
  }
}

export default socket
