import { createRuntime } from '@backend/runtime.js'
import gemini from '@backend/capabilities/gemini.json'
import claude from '@backend/capabilities/claude.json'
import openrouter from '@backend/capabilities/openrouter.json'
import openaiCompat from '@backend/capabilities/openai-compat.json'
import { loadConfig, resolveConfig } from './config'

// The same provider runtime the server uses, configured from the browser's
// stored settings. Built once per page load; saving settings reloads the page.

/** @type {Promise<ReturnType<typeof createRuntime>> | null} */
let runtimePromise = null

async function buildRuntime() {
  const { keys, settings, defaultSystemInstruction, openaiCompatConfig } =
    resolveConfig(await loadConfig())
  return createRuntime({
    keys,
    settings,
    capabilities: {
      gemini,
      claude,
      openrouter,
      'openai-compat': openaiCompat,
    },
    openaiCompatConfig,
    defaultSystemInstruction,
    // Requests go straight from the browser with the user's own keys.
    clientOptions: { dangerouslyAllowBrowser: true },
  })
}

export function getRuntime() {
  if (!runtimePromise) {
    runtimePromise = buildRuntime().catch((error) => {
      runtimePromise = null
      throw error
    })
  }
  return runtimePromise
}
