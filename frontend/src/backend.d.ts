// The shared provider runtime in ../backend (see vite.config.js). Declared
// here so the frontend type check does not pull in the backend sources.
declare module '@backend/runtime.js' {
  export interface Runtime {
    openaiCompatIds: string[]
    hasProvider(): boolean
    setDefaultSystemInstruction(systemInstruction: string, mode?: string): void
    listModelGroups(): Promise<
      { provider: string; label: string; models: string[] }[]
    >
    defaultModel(): string
    getModelCapabilities(
      modelName: string,
      providerHint?: string | null
    ): Promise<import('./types').ModelCapabilities>
    uploadFile(
      file: Blob | string,
      options: {
        mimeType?: string
        displayName?: string
        model?: string
        provider?: string | null
      }
    ): Promise<{ uri?: string; [key: string]: unknown }>
    prepareGeneration(data: object): {
      special: boolean
      providerId?: string
      abortable: boolean
      run(
        signal?: AbortSignal | null
      ): AsyncIterable<import('./types').StreamChunk>
    }
  }

  export function createRuntime(options?: {
    keys?: Record<string, string>
    settings?: Record<string, string>
    capabilities?: Record<string, unknown>
    openaiCompatConfig?: unknown
    defaultSystemInstruction?: string
    clientOptions?: Record<string, unknown>
  }): Runtime
}

declare module '@backend/capabilities/*.json' {
  const capabilities: Record<string, unknown>
  export default capabilities
}
