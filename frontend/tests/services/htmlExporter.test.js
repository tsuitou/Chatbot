// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { exportChatAsHTML } from '../../src/services/htmlExporter'

const chat = { id: 'c', title: 'My <chat>' }
const user = (text, extra = {}) => ({
  id: `u-${text}`,
  sender: 'user',
  status: 'completed',
  createdAt: 0,
  content: { text },
  ...extra,
})
const model = (text, extra = {}) => ({
  id: `m-${text.length}`,
  sender: 'model',
  status: 'completed',
  createdAt: 0,
  content: { text },
  configSnapshot: { model: 'gemini-x', parameters: { temperature: 0.5 } },
  metadata: { duration: 1500, finishReason: 'STOP' },
  uiFlags: { systemBubbleActive: true },
  ...extra,
})

const parse = (html) => new DOMParser().parseFromString(html, 'text/html')

describe('exportChatAsHTML', () => {
  it('renders messages with the same structure and classes as the app', async () => {
    const html = await exportChatAsHTML(chat, [
      user('Hi <b>'),
      model('**Bold** answer\n\n```js\nconst a = 1\n```', {
        runtime: { system: { thoughts: { rawText: 'thinking' } } },
      }),
    ])
    const doc = parse(html)
    expect(doc.title).toBe('My <chat>')
    const [u, m] = doc.querySelectorAll('.message-wrapper')
    expect(u.querySelector('.sender-name').textContent).toBe('User')
    expect(u.querySelector('.bubble-user .plain-user-text').textContent).toBe(
      'Hi <b>'
    )
    expect(m.querySelector('.bubble-model .prose strong').textContent).toBe(
      'Bold'
    )
    const code = m.querySelector('.code-block-wrapper')
    expect(code.querySelector('.language-name').textContent).toBe('js')
    expect(code.querySelector('code .hljs-number').textContent).toBe('1')
    const system = m.querySelector('.system-bubble')
    expect(system.querySelector('.duration-text').textContent).toBe('1.5s')
    expect(system.querySelector('.system-summary').textContent).toContain(
      'gemini-x'
    )
    expect(system.querySelector('.thought-stream-content').hidden).toBe(true)
    expect(m.querySelector('.metadata').textContent).toContain('STOP')
  })

  it('embeds the shared theme so both light and dark work', async () => {
    const html = await exportChatAsHTML(chat, [user('x')])
    expect(html).toContain('--bot-message-bg')
    expect(html).toMatch(/\[data-theme=["']?dark["']?\]/)
    expect(html).toContain('.message-wrapper .sender-name')
    expect(html).toContain('data-theme-switch')
  })

  it('shows the stored error of a failed response', async () => {
    const html = await exportChatAsHTML(chat, [
      model('partial', {
        metadata: { finishReason: 'error', error: 'Connection lost' },
      }),
    ])
    const alert = parse(html).querySelector('.message-alert.error')
    expect(alert.textContent).toBe('Connection lost')
  })

  it('leaves out cancelled responses, as the app does', async () => {
    const html = await exportChatAsHTML(chat, [
      user('q'),
      model('gone', { status: 'cancelled' }),
    ])
    expect(parse(html).querySelectorAll('.message-wrapper')).toHaveLength(1)
  })

  it('embeds KaTeX with its fonts only when there is math', async () => {
    const plain = await exportChatAsHTML(chat, [model('no math')])
    expect(plain).not.toContain('.katex')

    const math = await exportChatAsHTML(chat, [model('Euler: $$e^{i\\pi}$$')])
    expect(math).toContain('class="katex')
    expect(math).toContain('src:url(data:font/woff2;base64,')
    expect(math).not.toMatch(/url\(fonts\//)
  })

  it('loads nothing from the network when opened', async () => {
    const html = await exportChatAsHTML(chat, [
      model('Euler: $$e^{i\\pi}$$\n\n```py\nprint(1)\n```'),
    ])
    const doc = parse(html)
    expect(
      doc.querySelectorAll('link, script[src], img[src^="http"]')
    ).toHaveLength(0)
    expect(html).not.toMatch(/url\(\s*(?!["']?data:)/)
  })
})

describe('code blocks', () => {
  it('have no stray whitespace around their parts (the wrapper is white-space: pre)', async () => {
    const html = await exportChatAsHTML(chat, [model('```js\nx\ny\n```')])
    const wrapper = parse(html).querySelector('.code-block-wrapper')
    const strayText = [...wrapper.querySelectorAll('*')]
      .filter((el) => !el.closest('code'))
      .flatMap((el) => [...el.childNodes])
      .filter(
        (n) =>
          n.nodeType === 3 &&
          !n.parentElement.closest('code, .language-name, .action-btn')
      )
    expect(strayText).toHaveLength(0)
    expect(wrapper.querySelector('code').textContent).toBe('x\ny')
  })
})
