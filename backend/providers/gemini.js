import { GoogleGenAI } from '@google/genai'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const runtimeFilename = fileURLToPath(import.meta.url)
const runtimeDirname = path.dirname(runtimeFilename)

function loadCapabilities(explicitPath) {
  const candidates = [
    explicitPath,
    path.resolve(process.cwd(), 'backend/capabilities/gemini.json'),
    path.resolve(process.cwd(), 'capabilities/gemini.json'), // If cwd is backend/
    path.resolve(runtimeDirname, '../capabilities/gemini.json') // Relative to provider file
  ].filter(Boolean);

  for (const capPath of candidates) {
    try {
      if (fs.existsSync(capPath)) {
        return JSON.parse(fs.readFileSync(capPath, 'utf-8'));
      }
    } catch (e) {
      console.warn(`Failed to load capabilities from ${capPath}:`, e);
    }
  }
  console.warn('No capabilities file found for Gemini.');
  return null;
}

export class GeminiProvider {
  constructor(apiKey, systemInstruction, options = {}) {
    const { capabilitiesPath } = options
    this.genAI = new GoogleGenAI({ apiKey })
    this.defaultSystemInstruction = systemInstruction
    this.capabilities = loadCapabilities(capabilitiesPath);
  }

  setDefaultSystemInstruction(systemInstruction) {
    this.defaultSystemInstruction = systemInstruction
  }

  _normalizeConfig(modelName, userConfig) {
    const finalConfig = { ...userConfig };
    
    if (!finalConfig.systemInstruction) {
        finalConfig.systemInstruction = this.defaultSystemInstruction;
    }
    
    return finalConfig;
  }

  async *generateStream(modelName, contents, config, chatId, requestId) {
    const normalizedConfig = this._normalizeConfig(modelName, config);
    
    const isImageModel = modelName.includes('image');
    
    const request = {
      model: modelName,
      contents,
      ...(isImageModel ? {} : { config: normalizedConfig }),
    }
    
    try {
        const stream = await this.genAI.models.generateContentStream(request);
        
        for await (const chunk of stream) {
            yield {
                chatId,
                requestId,
                parts: chunk.candidates?.[0]?.content?.parts,
                usage: chunk.usageMetadata,
                finishReason: chunk.candidates?.[0]?.finishReason,
                grounding: chunk.candidates?.[0]?.groundingMetadata,
                provider: 'gemini'
            }
        }
    } catch (error) {
        throw error;
    }
  }
  
  async generate(modelName, contents, config, chatId, requestId) {
     const normalizedConfig = this._normalizeConfig(modelName, config);
     
     const isImageModel = modelName.includes('image');
     
     const request = {
        model: modelName,
        contents,
        ...(isImageModel ? {} : { config: normalizedConfig }),
     }
     
     const result = await this.genAI.models.generateContent(request);
     return {
          chatId,
          requestId,
          parts: result?.candidates?.[0]?.content?.parts,
          usage: result?.usageMetadata,
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

  async listModels(filterKeywords = []) {
      const pager = await this.genAI.models.list();
      const names = [];
      for await (const m of pager) {
          if (filterKeywords.length === 0 || filterKeywords.some(k => m.name.includes(k.trim()))) {
              names.push(m.name.replace(/^models\//, ''));
          }
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

     const models = Array.isArray(this.capabilities?.models) ? this.capabilities.models : [];
     const capModel = models.find(m => modelName.includes(m.modelQuery));
     
     const capDefaults = this.capabilities?.defaults?.parameters || {};
     const capDefaultFeatures = this.capabilities?.defaults?.features || {};
     
     const effectiveParams = { ...capDefaults, ...(capModel?.parameters || {}) };
     const effectiveFeatures = { ...capDefaultFeatures, ...(capModel?.features || {}) };
     
     ranges.features = effectiveFeatures;

     for (const [key, def] of Object.entries(effectiveParams)) {
         if (def.range) {
             ranges[key] = { ...(ranges[key] || {}), ...def.range };
         } else if (def.options) {
             ranges[key] = { ...(ranges[key] || {}), options: def.options };
         }
         
         if (def.specialValues) {
             ranges[key] = { ...(ranges[key] || {}), specialValues: def.specialValues };
         }

         if (def.type) ranges[key] = { ...(ranges[key] || {}), type: def.type };
         if (def.label) ranges[key] = { ...(ranges[key] || {}), label: def.label };
     }
     
     return ranges;
  }
}
