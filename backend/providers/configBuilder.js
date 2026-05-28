function hasValue(value) {
  return value !== undefined && value !== null && value !== ''
}

function setPath(target, path, value) {
  if (!path || !hasValue(value)) return
  const keys = String(path).split('.').filter(Boolean)
  if (!keys.length) return

  let cursor = target
  for (const key of keys.slice(0, -1)) {
    if (!cursor[key] || typeof cursor[key] !== 'object' || Array.isArray(cursor[key])) {
      cursor[key] = {}
    }
    cursor = cursor[key]
  }
  cursor[keys[keys.length - 1]] = value
}

function resolveParameterValue(requestParameters, key, definition) {
  if (Object.prototype.hasOwnProperty.call(requestParameters, key)) {
    const requested = requestParameters[key]
    return hasValue(requested) ? requested : undefined
  }
  return hasValue(definition?.default) ? definition.default : undefined
}

export function buildProviderConfig(parameterDefinitions, requestParameters = {}, transforms = {}) {
  const config = {}
  const deferred = []

  for (const [key, definition] of Object.entries(parameterDefinitions || {})) {
    const api = definition?.api || null
    if (!api) continue

    const value = resolveParameterValue(requestParameters, key, definition)
    if (value === undefined) continue

    if (api.path) {
      setPath(config, api.path, value)
      continue
    }

    if (api.transform) {
      deferred.push({ name: api.transform, value, key, definition })
    }
  }

  for (const { name, value, key, definition } of deferred) {
    const transform = transforms[name]
    if (typeof transform !== 'function') {
      throw new Error(`Unknown config transform: ${name}`)
    }
    transform({ config, value, key, definition, requestParameters })
  }

  return config
}
