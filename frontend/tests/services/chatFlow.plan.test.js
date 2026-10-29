import { describe, it, expect } from 'vitest'
import { planSend, planResend, nextSequence } from '../../src/services/chatFlow'

const msg = (id, sender, sequence) => ({ id, sender, sequence })

describe('planSend', () => {
  it('starts an empty chat at 10 with the response right after', () => {
    expect(planSend([])).toEqual({
      userSequence: 10,
      anchorSequence: 10,
      responseSequence: 20,
    })
  })

  it('goes after the highest sequence, not the last array entry', () => {
    const plan = planSend([msg('b', 'model', 40), msg('a', 'user', 30)])
    expect(plan.userSequence).toBe(50)
    expect(plan.responseSequence).toBe(60)
  })
})

describe('planResend', () => {
  const chat = [
    msg('m2', 'model', 40),
    msg('u1', 'user', 10),
    msg('m1', 'model', 20),
    msg('u2', 'user', 30),
  ]

  it('rerunning a model message replaces it and everything after', () => {
    expect(planResend(chat, 'm1')).toEqual({
      pruneIds: ['m1', 'u2', 'm2'],
      historyMessages: [chat[1]],
      anchorSequence: 10,
      responseSequence: 20,
    })
  })

  it('rerunning a user message keeps it and appends a fresh response', () => {
    expect(planResend(chat, 'u2')).toEqual({
      pruneIds: ['m2'],
      historyMessages: [chat[1], chat[2], chat[3]],
      anchorSequence: 30,
      responseSequence: 40,
    })
  })

  it('rerunning the last model message prunes only it', () => {
    const plan = planResend(chat, 'm2')
    expect(plan.pruneIds).toEqual(['m2'])
    expect(plan.anchorSequence).toBe(30)
    expect(plan.responseSequence).toBe(40)
  })

  it('anchors on the last kept message when no user message remains', () => {
    const plan = planResend([msg('s', 'system', 5), msg('m', 'model', 20)], 'm')
    expect(plan.historyMessages.map((m) => m.id)).toEqual(['s'])
    expect(plan.anchorSequence).toBe(5)
  })

  it('anchors on the target when nothing is kept', () => {
    const plan = planResend([msg('m', 'model', 20)], 'm')
    expect(plan.historyMessages).toEqual([])
    expect(plan.anchorSequence).toBe(20)
    expect(plan.responseSequence).toBe(20)
  })

  it('returns null for an unknown message', () => {
    expect(planResend(chat, 'nope')).toBeNull()
  })
})

describe('nextSequence', () => {
  it('treats missing sequences as 0', () => {
    expect(nextSequence([{ id: 'x' }])).toBe(10)
  })
})
