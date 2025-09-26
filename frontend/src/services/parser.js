import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkMath from 'remark-math'
import remarkRehype from 'remark-rehype'
import rehypeKatex from 'rehype-katex'
import rehypeStringify from 'rehype-stringify'
import remarkGfm from 'remark-gfm'
import hljs from 'highlight.js'

const segmentProcessor = unified()
  .use(remarkGfm)
  .use(remarkMath, { singleDollarTextMath: false })
  .use(remarkRehype, { allowDangerousHtml: false })
  .use(rehypeKatex)
  .use(rehypeStringify)

export async function parseModelResponse(rawText) {
  if (!rawText) return []
  const normalizedText = splitTrailingFence(rawText)
  const segments = []
  const tree = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath, { singleDollarTextMath: false })
    .parse(normalizedText)
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
