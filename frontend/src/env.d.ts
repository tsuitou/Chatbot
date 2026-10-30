declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<object, object, unknown>
  export default component
}

// Build-time settings; see .env.example.
interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string
  readonly VITE_SOCKET_URL?: string
  readonly VITE_SOCKET_PATH?: string
  readonly VITE_DEFAULT_TOOL_URL_CONTEXT?: string
  readonly VITE_DEFAULT_TOOL_SEARCH?: string
  readonly VITE_DEFAULT_TOOL_CODE_EXECUTION?: string
  readonly VITE_ENABLE_DEBUG_PANEL?: string
  readonly VITE_MAX_UPLOAD_FILE_SIZE?: string
  readonly VITE_STREAM_IDLE_TIMEOUT?: string
  readonly VITE_BACKEND?: 'local'
}

// Server defaults baked into the browser-only build; see vite.config.js.
declare const __LOCAL_DEFAULTS__: {
  settings: Record<string, string>
  systemInstruction: string
}
