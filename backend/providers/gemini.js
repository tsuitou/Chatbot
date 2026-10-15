import { GoogleGenAI } from '@google/genai'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  buildModelCapabilities,
  getEffectiveCapabilities,
  loadCapabilities,
} from './capabilities.js'
import { buildProviderConfig } from './configBuilder.js'
import { eventFromParts } from './events.js'
import {
  FLEX_TIMEOUT_MS,
  generationOptions,
  tierMetadata,
} from './generationOptions.js'
import { finishWriting, writingFunctionDeclaration } from './writing.js'
import { buildGeminiContents, buildGeminiTools } from './geminiMapper.js'
import {
  normalizeGeminiUsage,
  supportsServerSideToolInvocations,
} from './shared.js'
import {
  normalizeSystemInstructionMode,
  resolveSystemInstruction,
} from '../systemInstruction.js'

const runtimeFilename = fileURLToPath(import.meta.url)
const runtimeDirname = path.dirname(runtimeFilename)

export class GeminiProvider {
  constructor(apiKey, systemInstruction, options = {}) {
    const { capabilitiesPath, systemInstructionMode } = options
    this.genAI = new GoogleGenAI({ apiKey })
    this.defaultSystemInstruction = systemInstruction
    this.systemInstructionMode = normalizeSystemInstructionMode(
      systemInstructionMode
    )
    this.capabilities = loadCapabilities(
      'gemini',
      capabilitiesPath,
      runtimeDirname
    )
    this.label = this.capabilities?.label ?? 'Gemini'
    this.modelDetailsCache = new Map()
    this.supportsStreamAbort = true
    this.supportsAbort = true
  }

  setDefaultSystemInstruction(
    systemInstruction,
    mode = this.systemInstructionMode
  ) {
    this.defaultSystemInstruction = systemInstruction
    this.systemInstructionMode = normalizeSystemInstructionMode(mode)
  }

  _buildConfig(modelName, request) {
    const requestParameters = request?.parameters || {}
    const tools = request?.tools || {}
    const {
      parameters: effectiveParameters,
      features,
      tools: effectiveTools,
    } = getEffectiveCapabilities(this.capabilities, modelName)
    const finalConfig = buildProviderConfig(
      effectiveParameters,
      requestParameters
    )
    const { serviceTier, writing } = generationOptions(
      requestParameters,
      effectiveParameters
    )
    if (serviceTier) finalConfig.serviceTier = serviceTier
    if (serviceTier === 'flex') {
      finalConfig.httpOptions = {
        timeout: FLEX_TIMEOUT_MS,
        retryOptions: {
          attempts: 3,
          initialDelay: 2,
          httpStatusCodes: [429, 503],
        },
      }
    }
    if (request.signal) finalConfig.abortSignal = request.signal

    const systemInstruction = resolveSystemInstruction({
      defaultSystemInstruction: this.defaultSystemInstruction,
      userSystemInstruction: request?.systemInstruction,
      mode: this.systemInstructionMode,
    })
    if (features?.systemInstruction !== false && systemInstruction) {
      finalConfig.systemInstruction = systemInstruction
    }

    finalConfig.tools = buildGeminiTools(tools, effectiveTools)
    if (!finalConfig.tools.length) delete finalConfig.tools

    if (
      finalConfig.tools?.length &&
      supportsServerSideToolInvocations(features)
    ) {
      finalConfig.toolConfig = {
        ...(finalConfig.toolConfig || {}),
        includeServerSideToolInvocations: true,
      }
    }

    if (writing) {
      // Writing is a terminal output operation. Built-in tools remain saved in
      // the composer, but are not sent for this request.
      finalConfig.tools = [
        { functionDeclarations: [writingFunctionDeclaration()] },
      ]
      finalConfig.toolConfig = {
        functionCallingConfig: {
          mode: 'ANY',
          allowedFunctionNames: ['submit_writing'],
        },
      }
    }

    return finalConfig
  }

  _buildRequest(request) {
    const modelName = request.model
    return {
      model: modelName,
      contents: buildGeminiContents(request.messages),
      config: this._buildConfig(modelName, request),
    }
  }

