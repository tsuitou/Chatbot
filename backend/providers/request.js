export function appendIfDefined(target, key, value) {
  if (value === undefined || value === null || value === '') return
  target[key] = value
}

export function applyParameterMap(target, parameters = {}, parameterMap = {}) {
  for (const [sourceKey, targetKey] of Object.entries(parameterMap || {})) {
    appendIfDefined(target, targetKey, parameters[sourceKey])
  }
}

export function mergeText(existing, next) {
  const parts = []
  if (existing) parts.push(existing)
  if (next) parts.push(next)
  return parts.join('\n\n')
}
