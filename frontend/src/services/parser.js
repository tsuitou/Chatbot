import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkMath from 'remark-math'
import remarkRehype from 'remark-rehype'
import rehypeKatex from 'rehype-katex'
import rehypeStringify from 'rehype-stringify'
import remarkGfm from 'remark-gfm'
import { visit } from 'unist-util-visit'
import { normalizeLatexBrackets } from './latexBracketProcessor.js'
import hljs from 'highlight.js'

const segmentProcessor = unified()
  .use(remarkGfm)
  .use(remarkMath, { singleDollarTextMath: false })
  .use(remarkRehype, { allowDangerousHtml: false })
  .use(rehypeKatex)
  .use(rehypeStringify)

export async function parseModelResponse(rawText) {
  if (!rawText) return []
  const { text: latexNormalizedText, block: blockPlaceholders, inline } =
    normalizeLatexBrackets(rawText)
  const normalizedText = splitTrailingFence(latexNormalizedText)
  const segments = []
  const tree = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath, { singleDollarTextMath: false })
    .parse(normalizedText)
  injectPlaceholderMath(tree, blockPlaceholders, inline)
  let nonCodeNodesBuffer = []

  const processNonCodeNodes = async () => {
    if (nonCodeNodesBuffer.length > 0) {
      const segmentTree = { type: 'root', children: nonCodeNodesBuffer }
      const file = await segmentProcessor.run(segmentTree)
      const html = unified().use(rehypeStringify).stringify(file)

      segments.push({
        type: 'plaintext',
        htmlContent: html,
      })
      nonCodeNodesBuffer = []
    }
  }

  for (const node of tree.children) {
    if (node.type === 'code') {
      await processNonCodeNodes()
      const id = String(node.lang)
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

  await processNonCodeNodes()
  return segments
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
    const blockMap = new Map(blockPlaceholders.map(({ token, value }) => [token, value]))
    const nextChildren = []
    for (const child of tree.children) {
      if (
        child?.type === 'paragraph' &&
        Array.isArray(child.children) &&
        child.children.length === 1 &&
        child.children[0]?.type === 'text'
      ) {
        const tokenCandidate = child.children[0].value.trim()
        if (blockMap.has(tokenCandidate)) {
          nextChildren.push(createDisplayMathNode(blockMap.get(tokenCandidate)))
          continue
        }
      }
      nextChildren.push(child)
    }
    tree.children = nextChildren
  }

  if (!inlinePlaceholders.length) return

  const inlineMap = new Map(inlinePlaceholders.map(({ token, value }) => [token, value]))
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

  return segments.filter((segment) => segment.type !== 'text' || segment.value.length)
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
