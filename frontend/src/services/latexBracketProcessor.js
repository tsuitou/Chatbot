import balanced from 'balanced-match'

const containsLatexRegex = /\\\(.*?\\\)|\\\[.*?\\\]|\$.*?\$|\\begin\{equation\}.*?\\end\{equation\}/s
const PROTECTED_PREFIX = '__LATEX_PROTECTED__'
const BLOCK_TOKEN_PREFIX = '@@KATEX_BLOCK_'
const INLINE_TOKEN_PREFIX = '@@KATEX_INLINE_'

export function normalizeLatexBrackets(text) {
  if (typeof text !== 'string' || !containsLatexRegex.test(text)) {
    return { text, block: [], inline: [] }
  }

  const protectedItems = []
  let workingText = protectSegments(text, protectedItems)

  const blockPlaceholders = []
  workingText = convertDelimited(workingText, '\\[', '\\]', (body) => {
    const trimmed = body.trim()
    if (!trimmed) return null
    const token = `${BLOCK_TOKEN_PREFIX}${blockPlaceholders.length}@@`
    blockPlaceholders.push({ token, value: trimmed })
    return `\n\n${token}\n\n`
  })

  const inlinePlaceholders = []
  workingText = convertDelimited(workingText, '\\(', '\\)', (body) => {
    const trimmed = body.trim()
    if (!trimmed) return null
    const token = `${INLINE_TOKEN_PREFIX}${inlinePlaceholders.length}@@`
    inlinePlaceholders.push({ token, value: trimmed })
    return token
  })

  const restoredText = restoreSegments(workingText, protectedItems)
  return { text: restoredText, block: blockPlaceholders, inline: inlinePlaceholders }
}

function protectSegments(text, bucket) {
  return text
    .replace(/((`{3,}|~{3,})[\s\S]*?\2|`[^`]*`)/g, (match) => storeProtected(match, bucket))
    .replace(/\[([^\[\]]*(?:\[[^\]]*\][^\[\]]*)*)\]\([^)]*?\)/g, (match) =>
      storeProtected(match, bucket)
    )
}

function storeProtected(match, bucket) {
  const token = `${PROTECTED_PREFIX}${bucket.length}__`
  bucket.push(match)
  return token
}

function restoreSegments(text, bucket) {
  return text.replace(new RegExp(`${PROTECTED_PREFIX}(\\d+)__`, 'g'), (match, indexStr) => {
    const index = Number.parseInt(indexStr, 10)
    if (Number.isNaN(index) || index < 0 || index >= bucket.length) {
      return match
    }
    return bucket[index]
  })
}

function convertDelimited(source, open, close, replacer) {
  let rest = source
  let result = ''

  while (rest.length > 0) {
    const idx = rest.indexOf(open)
    if (idx === -1) {
      result += rest
      break
    }

    if (isEscaped(rest, idx)) {
      result += rest.slice(0, idx + open.length)
      rest = rest.slice(idx + open.length)
      continue
    }

    const slice = rest.slice(idx)
    const match = balanced(open, close, slice)
    if (!match) {
      result += rest
      break
    }

    result += rest.slice(0, idx)
    const replacement = replacer(match.body)
    if (typeof replacement === 'string') {
      result += replacement
    } else {
      result += open + match.body + close
    }
    rest = match.post
  }

  return result
}

function isEscaped(str, index) {
  let backslashCount = 0
  for (let i = index - 1; i >= 0; i -= 1) {
    if (str[i] === '\\') {
      backslashCount += 1
    } else {
      break
    }
  }
  return backslashCount % 2 === 1
}
