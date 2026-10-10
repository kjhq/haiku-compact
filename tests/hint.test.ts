import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { coldHint } from '../hooks/register'

const MIN = 60_000

/** The engine beneath the plugin: a context of `tokens`, recording the status line and any compaction. */
function world(on: On, tokens: number) {
  const status: (string | undefined)[] = []
  const log: string[] = []
  const clock = mock.clock(on, { now: 0 })
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens, window: 200_000 }, rateLimits: [] } }) as never)
  on('ui.status', (_, e) => {
    status.push((e as { text?: string }).text)
    return { value: undefined } as never
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.compact', () => {
    log.push('compact')
    return { skip: 'no' }
  })
  on('prompt.submit', (_, e) => {
    log.push(`entered:${e.text}`)
    return { text: e.text }
  })
  on('classic.SessionStart', () => ({}))
  return { status, log, clock }
}

const finishTurn = ($: { turn: { complete: (e: never) => Promise<unknown> } }) =>
  $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as never)

test('the hint names the size, the cost when known, and the command', () => {
  expect(coldHint('haiku', 204_000, 0.765)).toBe('cache cold · 204k to re-cache (~$0.77) · /compact haiku to shrink it')
  expect(coldHint('haiku', 50_000)).toBe('cache cold · 50k to re-cache · /compact haiku to shrink it')
})

test('a long idle shows the hint and nothing else; prompts go straight through', async ($, on) => {
  const { status, log, clock } = world(on, 100_000)
  await finishTurn($)
  await clock.advance(59 * MIN)
  expect(status.filter(Boolean)).toEqual([])
  await clock.advance(2 * MIN)
  expect(status.at(-1)).toContain('/compact haiku')

  await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'composer' } } as never)
  expect(log).toEqual(['entered:hi'])
})

test('a new turn clears the hint and stops its timer', async ($, on) => {
  const { status, clock } = world(on, 100_000)
  await finishTurn($)
  await $.turn.start({ text: 'next', turnId: 't2' })
  await clock.advance(120 * MIN)
  expect(status.filter(Boolean)).toEqual([])
})

test('a small context never hints', async ($, on) => {
  const { status, clock } = world(on, 5_000)
  await finishTurn($)
  await clock.advance(300 * MIN)
  expect(status.filter(Boolean)).toEqual([])
})

test('hintIdleMinutes 5 hints after 5 minutes', { options: { hintIdleMinutes: 5 } }, async ($, on) => {
  const { status, clock } = world(on, 100_000)
  await finishTurn($)
  await clock.advance(6 * MIN)
  expect(status.at(-1)).toContain('cache cold')
})

test('a cold resume only hints, never compacts', async ($, on) => {
  const { status, log } = world(on, 0)
  await $.classic.SessionStart({
    source: 'resume',
    prompt_cache_likely_expired: true,
    context_tokens: 120_000,
    estimated_cache_write_usd: 2.25,
  })
  expect(status.at(-1)).toBe('cache cold · 120k to re-cache (~$2.25) · /compact haiku to shrink it')
  expect(log).toEqual([])
})

test('a warm, small or fresh start shows no hint', async ($, on) => {
  const { status } = world(on, 0)
  await $.classic.SessionStart({ source: 'resume', prompt_cache_likely_expired: false, context_tokens: 200_000 })
  await $.classic.SessionStart({ source: 'resume', prompt_cache_likely_expired: true, context_tokens: 1_000 })
  await $.classic.SessionStart({ source: 'startup' })
  expect(status.filter(Boolean)).toEqual([])
})
