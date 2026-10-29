import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { createServer } from 'node:http'
import { Server } from 'socket.io'

// Runs the real client module against a real socket.io server so the event
// names it relies on (including the manager's reconnect events) are checked.
let httpServer
let io
let client
const statuses = []
const disconnects = []

const waitFor = (predicate) =>
  vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 5000 })

beforeAll(async () => {
  httpServer = createServer()
  io = new Server(httpServer, { path: '/chatbot/socket.io' })
  await new Promise((resolve) => httpServer.listen(0, resolve))
  vi.stubEnv('VITE_SOCKET_URL', `http://127.0.0.1:${httpServer.address().port}`)
  client = await import('../../src/services/socket')
  client.registerSocketHandlers({
    onConnectionChange: (status) => statuses.push(status),
    onDisconnect: (reason) => disconnects.push(reason),
  })
})

afterAll(async () => {
  client?.disconnectSocket()
  io?.close()
  vi.unstubAllEnvs()
})

describe('socket service', () => {
  it('reports connecting, then connected', async () => {
    client.connectSocket()
    await waitFor(() => statuses.at(-1) === 'connected')
    expect(statuses).toEqual(['connecting', 'connected'])
  })

  it('reports a server-side drop and reconnects on its own', async () => {
    statuses.length = 0
    io.disconnectSockets()
    await waitFor(() => statuses.at(-1) === 'connected')
    expect(disconnects).toEqual(['io server disconnect'])
    expect(statuses[0]).toBe('disconnected')
  })

  it('reports reconnect attempts after a transport failure', async () => {
    statuses.length = 0
    disconnects.length = 0
    for (const socket of await io.fetchSockets()) {
      socket.conn.close()
    }
    await waitFor(() => statuses.at(-1) === 'connected')
    expect(disconnects).toEqual(['transport close'])
    expect(statuses).toEqual(['disconnected', 'connecting', 'connected'])
  })
})
