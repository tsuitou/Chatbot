import { describe, it, expect } from 'vitest'
import {
  defaultFileText,
  defaultSettingValue,
  emptyConfig,
  hashText,
  isFileOutdated,
  resolveConfig,
  validateFile,
} from '../../../src/services/local/config'

describe('local config', () => {
  it('falls back to the build defaults for blank settings and unedited files', () => {
    const config = emptyConfig()
    config.settings.claudeModelFilter = '  '
    config.settings.openrouterModels = 'a/b'
    const resolved = resolveConfig(config)
    expect(resolved.settings.claudeModelFilter).toBe(
      defaultSettingValue('claudeModelFilter')
    )
    expect(resolved.settings.openrouterModels).toBe('a/b')
    expect(resolved.defaultSystemInstruction).toBe(
      defaultFileText('systemInstruction')
    )
    expect(resolved.openaiCompatConfig).toEqual([])
  })

  it('uses saved files as they are', () => {
    const config = emptyConfig()
    config.files.systemInstruction = { text: 'mine', baseHash: 'x' }
    config.files.openaiEndpoints = {
      text: '{"baseUrl":"https://x/v1"}',
      baseHash: 'x',
    }
    const resolved = resolveConfig(config)
    expect(resolved.defaultSystemInstruction).toBe('mine')
    expect(resolved.openaiCompatConfig).toEqual({ baseUrl: 'https://x/v1' })
  })

  it('flags a saved file whose default has changed since', () => {
    const config = emptyConfig()
    expect(isFileOutdated(config, 'systemInstruction')).toBe(false)
    config.files.systemInstruction = {
      text: 'mine',
      baseHash: hashText(defaultFileText('systemInstruction')),
    }
    expect(isFileOutdated(config, 'systemInstruction')).toBe(false)
    config.files.systemInstruction.baseHash = hashText('an older default')
    expect(isFileOutdated(config, 'systemInstruction')).toBe(true)
  })

  it('validates the endpoints file', () => {
    expect(validateFile('openaiEndpoints', '')).toBeNull()
    expect(validateFile('openaiEndpoints', '[]')).toBeNull()
    expect(
      validateFile('openaiEndpoints', '[{"baseUrl":"https://x/v1"}]')
    ).toBeNull()
    expect(validateFile('openaiEndpoints', '{')).toMatch(/Invalid JSON/)
    expect(validateFile('openaiEndpoints', '[{"label":"x"}]')).toMatch(
      /baseUrl/
    )
    expect(validateFile('openaiEndpoints', '[1]')).toMatch(/object/)
    expect(validateFile('systemInstruction', '{')).toBeNull()
  })
})
