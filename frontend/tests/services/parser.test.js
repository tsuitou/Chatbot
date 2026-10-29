import { describe, it, expect } from 'vitest'
import { parseModelResponseSync } from '../../src/services/parser'

describe('parseModelResponseSync', () => {
  it('returns no segments for empty text', () => {
    expect(parseModelResponseSync('')).toEqual([])
  })

  it('splits code blocks out of the prose', () => {
    const segments = parseModelResponseSync('a\n\n```js\nx\n```\nb')
    expect(segments.map((s) => s.type)).toEqual([
      'plaintext',
      'code',
      'plaintext',
    ])
    expect(segments[1]).toMatchObject({ content: 'x', lang: 'js' })
  })

  it('renders math and tables', () => {
    const [segment] = parseModelResponseSync(
      'Math $$x^2$$ and \\(a+b\\)\n\n| a | b |\n|---|---|\n| 1 | 2 |'
    )
    expect(segment.htmlContent).toContain('class="katex"')
    expect(segment.htmlContent).toContain('<table>')
  })

  it('drops unsafe link targets but keeps their text', () => {
    const [segment] = parseModelResponseSync('[click](javascript:alert(1))')
    expect(segment.htmlContent).not.toContain('javascript:')
    expect(segment.htmlContent).toContain('click')
  })
})
