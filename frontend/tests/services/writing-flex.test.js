import { describe, it, expect } from 'vitest'
import {
  normalizeSettingsEntry,
  cloneSettings,
  serializeSettings,
} from '../../src/services/modelConfig'
import { createApiRequest } from '../../src/services/apiAdapter'
import {
  buildMetadataLines,
  buildMetadataHtmlForExport,
} from '../../src/services/messageMetadata'
import { prepareRequestMessages } from '../../src/services/chatFlow'
import { buildGeminiContents } from '../../../backend/providers/geminiMapper.js'

describe('writing function call history', () => {
  it('failed writing stays out of model history while completed writing is retained', () => {
    const historyMessages = [
      { id: 'user', sender: 'user' },
      {
        id: 'bad',
        sender: 'model',
        status: 'completed',
        metadata: { writingFunctionCall: 'invalid' },
      },
      {
        id: 'good',
        sender: 'model',
        status: 'completed',
        metadata: { writingFunctionCall: 'used' },
      },
    ]
    const messages = prepareRequestMessages({
      historyMessages,
      autoMessages: { pre: [], post: [] },
      anchorSequence: 10,
    })
    expect(messages.map((message) => message.id)).toEqual(['user', 'good'])
  })

  it('writing result is resent as ordinary text without its call signature, including after reload', async () => {
    const message = JSON.parse(
      JSON.stringify({
        sender: 'model',
        sequence: 1,
        content: { text: '作品\n"Quoted" \\ end' },
        configSnapshot: { parameters: { writingFunctionCall: true } },
        metadata: {
          writingFunctionCall: 'used',
          thoughtSignatures: [{ signature: 'call-signature' }],
        },
      })
    )
    const payload = await createApiRequest({
      model: 'gemini-2.5-flash',
      messages: [message],
      requestConfig: {
        parameters: { serviceTier: 'flex', writingFunctionCall: true },
      },
    })
    expect(payload.parameters).toEqual({
      serviceTier: 'flex',
      writingFunctionCall: true,
    })
    expect(payload.messages[0].parts).toEqual([
      { type: 'text', text: message.content.text },
    ])
    expect(buildGeminiContents(payload.messages)[0]).toEqual({
      role: 'model',
      parts: [{ text: message.content.text }],
    })
  })

  it('normal text history still resends its signature', async () => {
    const payload = await createApiRequest({
      model: 'gemini-2.5-flash',
      messages: [
        {
          sender: 'model',
          content: { text: 'normal' },
          metadata: { thoughtSignatures: [{ signature: 'text-sig' }] },
        },
      ],
    })
    expect(
      buildGeminiContents(payload.messages)[0].parts[0].thoughtSignature
    ).toBe('text-sig')
  })
})

describe('model settings', () => {
  it('round-trip preserves independent Flex and writing choices', () => {
    for (const serviceTier of ['standard', 'flex']) {
      for (const writingFunctionCall of [false, true]) {
        const settings = {
          providerId: 'gemini',
          parameters: { serviceTier, writingFunctionCall },
        }
        const restored = normalizeSettingsEntry(
          JSON.parse(JSON.stringify(serializeSettings(settings)))
        )
        expect(restored.parameters).toEqual(settings.parameters)
        const clone = cloneSettings(restored)
        clone.parameters.writingFunctionCall = !writingFunctionCall
        expect(restored.parameters.writingFunctionCall).toBe(
          writingFunctionCall
        )
      }
    }
  })
})

describe('message metadata', () => {
  it('shows only actual tier and writing outcome; settings alone do not claim success', () => {
    const message = {
      configSnapshot: {
        parameters: { serviceTier: 'flex', writingFunctionCall: true },
      },
    }
    expect(buildMetadataLines(message)).toEqual(['Tier: Unknown'])
    message.metadata = { serviceTier: 'flex', writingFunctionCall: 'used' }
    expect(buildMetadataLines(message)).toEqual([
      'Tier: Flex, Writing FC: Used',
    ])
    expect(buildMetadataHtmlForExport(message)).toBe(
      '<div class="metadata-item">Tier: Flex, Writing FC: Used</div>'
    )
    message.metadata = {
      serviceTier: 'standard',
      writingFunctionCall: 'invalid',
    }
    expect(buildMetadataLines(message)).toEqual([
      'Tier: Standard, Writing FC: Invalid',
    ])
    expect(
      buildMetadataLines({ metadata: { serviceTier: 'standard' } })
    ).toEqual([])
  })

  it('makes failed or interrupted function calls visible', () => {
    for (const [status, label] of [
      ['not_used', 'Not used'],
      ['invalid', 'Invalid'],
      ['incomplete', 'Incomplete'],
    ]) {
      expect(
        buildMetadataLines({ metadata: { writingFunctionCall: status } })
      ).toEqual([`Writing FC: ${label}`])
    }
    expect(
      buildMetadataLines({
        status: 'cancelled',
        metadata: { writingFunctionCall: 'pending' },
      })
    ).toEqual(['Writing FC: Incomplete'])
  })
})