  async *generateStream(request) {
    const sdkRequest = this._buildRequest(request)
    const writing =
      sdkRequest.config.toolConfig?.functionCallingConfig?.mode === 'ANY'
    const calls = []
    let finishReason
    const metadata = writing ? { writingFunctionCall: 'pending' } : {}
    const emit = (chunk, parts) =>
      eventFromParts({
        chatId: request.chatId,
        requestId: request.requestId,
        provider: 'gemini',
        parts,
        metadata: { ...metadata },
        usage: normalizeGeminiUsage(chunk?.usageMetadata),
        finishReason: chunk?.candidates?.[0]?.finishReason,
        grounding: chunk?.candidates?.[0]?.groundingMetadata,
      })
    try {
      const stream = await this.genAI.models.generateContentStream(sdkRequest)
      for await (const chunk of stream) {
        const candidate = chunk?.candidates?.[0]
        const parts = candidate?.content?.parts || []
        Object.assign(metadata, tierMetadata(chunk?.usageMetadata?.serviceTier))
        if (candidate?.finishReason) finishReason = candidate.finishReason
        if (writing) {
          for (const part of parts) {
            if (part.functionCall) calls.push(part.functionCall)
          }
          // Never attach a function-call signature to flattened text history.
          yield emit(
            chunk,
            parts
              .filter((p) => p.thought && p.text)
              .map((p) => ({ text: p.text, thought: true }))
          )
        } else {
          yield emit(chunk, parts)
        }
      }
      if (writing) {
        const result = finishWriting(calls, finishReason, ['STOP'])
        Object.assign(metadata, result.metadata)
        yield emit(null, result.parts)
      }
    } catch (error) {
      error.metadata = {
        ...metadata,
        ...(writing ? { writingFunctionCall: 'incomplete' } : {}),
        ...error.metadata,
      }
      throw error
    }
  }

  async generate(request) {
    const sdkRequest = this._buildRequest(request)
    const writing =
      sdkRequest.config.toolConfig?.functionCallingConfig?.mode === 'ANY'
    const result = await this.genAI.models.generateContent(sdkRequest)
    const candidate = result?.candidates?.[0]
    let parts = candidate?.content?.parts || []
    const metadata = tierMetadata(result?.usageMetadata?.serviceTier)
    if (writing) {
      try {
        const output = finishWriting(
          parts.filter((p) => p.functionCall).map((p) => p.functionCall),
          candidate?.finishReason,
          ['STOP']
        )
        parts = [
          ...parts
            .filter((p) => p.thought && p.text)
            .map((p) => ({ text: p.text, thought: true })),
          ...output.parts,
        ]
        Object.assign(metadata, output.metadata)
      } catch (error) {
        error.metadata = { ...metadata, ...error.metadata }
        throw error
      }
    }
    return eventFromParts({
      chatId: request.chatId,
      requestId: request.requestId,
      provider: 'gemini',
      parts,
      metadata,
      usage: normalizeGeminiUsage(result?.usageMetadata),
      finishReason: result?.candidates?.[0]?.finishReason,
      grounding: result?.candidates?.[0]?.groundingMetadata,
    })
  }

  async uploadFile(path, mimeType, displayName) {
      const uploaded = await this.genAI.files.upload({
          file: path,
          config: { mimeType, displayName },
      });
      
      let file = await this.genAI.files.get({ name: uploaded.name });
      let attempts = 0;
      while (file.state === 'PROCESSING' && attempts < 30) {
          await new Promise(r => setTimeout(r, 1000));
          file = await this.genAI.files.get({ name: uploaded.name });
          attempts++;
      }
      
      if (file.state !== 'ACTIVE') {
          throw new Error(`File processing failed: ${file.state}`);
      }
      return file;
  }

  async listModels() {
      const pager = await this.genAI.models.list();
      const names = [];
      for await (const m of pager) {
          names.push(m.name.replace(/^models\//, ''));
      }
      return names;
  }
  
  async getModelCapabilities(modelName) {
     const ranges = {};
     const max = await this._resolveOutputTokenLimit(modelName)
     if (max) {
         ranges.maxOutputTokens = { type: 'integer', label: 'Max Output Tokens', min: 1, max };
     }
     return buildModelCapabilities(this.capabilities, modelName, ranges)
  }

  async _resolveOutputTokenLimit(modelName) {
     if (this.modelDetailsCache.has(modelName)) return this.modelDetailsCache.get(modelName)
     let max = null
     try {
         const details = await this.genAI.models.get({ model: modelName });
         if (details?.outputTokenLimit) max = Number(details.outputTokenLimit)
     } catch (e) {
         console.warn(`Failed to fetch model details for ${modelName}:`, e.message);
     }
     this.modelDetailsCache.set(modelName, max)
     return max
  }
}
