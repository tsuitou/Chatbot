import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { pwaPlugin } from './build/pwaPlugin.js'

const backendDir = fileURLToPath(new URL('../backend', import.meta.url))
const localService = (name) =>
  fileURLToPath(new URL(`./src/services/local/${name}.js`, import.meta.url))

// Minimal .env reader: KEY=VALUE lines, # comments, optional quotes.
function parseEnv(text) {
  const result = {}
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (!match) continue
    result[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2')
  }
  return result
}

function readBackendFile(name) {
  try {
    return readFileSync(`${backendDir}/${name}`, 'utf-8')
  } catch {
    return ''
  }
}

// The browser-only build starts from the server's shipped defaults, so both
// stay in sync without a second copy.
function readLocalDefaults() {
  const env = parseEnv(readBackendFile('.env'))
  return {
    settings: {
      defaultModel: env.DEFAULT_MODEL || '',
      geminiModelFilter: env.GEMINI_MODEL_FILTER || '',
      claudeModelFilter: env.CLAUDE_MODEL_FILTER || '',
      systemInstructionMode: env.SYSTEM_INSTRUCTION_MODE || '',
      openrouterModels: env.OPENROUTER_MODELS || '',
      openrouterAppTitle: env.OPENROUTER_APP_TITLE || '',
    },
    systemInstruction: readBackendFile('system_instruction.txt'),
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // `--mode pwa` builds the backend-less app: providers run in the browser and
  // the socket/api services are swapped for local implementations below, so
  // the stores and components stay the same in both builds.
  const isPwa = mode === 'pwa'
  return {
    base: isPwa ? process.env.PWA_BASE || '/Chatbot/' : '/chatbot/',
    plugins: [vue(), ...(isPwa ? [pwaPlugin()] : [])],
    define: {
      __LOCAL_DEFAULTS__: JSON.stringify(readLocalDefaults()),
    },
    resolve: {
      alias: [
        { find: '@backend', replacement: backendDir },
        ...(isPwa
          ? [
              {
                find: /^\.{1,2}\/services\/socket$/,
                replacement: localService('generation'),
              },
              {
                find: /^\.{1,2}\/services\/api$/,
                replacement: localService('catalog'),
              },
              {
                find: /^\.{1,2}\/services\/pwa$/,
                replacement: localService('pwa'),
              },
            ]
          : []),
      ],
    },
    build: {
      outDir: isPwa ? 'dist-pwa' : 'dist',
    },
    server: {
      fs: { allow: ['.', backendDir] },
    },
    test: {
      environment: 'node',
      include: ['tests/**/*.test.js'],
      restoreMocks: true,
      // The HTML exporter inlines processed CSS (?inline); test it as built.
      css: true,
    },
  }
})
