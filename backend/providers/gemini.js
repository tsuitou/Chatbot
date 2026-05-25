import { GoogleGenAI } from '@google/genai'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  buildConfigRanges,
  getEffectiveCapabilities,
  loadCapabilities,
} from './capabilities.js'
import { supportsServerSideToolInvocations, normalizeGeminiUsage } from './shared.js'

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

  _normalizeConfig(modelName, userConfig) {
    const finalConfig = { ...userConfig };

    const { parameters, features } = getEffectiveCapabilities(this.capabilities, modelName)
    const ranges = buildConfigRanges(parameters, features)

    if (features?.systemInstruction !== false && !finalConfig.systemInstruction) {
      finalConfig.systemInstruction = this.defaultSystemInstruction;
    }

    if (features?.tools === false) {
      delete finalConfig.tools
      delete finalConfig.toolConfig
    } else if (supportsServerSideToolInvocations(modelName)) {
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

    if (ranges.thinkingBudget && ranges.thinkingBudget.default !== undefined) {
      if (!finalConfig.thinkingConfig) {
        finalConfig.thinkingConfig = {}
      }
      if (finalConfig.thinkingConfig.thinkingBudget === undefined || finalConfig.thinkingConfig.thinkingBudget === null) {
        finalConfig.thinkingConfig.thinkingBudget = ranges.thinkingBudget.default
      }
    }

    const imageConfigParams = Array.isArray(features?.imageConfigParams)
      ? features.imageConfigParams
      : []
    for (const key of imageConfigParams) {
      if (finalConfig[key] === undefined) continue
      finalConfig.imageConfig = finalConfig.imageConfig || {}
      finalConfig.imageConfig[key] = finalConfig[key]
      delete finalConfig[key]
    }

    return finalConfig;
  }

  async *generateStream(modelName, contents, config, chatId, requestId) {
    const normalizedConfig = this._normalizeConfig(modelName, config);

    const request = {
      model: modelName,
      contents,
      config: normalizedConfig,
    }
    
    const stream = await this.genAI.models.generateContentStream(request);
    for await (const chunk of stream) {
        yield {
            chatId,
            requestId,
            parts: chunk.candidates?.[0]?.content?.parts,
            usage: normalizeGeminiUsage(chunk.usageMetadata),
            finishReason: chunk.candidates?.[0]?.finishReason,
            grounding: chunk.candidates?.[0]?.groundingMetadata,
            provider: 'gemini'
        }
    }
  }
  
  async generate(modelName, contents, config, chatId, requestId) {
     const normalizedConfig = this._normalizeConfig(modelName, config);

     const request = {
        model: modelName,
        contents,
        config: normalizedConfig,
     }
     
     const result = await this.genAI.models.generateContent(request);
     return {
          chatId,
          requestId,
          parts: result?.candidates?.[0]?.content?.parts,
          usage: normalizeGeminiUsage(result?.usageMetadata),
          finishReason: result?.candidates?.[0]?.finishReason,
          grounding: result?.candidates?.[0]?.groundingMetadata,
          provider: 'gemini'
     }
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
  
  async getModelConfigRanges(modelName) {
     let maxOutputTokens = null;
     try {
         const details = await this.genAI.models.get({ model: modelName });
         if (details?.outputTokenLimit) {
             maxOutputTokens = Number(details.outputTokenLimit);
         }
     } catch (e) {
         console.warn(`Failed to fetch model details for ${modelName}:`, e.message);
     }

     const ranges = {};
     if (maxOutputTokens) {
          ranges.maxOutputTokens = { type: 'integer', label: 'Max Output Tokens', min: 1, max: maxOutputTokens };
     }

     const { parameters, features } = getEffectiveCapabilities(this.capabilities, modelName)
     return buildConfigRanges(parameters, features, ranges);
  }
}
