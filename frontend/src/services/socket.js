import { io } from 'socket.io-client'
import { useChatStore } from '../stores/chat'

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

const socket = io(resolveSocketUrl(), {
  autoConnect: false,
})

let store

const initializeStore = () => {
  if (!store) {
    store = useChatStore()
  }
}

socket.on('connect', () => {
  console.log('Socket connected:', socket.id)
})

socket.on('disconnect', () => {
  console.log('Socket disconnected')
})

socket.on('chunk', (rawChunk) => {
  initializeStore()
  store.handleStreamChunk(rawChunk)
})

socket.on('end_generation', (result) => {
  initializeStore()
  console.log('Generation finished:', result)
  store.handleStreamEnd(result)
})

socket.on('error', (rawError) => {
  initializeStore()
  console.error('Socket error:', rawError)
  store.handleStreamError(rawError)
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
    initializeStore()
    const error = {
      message: 'Not connected to the server.',
      chatId: payload.chatId,
      requestId: payload.requestId,
    }
    store.handleStreamError(error)
  }
}

export default socket
