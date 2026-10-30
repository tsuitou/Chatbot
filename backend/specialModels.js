const VIRTUAL_CAPABILITIES_BASE = {
  provider: 'virtual',
  label: 'Special',
  parameters: {},
}

const SPECIAL_MODEL_DEFINITIONS = [
  {
    name: 'dummy',
    isAvailable: () => true,
    capabilities: {
      ...VIRTUAL_CAPABILITIES_BASE,
      model: 'dummy',
      features: { systemInstruction: false },
      tools: {},
      attachments: { enabled: true, allowRemoteUpload: false, allowedMimes: null, maxInlineFileSize: 10485760 },
    },
    async handle(socket, data) {
      const { chatId, requestId } = data
      socket.emit('chunk', { chatId, requestId, provider: 'virtual', deltaText: '' })
      socket.emit('end_generation', { ok: true, chatId, requestId, finishReason: 'stop' })
    },
  },
]

export function createSpecialRegistry({ providerKeys }) {
  const byName = new Map(SPECIAL_MODEL_DEFINITIONS.map((m) => [m.name, m]))
  const ctx = { providerKeys }

  return {
    label: VIRTUAL_CAPABILITIES_BASE.label,

    list() {
      return SPECIAL_MODEL_DEFINITIONS.filter((m) => m.isAvailable(ctx)).map((m) => m.name)
    },

    isSpecial(name) {
      return byName.has(name)
    },

    capabilities(name) {
      return byName.get(name)?.capabilities ?? null
    },

    async handle(name, socket, data, runtimeContext = {}) {
      const model = byName.get(name)
      if (!model) throw new Error(`Unknown special model: ${name}`)
      if (!model.isAvailable(ctx)) throw new Error(`Model "${name}" is not available`)
      await model.handle(socket, data, { ...ctx, ...runtimeContext })
    },
  }
}
