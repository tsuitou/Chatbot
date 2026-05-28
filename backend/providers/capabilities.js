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

// Selects the most specific model entry whose `modelQuery` is a substring of
// the model name. Specificity = explicit `priority` first, then longest query,
// so authoring order in the JSON is irrelevant: `2.5-flash-lite` beats
// `2.5-flash` by length, and `image` overrides its base family via priority.
export function getEffectiveCapabilities(capabilities, modelName) {
  const models = Array.isArray(capabilities?.models) ? capabilities.models : []
  const name = String(modelName || '')
  const capModel =
    models
      .filter((model) => model.modelQuery && name.includes(model.modelQuery))
      .sort(
        (a, b) =>
          (b.priority ?? 0) - (a.priority ?? 0) ||
          b.modelQuery.length - a.modelQuery.length
      )[0] || null

  return {
    provider: capabilities?.provider,
    label: capabilities?.label,
    parameters: deepMerge(capabilities?.defaults?.parameters, capModel?.parameters),
    features: deepMerge(capabilities?.defaults?.features, capModel?.features),
    tools: deepMerge(capabilities?.defaults?.tools, capModel?.tools),
    attachments: deepMerge(capabilities?.defaults?.attachments, capModel?.attachments),
    model: capModel || null,
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function deepMerge(base = {}, override = {}) {
  const result = { ...(base || {}) }
  for (const [key, value] of Object.entries(override || {})) {
    if (value === null || value === undefined) {
      delete result[key]
    } else if (isPlainObject(value) && isPlainObject(result[key])) {
      result[key] = deepMerge(result[key], value)
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
    parameters: buildParameterDisplay(effective.parameters, seed),
    tools: effective.tools,
    attachments: effective.attachments,
  }
}

// Flattens each parameter's `ui` block (with nested `range`) into the flat
// { type, label, min, max, step, options, specialValues, default } shape the
// frontend renders. The `api` block is dropped — it is consumption-only.
export function buildParameterDisplay(parameterDefs, seed = {}) {
  const display = { ...seed }

  for (const [key, def] of Object.entries(parameterDefs || {})) {
    if (def === null || def === undefined) {
      delete display[key]
      continue
    }
    const { range, ...rest } = def.ui || {}
    display[key] = {
      ...(display[key] || {}),
      ...rest,
      ...(range || {}),
    }
    if (def.default !== undefined) display[key].default = def.default
  }

  return display
}
