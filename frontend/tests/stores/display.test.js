import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useChatsStore } from '../../src/stores/chats'
import { useDisplayStore } from '../../src/stores/display'
import { parseModelResponseSync } from '../../src/services/parser'

vi.mock('../../src/services/parser', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    parseModelResponseSync: vi.fn(actual.parseModelResponseSync),
  }
})
vi.mock('../../src/services/db', () => ({}))
vi.mock('../../src/services/notification', () => ({ showErrorToast: vi.fn() }))

let chats
let display

const model = (id, text, extra = {}) => ({
  id,
  sender: 'model',
  sequence: 0,
  status: 'completed',
  content: { text },
  uiFlags: { systemBubbleActive: true },
  ...extra,
})

beforeEach(() => {
  setActivePinia(createPinia())
  chats = useChatsStore()
  display = useDisplayStore()
  chats.persistActiveMessage = vi.fn(async () => true)
  chats.active = { meta: { id: 'c' }, messages: [] }
  vi.mocked(parseModelResponseSync).mockClear()
})

describe('message groups', () => {
  it('rebuilds and re-parses only the message that changed', () => {
    chats.active.messages = [model('a', 'first'), model('b', 'second')]
    const [a1, b1] = display.messageGroups
    vi.mocked(parseModelResponseSync).mockClear()

    const b = chats.active.messages[1]
    b.content = { text: 'second, longer' }
    const [a2, b2] = display.messageGroups

    expect(a2).toBe(a1)
    expect(b2).not.toBe(b1)
    expect(b2.content.segments[0].htmlContent).toContain('second, longer')
    expect(parseModelResponseSync).toHaveBeenCalledTimes(1)
  })

  it('reflects in-place status changes', () => {
    chats.active.messages = [model('a', 'x', { status: 'streaming' })]
    expect(display.messageGroups[0].system.status).toBe('streaming')
    chats.active.messages[0].status = 'completed'
    expect(display.messageGroups[0].system.status).toBe('completed')
  })

  it('reflects thoughts that stop streaming in place', () => {
    chats.active.messages = [
      model('a', 'x', {
        runtime: { system: { thoughts: { rawText: 't', isStreaming: true } } },
      }),
    ]
    expect(display.messageGroups[0].system.isStreamingThoughts).toBe(true)
    chats.active.messages[0].runtime.system.thoughts.isStreaming = false
    expect(display.messageGroups[0].system.isStreamingThoughts).toBe(false)
  })

  it('shows the system bubble only for flagged model messages', () => {
    chats.active.messages = [
      model('new', 'x'),
      model('old', 'y', { uiFlags: {} }),
      { id: 'u', sender: 'user', content: { text: 'q' }, uiFlags: {} },
    ]
    expect(display.messageGroups.map((g) => g.system.shouldRender)).toEqual([
      true,
      false,
      false,
    ])
  })
})

describe('thought collapse', () => {
  it('is stored only in uiFlags and toggles back and forth', () => {
    chats.active.messages = [model('a', 'x')]
    expect(display.messageGroups[0].system.isCollapsed).toBe(true)

    display.toggleThoughtCollapse('a')
    expect(chats.active.messages[0].uiFlags).toEqual({
      systemBubbleActive: true,
      thoughtsCollapsed: false,
    })
    expect(display.messageGroups[0].system.isCollapsed).toBe(false)
    expect(chats.persistActiveMessage).toHaveBeenCalledTimes(1)

    display.toggleThoughtCollapse('a')
    expect(chats.active.messages[0].uiFlags).toEqual({
      systemBubbleActive: true,
    })
    expect(display.messageGroups[0].system.isCollapsed).toBe(true)
  })

  it('does not save a streaming message mid-stream', () => {
    chats.active.messages = [model('a', 'x', { status: 'streaming' })]
    display.toggleThoughtCollapse('a')
    expect(display.messageGroups[0].system.isCollapsed).toBe(false)
    expect(chats.persistActiveMessage).not.toHaveBeenCalled()
  })
})

describe('preview', () => {
  const image = { id: 'img', mimeType: 'image/png', name: 'a.png' }
  const zip = { id: 'zip', mimeType: 'application/zip', name: 'a.zip' }

  it('opens previewable attachments only', () => {
    chats.active.messages = [model('a', 'x', { attachments: [image, zip] })]
    display.openPreview('zip')
    expect(display.isPreviewOpen).toBe(false)
    display.openPreview('img')
    expect(display.isPreviewOpen).toBe(true)
    expect(display.activePreviewFile.name).toBe('a.png')
  })

  it('closes when the previewed attachment goes away', () => {
    chats.active.messages = [model('a', 'x', { attachments: [image] })]
    display.openPreview('img')
    chats.active.messages = []
    expect(display.isPreviewOpen).toBe(false)
    expect(display.activePreviewFileId).toBeNull()
  })
})

describe('streaming render', () => {
  const DOCS = [
    '# Title\n\nIntro with **bold** and `code`.\n\nSecond paragraph.\n\n## Next\n\nEnd.',
    'Text\n\n```js\nconst a = 1\n\nconst b = 2\n```\n\nAfter the code.\n\nMore.',
    'Math:\n\n$$\na^2\n\nb^2\n$$\n\nInline \\(x\\) and $$y$$.\n\nDone.',
    'List:\n\n- one\n\n- two\n  continued\n\n1. a\n2. b\n\nAfter list.',
    '| a | b |\n|---|---|\n| 1 | 2 |\n\n> quote\n> more\n\nparagraph',
  ]

  // Ignores how prose is divided into segments; compares what is rendered.
  const rendered = (segments) =>
    segments
      .map((s) =>
        s.type === 'code'
          ? `<pre lang="${s.lang}">${s.content}</pre>`
          : s.htmlContent
      )
      .join('')
      .replace(/>\s+</g, '><')
      .trim()

  it.each(DOCS.map((d) => [d]))(
    'ends up identical to a full parse: %j',
    (doc) => {
      const message = model('s', '', { status: 'streaming' })
      chats.active.messages = [message]
      const live = chats.active.messages[0]
      for (let end = 1; end <= doc.length; end += 7) {
        live.content = { text: doc.slice(0, end) }
        void display.messageGroups
      }
      live.content = { text: doc }
      const segments = display.messageGroups[0].content.segments
      const full = parseModelResponseSync(doc)
      expect(rendered(segments)).toBe(rendered(full))

      live.status = 'completed'
      expect(display.messageGroups[0].content.segments).toEqual(full)
    }
  )

  it('parses each stable block once while streaming', () => {
    chats.active.messages = [model('s', '', { status: 'streaming' })]
    const live = chats.active.messages[0]
    const paragraphs = Array.from({ length: 50 }, (_, i) => `Paragraph ${i}.`)
    let text = ''
    vi.mocked(parseModelResponseSync).mockClear()
    for (const p of paragraphs) {
      text += `${p}\n\n`
      live.content = { text }
      void display.messageGroups
    }
    const parsedLength = vi
      .mocked(parseModelResponseSync)
      .mock.calls.reduce((sum, [t]) => sum + t.length, 0)
    // Re-parsing everything each time would be ~25x the text length.
    expect(parsedLength).toBeLessThan(text.length * 3)
  })
})
