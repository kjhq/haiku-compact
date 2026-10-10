import { expect, mock, test } from 'claude-code/testing'
import type { On, SessionMessage } from 'claude-code'

import { estimateTokens, k, warmBar } from '../hooks/register'

const MIN = 60_000
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const SURFACES = ['terminal', 'desktop'] as const
const BAND = {
  plugin: 'haiku-compact',
  component: 'AbovePrompt' as const,
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100 } as never,
}
const TRANSCRIPT: SessionMessage[] = [
  { role: 'user', text: 'older work', toolUses: [] },
  { role: 'assistant', text: 'y'.repeat(4_000), toolUses: [] },
  { role: 'user', text: 'and then', toolUses: [] },
  { role: 'assistant', text: 'x'.repeat(4_000), toolUses: [] },
  { role: 'user', text: 'more', toolUses: [] },
  { role: 'assistant', text: 'ok', toolUses: [] },
]

/** The engine beneath the plugin: a context of `tokens`, recording what reached it. */
function world(on: On, tokens: number) {
  const log: string[] = []
  const clock = mock.clock(on, { now: 0 })
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens, window: 200_000 }, rateLimits: [] } }) as never)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('model.complete', () => ({ value: { isAnswered: true as const, text: 'SUMMARY', usage: USAGE } }))
  on('session.compact', () => {
    log.push('core-compact')
    return { messages: [{ role: 'user', text: 'core', toolUses: [] }] }
  })
  on('prompt.submit', (_, e) => {
    log.push(`entered:${e.text}:${e.origin.kind}`)
    return { text: e.text }
  })
  on('prompt.fill', (_, e) => {
    log.push(`filled:${e.text}`)
    return { isFilled: true } as never
  })
  on('ui.toast', () => ({ value: undefined }) as never)
  on('classic.SessionStart', () => ({}))
  // What the engine draws in the band when the mod leaves it.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  return { log, clock }
}

const finishTurn = ($: { turn: { complete: (e: never) => Promise<unknown> } }) =>
  $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as never)

const type = async ($: { prompt: { submit: (e: never) => Promise<unknown> } }, text: string) =>
  (await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } } as never)) as { drop?: string }

test('the warm bar drains from full to empty', () => {
  expect(warmBar(60 * MIN, 60 * MIN)).toBe('▰▰▰▰▰▰▰▰▰▰')
  expect(warmBar(30 * MIN, 60 * MIN)).toBe('▰▰▰▰▰▱▱▱▱▱')
  expect(warmBar(0, 60 * MIN)).toBe('▱▱▱▱▱▱▱▱▱▱')
  expect(warmBar(-5, 60 * MIN)).toBe('▱▱▱▱▱▱▱▱▱▱')
  expect(k(204_400)).toBe('204k')
  expect(estimateTokens(TRANSCRIPT)).toBeGreaterThan(1_000)
})

test('after a big turn the band shows a warm cache draining, on every surface', async ($, on) => {
  const { clock } = world(on, 204_000)
  await finishTurn($)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ text: /cache warm · 60m left · 204k cached/ })).toBeDefined()
    expect(await ui.find({ text: '▰▰▰▰▰▰▰▰▰▰' })).toBeDefined()
    await ui.unmount()
  }
  await clock.advance(30 * MIN)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ text: /30m left/ })).toBeDefined()
})

test('past the TTL the band turns cold with a squish button', async ($, on) => {
  const { clock } = world(on, 204_000)
  await finishTurn($)
  await clock.advance(61 * MIN)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ text: 'cache cold' })).toBeDefined()
    expect(await ui.find({ key: 'squish' })).toBeDefined()
    await ui.unmount()
  }
})

test('a small context leaves the band to the engine', async ($, on) => {
  world(on, 5_000)
  await finishTurn($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ text: 'engine' })).toBeDefined()
})

test('cold: the prompt is held, /compact haiku squishes, the band celebrates, the prompt is resent', async ($, on) => {
  const { log, clock } = world(on, 204_000)
  await finishTurn($)
  await clock.advance(61 * MIN)

  const held = await type($, 'hi')
  expect(held.drop).toContain('Cache cold')
  expect(log).toEqual(['filled:/compact haiku'])

  const done = await $.session.compact({ trigger: 'manual', instructions: 'haiku', messages: TRANSCRIPT })
  expect(done.messages?.[0]?.text).toContain('SUMMARY')
  expect(log).not.toContain('core-compact')
  expect(log).toContain('entered:hi:plugin')

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ text: /squished 204k → \d+k/ })).toBeDefined()
})

test('sending again after the offer goes through to the full context', async ($, on) => {
  const { log, clock } = world(on, 204_000)
  await finishTurn($)
  await clock.advance(61 * MIN)
  await type($, 'hi')
  expect((await type($, 'hi')).drop).toBeUndefined()
  expect(log).toEqual(['filled:/compact haiku', 'entered:hi:composer'])
})

test('a warm cache never holds a prompt', async ($, on) => {
  const { log, clock } = world(on, 204_000)
  await finishTurn($)
  await clock.advance(10 * MIN)
  await type($, 'quick')
  expect(log).toEqual(['entered:quick:composer'])
})

test('holdPromptWhenCold off: a cold cache shows, but prompts go through', { options: { holdPromptWhenCold: false } }, async ($, on) => {
  const { log, clock } = world(on, 204_000)
  await finishTurn($)
  await clock.advance(61 * MIN)
  await type($, 'go')
  expect(log).toEqual(['entered:go:composer'])
})

test('cacheTtlMinutes 5 turns cold after 5 minutes', { options: { cacheTtlMinutes: 5 } }, async ($, on) => {
  const { clock } = world(on, 204_000)
  await finishTurn($)
  await clock.advance(6 * MIN)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ text: 'cache cold' })).toBeDefined()
})

test('a cold resume compacts through this mod at once, never core', async ($, on) => {
  const { log } = world(on, 0)
  await $.classic.SessionStart({
    source: 'resume',
    prompt_cache_likely_expired: true,
    context_tokens: 120_000,
    estimated_cache_write_usd: 2.25,
  })
  expect(log).not.toContain('core-compact')
})

test('autoCompactOnResume off: a cold resume only shows the band', { options: { autoCompactOnResume: false } }, async ($, on) => {
  const { log } = world(on, 0)
  await $.classic.SessionStart({ source: 'resume', prompt_cache_likely_expired: true, context_tokens: 120_000, estimated_cache_write_usd: 2.25 })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ text: /120k to re-cache \(~\$2\.25\)/ })).toBeDefined()
  expect(log).toEqual([])
})
