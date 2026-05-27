import { GoogleGenAI } from '@google/genai'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  buildConfigRanges,
  buildModelCapabilities,
  getEffectiveCapabilities,
  loadCapabilities,
} from './capabilities.js'
import { eventFromParts, geminiEvent } from './events.js'
import { buildGeminiContents, buildGeminiTools } from './geminiMapper.js'
import { applyParameterMap } from './request.js'
import { normalizeGeminiUsage, supportsServerSideToolInvocations } from './shared.js'

const runtimeFilename = fileURLToPath(import.meta.url)
const runtimeDirname = path.dirname(runtimeFilename)

export class GeminiProvider {
  constructor(apiKey, systemInstruction, options = {}) {
    const { capabilitiesPath } = options
    this.genAI = new GoogleGenAI({ apiKey })
    this.defaultSystemInstruction = systemInstruction
    this.capabilities = loadCapabilities('gemini', capabilitiesPath, runtimeDirname);
  }

  setDefaultSystemInstruction(systemInstruction) {
    this.defaultSystemInstruction = systemInstruction
  }

  _buildConfig(modelName, request) {
    const requestParameters = request?.parameters || {}
    const options = request?.options || {}
    const tools = request?.tools || {}
    const finalConfig = {}
    const { parameters: effectiveParameters, features, tools: effectiveTools } = getEffectiveCapabilities(this.capabilities, modelName)
    const ranges = buildConfigRanges(effectiveParameters)

    applyParameterMap(
      finalConfig,
      requestParameters,
      this.capabilities?.api?.parameterMap
    )

    if (features?.systemInstruction !== false) {
      finalConfig.systemInstruction =
        request?.systemInstruction || this.defaultSystemInstruction
    }

    finalConfig.tools = buildGeminiTools(tools, effectiveTools)
    if (!finalConfig.tools.length) delete finalConfig.tools

    if (supportsServerSideToolInvocations(modelName)) {
      finalConfig.toolConfig = {
        ...(finalConfig.toolConfig || {}),
        includeServerSideToolInvocations: true,
      }
    }

    if (finalConfig.temperature === undefined || finalConfig.temperature === null) {
      if (ranges.temperature && ranges.temperature.default !== undefined) {
        finalConfig.temperature = ranges.temperature.default
      }
    }

    if (finalConfig.topP === undefined || finalConfig.topP === null) {
      if (ranges.topP && ranges.topP.default !== undefined) {
        finalConfig.topP = ranges.topP.default
      }
    }

    if (finalConfig.topK === undefined || finalConfig.topK === null) {
      if (ranges.topK && ranges.topK.default !== undefined) {
        finalConfig.topK = ranges.topK.default
      }
    }

    if (finalConfig.maxOutputTokens === undefined || finalConfig.maxOutputTokens === null) {
      if (ranges.maxOutputTokens && ranges.maxOutputTokens.default !== undefined) {
        finalConfig.maxOutputTokens = ranges.maxOutputTokens.default
      }
    }

    if (
      requestParameters.thinkingBudget !== undefined ||
      requestParameters.thinkingLevel !== undefined ||
      (ranges.thinkingBudget && ranges.thinkingBudget.default !== undefined)
    ) {
      if (!finalConfig.thinkingConfig) {
        finalConfig.thinkingConfig = {}
      }
      if (requestParameters.thinkingBudget !== undefined) {
        finalConfig.thinkingConfig.thinkingBudget = requestParameters.thinkingBudget
      } else if (finalConfig.thinkingConfig.thinkingBudget === undefined || finalConfig.thinkingConfig.thinkingBudget === null) {
        finalConfig.thinkingConfig.thinkingBudget = ranges.thinkingBudget.default
      }
      if (requestParameters.thinkingLevel !== undefined) {
        finalConfig.thinkingConfig.thinkingLevel = requestParameters.thinkingLevel
      }
    }

    const imageConfigParams = Array.isArray(features?.imageConfigParams)
      ? features.imageConfigParams
      : []
    for (const key of imageConfigParams) {
      if (requestParameters[key] === undefined) continue
      finalConfig.imageConfig = finalConfig.imageConfig || {}
      finalConfig.imageConfig[key] = requestParameters[key]
    }

    if (options.includeThoughts != null) {
      finalConfig.thinkingConfig = finalConfig.thinkingConfig || {}
      finalConfig.thinkingConfig.includeThoughts = !!options.includeThoughts
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
     let ranges = {};
     try {
         const details = await this.genAI.models.get({ model: modelName });
         if (details?.outputTokenLimit) {
             ranges.maxOutputTokens = { type: 'integer', label: 'Max Output Tokens', min: 1, max: Number(details.outputTokenLimit) };
         }
     } catch (e) {
         console.warn(`Failed to fetch model details for ${modelName}:`, e.message);
     }
     return buildModelCapabilities(this.capabilities, modelName, ranges)
  }
}
