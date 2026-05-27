import fs from 'fs'
import path from 'path'

export function loadCapabilities(providerId, explicitPath, runtimeDirname) {
  const filename = `${providerId}.json`
  const candidates = [
    explicitPath,
    path.resolve(process.cwd(), 'backend/capabilities', filename),
    path.resolve(process.cwd(), 'capabilities', filename),
    runtimeDirname
      ? path.resolve(runtimeDirname, '../capabilities', filename)
      : null,
  ].filter(Boolean)

  for (const capPath of candidates) {
    try {
      if (fs.existsSync(capPath)) {
        return JSON.parse(fs.readFileSync(capPath, 'utf-8'))
      }
    } catch (error) {
      console.warn(`Failed to load capabilities from ${capPath}:`, error)
    }
  }

  console.warn(`No capabilities file found for ${providerId}.`)
  return null
}

export function getEffectiveCapabilities(capabilities, modelName) {
  const models = Array.isArray(capabilities?.models) ? capabilities.models : []
  const capModel = models.find((model) =>
    String(modelName || '').includes(model.modelQuery)
  )
  const parameters = mergeSection(
    capabilities?.defaults?.parameters,
    capModel?.parameters
  )
  const features = mergeSection(
    capabilities?.defaults?.features,
    capModel?.features
  )
  const options = mergeSection(
    capabilities?.defaults?.options,
    capModel?.options
  )
  const tools = mergeSection(capabilities?.defaults?.tools, capModel?.tools)
  const attachments = {
    ...(capabilities?.defaults?.attachments || {}),
    ...(capModel?.attachments || {}),
  }

  return {
    provider: capabilities?.provider,
    label: capabilities?.label,
    parameters,
    features,
    options,
    tools,
    attachments,
    model: capModel || null,
  }
}

function mergeSection(defaults = {}, overrides = {}) {
  const result = { ...(defaults || {}) }
  for (const [key, value] of Object.entries(overrides || {})) {
    if (value === null || value === undefined) {
      delete result[key]
    } else if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      result[key] &&
      typeof result[key] === 'object' &&
      !Array.isArray(result[key])
    ) {
      result[key] = { ...result[key], ...value }
    } else {
      result[key] = value
    }
  }
  return result
}

export function buildModelCapabilities(capabilities, modelName, seed = {}) {
  const effective = getEffectiveCapabilities(capabilities, modelName)
  return {
    provider: effective.provider,
    label: effective.label,
    model: modelName,
    features: effective.features,
    parameters: buildConfigRanges(effective.parameters, seed),
    options: effective.options,
    tools: effective.tools,
    attachments: effective.attachments,
  }
}

export function buildConfigRanges(effectiveParams, seed = {}) {
  const ranges = { ...seed }

  for (const [key, def] of Object.entries(effectiveParams || {})) {
    if (def === null || def === undefined) {
      delete ranges[key]
      continue
    }
    if (def.range) ranges[key] = { ...(ranges[key] || {}), ...def.range }
    if (def.options) ranges[key] = { ...(ranges[key] || {}), options: def.options }
    if (def.specialValues) {
      ranges[key] = { ...(ranges[key] || {}), specialValues: def.specialValues }
    }
    if (def.type) ranges[key] = { ...(ranges[key] || {}), type: def.type }
    if (def.label) ranges[key] = { ...(ranges[key] || {}), label: def.label }
    if (def.default !== undefined) {
      ranges[key] = { ...(ranges[key] || {}), default: def.default }
    }
  }

  return ranges
}
