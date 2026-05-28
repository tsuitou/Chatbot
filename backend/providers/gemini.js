import { GoogleGenAI } from '@google/genai'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  buildModelCapabilities,
  getEffectiveCapabilities,
  loadCapabilities,
} from './capabilities.js'
import { buildProviderConfig } from './configBuilder.js'
import { eventFromParts, geminiEvent } from './events.js'
import { buildGeminiContents, buildGeminiTools } from './geminiMapper.js'
import { normalizeGeminiUsage, supportsServerSideToolInvocations } from './shared.js'
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
    this.systemInstructionMode =
      normalizeSystemInstructionMode(systemInstructionMode)
    this.capabilities = loadCapabilities('gemini', capabilitiesPath, runtimeDirname);
    this.label = this.capabilities?.label ?? 'Gemini'
    this.modelDetailsCache = new Map()
  }

  setDefaultSystemInstruction(systemInstruction, mode = this.systemInstructionMode) {
    this.defaultSystemInstruction = systemInstruction
    this.systemInstructionMode = normalizeSystemInstructionMode(mode)
  }

  _buildConfig(modelName, request) {
    const requestParameters = request?.parameters || {}
    const tools = request?.tools || {}
    const { parameters: effectiveParameters, features, tools: effectiveTools } = getEffectiveCapabilities(this.capabilities, modelName)
    const finalConfig = buildProviderConfig(effectiveParameters, requestParameters)

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

    return finalConfig;
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
    const sdkRequest = this._buildRequest(request);

    const stream = await this.genAI.models.generateContentStream(sdkRequest);
    for await (const chunk of stream) {
        yield geminiEvent({ chatId: request.chatId, requestId: request.requestId, chunk })
    }
  }
  
  async generate(request) {
     const sdkRequest = this._buildRequest(request);
     
     const result = await this.genAI.models.generateContent(sdkRequest);
     return eventFromParts({
          chatId: request.chatId,
          requestId: request.requestId,
          provider: 'gemini',
          parts: result?.candidates?.[0]?.content?.parts,
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
