import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkBreaks from 'remark-breaks'
import remarkMath from 'remark-math'
import remarkRehype from 'remark-rehype'
import rehypeKatex from 'rehype-katex'
import rehypeStringify from 'rehype-stringify'
import remarkGfm from 'remark-gfm'
import { visit } from 'unist-util-visit'
import { normalizeLatexBrackets } from './latexBracketProcessor.js'
import { isSafeUrl } from './htmlSafety.js'
import hljs from 'highlight.js'

const segmentProcessor = unified()
  .use(remarkGfm)
  .use(remarkBreaks)
  .use(remarkMath, { singleDollarTextMath: false })
  .use(remarkRehype, { allowDangerousHtml: false })
  .use(rehypeKatex)
  .use(rehypeStringify)

const parseProcessor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkBreaks)
  .use(remarkMath, { singleDollarTextMath: false })

// Every plugin in the pipeline is synchronous, so rendering can happen inside
// a computed; the async form remains for existing callers.
export async function parseModelResponse(rawText) {
  return parseModelResponseSync(rawText)
}

export function parseModelResponseSync(rawText) {
  if (!rawText) return []
  const {
    text: latexNormalizedText,
    block: blockPlaceholders,
    inline,
  } = normalizeLatexBrackets(rawText)
  const normalizedText = splitTrailingFence(latexNormalizedText)
  const segments = []
  const tree = parseProcessor.parse(normalizedText)
  sanitizeMarkdownUrls(tree)
  injectPlaceholderMath(tree, blockPlaceholders, inline)
  let nonCodeNodesBuffer = []

  const processNonCodeNodes = () => {
    if (nonCodeNodesBuffer.length > 0) {
      /** @type {Parameters<typeof segmentProcessor.run>[0]} */
      const segmentTree = { type: 'root', children: nonCodeNodesBuffer }
      const file = segmentProcessor.runSync(segmentTree)
      const html = segmentProcessor.stringify(file)

      segments.push({
        type: 'plaintext',
        htmlContent: html,
      })
      nonCodeNodesBuffer = []
    }
  }

  for (const node of tree.children) {
    if (node.type === 'code') {
      processNonCodeNodes()
      const id = String(node.lang ?? '')
        .trim()
        .replace(/^\{?\.?(language-|lang-)/, '')
        .replace(/^source-/, '')
        .replace(/[{}]/g, '')
        .split(/\s+/)[0]
        .toLowerCase()
      const lang =
        id === 'mermaid' || id === 'svg'
          ? id
          : hljs.getLanguage(id)
            ? id
            : 'plaintext'

      segments.push({
        type: 'code',
        content: node.value,
        lang,
      })
    } else {
      nonCodeNodesBuffer.push(node)
    }
  }

  processNonCodeNodes()
  return segments
}

function sanitizeMarkdownUrls(tree) {
  visit(tree, (node, index, parent) => {
    if (!node || typeof node !== 'object') return
    if (!['link', 'image', 'definition'].includes(node.type)) return
    if (isSafeUrl(node.url)) return

    if (node.type === 'definition') {
      node.url = ''
      return
    }

    if (
      !parent ||
      typeof index !== 'number' ||
      !Array.isArray(parent.children)
    ) {
      node.url = ''
      return
    }

    if (node.type === 'link') {
      parent.children.splice(index, 1, ...(node.children || []))
      return index
    }

    parent.children.splice(index, 1, {
      type: 'text',
      value: node.alt || '',
    })
    return index
  })
}

function splitTrailingFence(src) {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const out = []
  const re = /^(.+?\S)(`{3,}|~{3,})[ \t]*$/

  for (const line of lines) {
    const m = line.match(re)
    if (m) {
      const body = m[1]
      const fence = m[2]
      out.push(body)
      out.push(fence)
    } else {
      out.push(line)
    }
  }
  return out.join('\n')
}

function injectPlaceholderMath(tree, blockPlaceholders, inlinePlaceholders) {
  if (!blockPlaceholders.length && !inlinePlaceholders.length) return

  if (blockPlaceholders.length) {
    const blockMap = new Map(
      blockPlaceholders.map(({ token, value }) => [token, value])
    )
    replaceBlockPlaceholderParagraphs(tree, blockMap)
  }

  if (!inlinePlaceholders.length) return

  const inlineMap = new Map(
    inlinePlaceholders.map(({ token, value }) => [token, value])
  )
  const inlinePattern = new RegExp(
    inlinePlaceholders.map(({ token }) => escapeRegex(token)).join('|'),
    'g'
  )

  visit(tree, 'text', (node, index, parent) => {
    if (!parent || typeof index !== 'number') return
    if (parent.type === 'code' || parent.type === 'inlineCode') return
    const value = node.value
    inlinePattern.lastIndex = 0
    if (!inlinePattern.test(value)) return
    inlinePattern.lastIndex = 0

    const segments = splitByTokens(value, inlinePattern)
    if (!segments.length) return

    const nextNodes = segments.map((segment) => {
      if (segment.type === 'text') {
        return { type: 'text', value: segment.value }
      }
      const mathValue = inlineMap.get(segment.token)
      return createInlineMathNode(mathValue)
    })

    parent.children.splice(index, 1, ...nextNodes)
    return index + nextNodes.length
  })
}

function replaceBlockPlaceholderParagraphs(parent, blockMap) {
  if (!parent || !Array.isArray(parent.children)) return

  parent.children = parent.children.map((child) => {
    if (
      child?.type === 'paragraph' &&
      Array.isArray(child.children) &&
      child.children.length === 1 &&
      child.children[0]?.type === 'text'
    ) {
      const tokenCandidate = child.children[0].value.trim()
      if (blockMap.has(tokenCandidate)) {
        return createDisplayMathNode(blockMap.get(tokenCandidate))
      }
    }

    replaceBlockPlaceholderParagraphs(child, blockMap)
    return child
  })
}

function splitByTokens(value, pattern) {
  const segments = []
  let lastIndex = 0
  value.replace(pattern, (match, offset) => {
    if (offset > lastIndex) {
      segments.push({ type: 'text', value: value.slice(lastIndex, offset) })
    }
    segments.push({ type: 'token', token: match })
    lastIndex = offset + match.length
    return match
  })

  if (!segments.length) {
    return []
  }

  if (lastIndex < value.length) {
    segments.push({ type: 'text', value: value.slice(lastIndex) })
  }

  return segments.filter(
    (segment) => segment.type !== 'text' || segment.value.length
  )
}

function createDisplayMathNode(value) {
  return {
    type: 'math',
    meta: null,
    value,
    data: {
      hName: 'pre',
      hChildren: [
        {
          type: 'element',
          tagName: 'code',
          properties: { className: ['language-math', 'math-display'] },
          children: [{ type: 'text', value }],
        },
      ],
    },
  }
}

function createInlineMathNode(value) {
  return {
    type: 'inlineMath',
    value,
    data: {
      hName: 'code',
      hProperties: { className: ['language-math', 'math-inline'] },
      hChildren: [{ type: 'text', value }],
    },
  }
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/
// Mirrors splitTrailingFence: "text```" also opens or closes a fence.
const TRAILING_FENCE = /^.+?\S(`{3,}|~{3,})[ \t]*$/
// A line that would continue the previous block rather than start a new one:
// indented content, list items and block quotes.
const CONTINUATION_LINE = /^(\s|[-*+](\s|$)|\d+[.)](\s|$)|>)/

const countOf = (line, token) => line.split(token).length - 1

// Returns the end of the longest prefix of `text` (starting at `from`, which
// must itself be such a boundary) that ends at a blank line outside any code
// fence or display math and is followed by a new top-level block. That prefix
// renders the same however the rest of the text turns out, so it can be
// parsed once while a response streams in.
export function findStableBoundary(text, from = 0) {
  let boundary = from
  let fence = null
  let dollarPairs = 0
  let brackets = 0
  let environments = 0
  let offset = from
  const lines = text.slice(from).split('\n')

  // The last line may still be arriving, so it is never inspected.
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i]
    offset += line.length + 1

    const fenceMatch = line.match(FENCE_LINE) || line.match(TRAILING_FENCE)
    if (fence) {
      const marker = fenceMatch?.[1]
      const closes =
        marker &&
        marker[0] === fence[0] &&
        marker.length >= fence.length &&
        !(fenceMatch[2] || '').trim()
      if (closes) fence = null
      continue
    }
    if (fenceMatch) {
      fence = fenceMatch[1]
      continue
    }

    dollarPairs += countOf(line, '$$')
    brackets += countOf(line, '\\[') - countOf(line, '\\]')
    environments += countOf(line, '\\begin{') - countOf(line, '\\end{')

    const next = lines[i + 1]
    if (
      line.trim() === '' &&
      dollarPairs % 2 === 0 &&
      brackets <= 0 &&
      environments <= 0 &&
      i + 1 < lines.length - 1 &&
      next.trim() !== '' &&
      !CONTINUATION_LINE.test(next)
    ) {
      boundary = offset
    }
  }
  return boundary
}
