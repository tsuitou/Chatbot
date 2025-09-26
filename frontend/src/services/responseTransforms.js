const REPLACE_PATTERN = /^\s*replace\s+"([\s\S]*?)"\s*->\s*"([\s\S]*?)"\s*$/i
const REMOVE_PATTERN = /^\s*remove\s+"([\s\S]*?)"\s*$/i

export function parseTransformScript(script) {
  const lines = typeof script === 'string' ? script.split(/\r?\n/) : []
  const rules = []
  const errors = []

  lines.forEach((line, index) => {
    const trimmed = line.trim()
    if (!trimmed) return
    const replaceMatch = REPLACE_PATTERN.exec(trimmed)
    if (replaceMatch) {
      const [, pattern, replacement] = replaceMatch
      rules.push({
        type: 'replace',
        pattern,
        replacement,
        applyOrder: rules.length,
      })
      return
    }
    const removeMatch = REMOVE_PATTERN.exec(trimmed)
    if (removeMatch) {
      const [, pattern] = removeMatch
      rules.push({
        type: 'remove',
        pattern,
        applyOrder: rules.length,
      })
      return
    }
    errors.push({ line: index + 1, content: line })
  })

  return { rules, errors }
}

export function applyResponseTransforms(text, transforms) {
  if (
    typeof text !== 'string' ||
    !Array.isArray(transforms) ||
    !transforms.length
  ) {
    return text
  }
  let result = text
  const ordered = [...transforms].sort((a, b) => {
    const aOrder = typeof a.applyOrder === 'number' ? a.applyOrder : 0
    const bOrder = typeof b.applyOrder === 'number' ? b.applyOrder : 0
    return aOrder - bOrder
  })

  for (const transform of ordered) {
    if (!transform?.pattern) continue
    if (transform.type === 'remove') {
      result = result.split(transform.pattern).join('')
      continue
    }
    if (transform.type === 'replace') {
      const replacement = transform.replacement ?? ''
      result = result.split(transform.pattern).join(replacement)
    }
  }

  return result
}
