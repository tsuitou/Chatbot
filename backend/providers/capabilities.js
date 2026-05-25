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
  const parameters = {
    ...(capabilities?.defaults?.parameters || {}),
    ...(capModel?.parameters || {}),
  }
  const features = {
    ...(capabilities?.defaults?.features || {}),
    ...(capModel?.features || {}),
  }

  return { parameters, features, model: capModel || null }
}

export function buildConfigRanges(effectiveParams, effectiveFeatures, seed = {}) {
  const ranges = { ...seed, features: effectiveFeatures }

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
