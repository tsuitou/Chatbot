function normalizeOption(option) {
  if (!option || typeof option !== 'object') return null
  if (option.value === undefined) return null
  return {
    label: option.label ?? String(option.value),
    value: option.value,
  }
}

function normalizeOptions(options) {
  return Array.isArray(options)
    ? options.map(normalizeOption).filter(Boolean)
    : []
}

export function normalizeDynamicParameters(capabilities) {
  const parameters = capabilities?.parameters || {}
  return Object.entries(parameters)
    .filter(([, definition]) => definition && typeof definition === 'object')
    .map(([key, definition]) => {
      const base = {
        key,
        label: definition.label || key,
        default: definition.default,
      }

      if (definition.type === 'enum') {
        return {
          ...base,
          type: 'enum',
          options: normalizeOptions(definition.options),
        }
      }

      if (definition.type === 'string') {
        return { ...base, type: 'string' }
      }

      if (definition.type === 'boolean') {
        return { ...base, type: 'boolean' }
      }

      const hasRange =
        definition.min !== undefined && definition.max !== undefined
      const specialValues = normalizeOptions(definition.specialValues)

      if (!hasRange && specialValues.length > 0) {
        return { ...base, type: 'enum', options: specialValues }
      }

      const hintParts = [
        ...specialValues.map((value) => `${value.label} (${value.value})`),
        ...(hasRange ? [`${definition.min} - ${definition.max}`] : []),
      ]

      return {
        ...base,
        type: definition.type || 'number',
        min: definition.min,
        max: definition.max,
        step: definition.step ?? (definition.type === 'integer' ? 1 : 0.1),
        hint: hintParts.join(', '),
        disabled: !hasRange && specialValues.length === 0,
      }
    })
}
