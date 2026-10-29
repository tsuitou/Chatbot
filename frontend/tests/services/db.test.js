import 'fake-indexeddb/auto'
import { describe, it, expect } from 'vitest'
import * as db from '../../src/services/db'

describe('db', () => {
  it('round-trips a chat with ordered messages and attachments', async () => {
    await db.saveNewChat({ id: 'c1', title: 'Hello' })
    await db.saveMessage('c1', {
      id: 'm2',
      sender: 'model',
      sequence: 20,
      content: { text: 'hi' },
    })
    await db.saveMessage('c1', {
      id: 'm1',
      sender: 'user',
      sequence: 10,
      content: { text: 'hello' },
      attachments: [
        {
          id: 'a1',
          name: 'note.txt',
          mimeType: 'text/plain',
          blob: new Blob(['x'], { type: 'text/plain' }),
        },
      ],
    })

    const details = await db.getChatDetails('c1')
    expect(details.title).toBe('Hello')
    expect(details.messages.map((m) => m.id)).toEqual(['m1', 'm2'])
    expect(details.messages[0].attachments.map((a) => a.name)).toEqual([
      'note.txt',
    ])

    await db.deleteChat('c1')
    expect(await db.getChatDetails('c1')).toBeNull()
  })
})
