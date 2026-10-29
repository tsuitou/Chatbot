import { describe, it, expect } from 'vitest'
import { findStableBoundary } from '../../src/services/parser'

// The boundary as the remaining text, for readable expectations.
const rest = (text) => text.slice(findStableBoundary(text))

describe('findStableBoundary', () => {
  it('is 0 while there is no completed block', () => {
    expect(findStableBoundary('')).toBe(0)
    expect(findStableBoundary('one paragraph still going')).toBe(0)
  })

  it('needs the next block to have started on a complete line', () => {
    expect(rest('para\n\n')).toBe('para\n\n')
    expect(rest('para\n\nnext')).toBe('para\n\nnext')
    expect(rest('para\n\nnext\n')).toBe('next\n')
  })

  it('stops at the last boundary', () => {
    expect(rest('a\n\nb\n\nc\nd')).toBe('c\nd')
  })

  it('never splits inside a code fence, even across blank lines', () => {
    expect(rest('```py\nx\n\ny\nz')).toBe('```py\nx\n\ny\nz')
    expect(rest('```py\nx\n\ny\n```\n\nafter\n')).toBe('after\n')
    expect(rest('~~~~\n```\n\nstill\n~~~~\n\nafter\n')).toBe('after\n')
    expect(rest('run this```\n\ninside\n```\n\nout\n')).toBe('out\n')
  })

  it('never splits inside display math', () => {
    expect(rest('$$\na\n\nb\n$$\n\nafter\n')).toBe('after\n')
    expect(rest('$$\na\n\nb\nc')).toBe('$$\na\n\nb\nc')
    expect(rest('\\[\na\n\nb\nc')).toBe('\\[\na\n\nb\nc')
    expect(rest('\\begin{equation}\na\n\nb\nc')).toBe(
      '\\begin{equation}\na\n\nb\nc'
    )
  })

  it('keeps list items, indented content and quotes together', () => {
    expect(rest('- a\n\n- b\nc')).toBe('- a\n\n- b\nc')
    expect(rest('1. a\n\n2. b\nc')).toBe('1. a\n\n2. b\nc')
    expect(rest('- a\n\n  more\nc')).toBe('- a\n\n  more\nc')
    expect(rest('> a\n\n> b\nc')).toBe('> a\n\n> b\nc')
  })

  it('continues scanning from an earlier boundary', () => {
    const text = 'a\n\nb\n\nc\nd'
    const first = findStableBoundary('a\n\nb\n')
    expect(findStableBoundary(text, first)).toBe(findStableBoundary(text))
  })
})
