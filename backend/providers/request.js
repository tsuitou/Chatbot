export function mergeText(existing, next) {
  const parts = []
  if (existing) parts.push(existing)
  if (next) parts.push(next)
  return parts.join('\n\n')
}
