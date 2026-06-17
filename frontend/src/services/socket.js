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

let handlers = {
  onChunk: () => {},
  onEnd: () => {},
  onError: () => {},
}

export const registerSocketHandlers = ({ onChunk, onEnd, onError }) => {
  if (onChunk) handlers.onChunk = onChunk
  if (onEnd) handlers.onEnd = onEnd
  if (onError) handlers.onError = onError
}

socket.on('connect', () => {
  console.log('Socket connected:', socket.id)
})

socket.on('disconnect', () => {
  console.log('Socket disconnected')
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

export default socket
