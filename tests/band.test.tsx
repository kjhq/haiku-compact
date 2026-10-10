import { expect, mock, test } from 'claude-code/testing'
import type { On, SessionMessage } from 'claude-code'

import { estimateTokens, inputRate, k, savings, usd } from '../hooks/register'

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
  const ledger = { usd: 0 }
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens, window: 200_000 }, rateLimits: [], cost: ledger } }) as never)
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
  return { log, clock, ledger }
}

const finishTurn = ($: { turn: { complete: (e: never) => Promise<unknown> } }, usage?: object) =>
  $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer', usage } as never)

const type = async ($: { prompt: { submit: (e: never) => Promise<unknown> } }, text: string) =>
  (await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } } as never)) as { drop?: string }

test('prices: a turn implies the input rate, a squish saves the share it drops', () => {
  const u = { input_tokens: 1_000, output_tokens: 1_000, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 2_000 }
  // 1000 + 2*2000 + 0.1*100000 + 5*1000 = 20000 input-token units
  expect(inputRate(0.1, u, 2)).toBe(0.000005)
  expect(inputRate(0, u, 2)).toBeUndefined()
  const s = savings(200_000, 0.000005, 2, 0.15)
  expect(usd(s.full)).toBe("$2.00")
  expect(usd(s.saved)).toBe("$1.70")
  expect(usd(1.7)).toBe('$1.70')
  expect(usd(0.0123)).toBe('$0.012')
  expect(k(204_400)).toBe('204k')
  expect(estimateTokens(TRANSCRIPT)).toBeGreaterThan(1_000)
})

test('a warm cache shows nothing: the band is the engine’s', async ($, on) => {
  const { clock } = world(on, 204_000)
  await finishTurn($)
  await clock.advance(30 * MIN)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ text: 'engine' })).toBeDefined()
    await ui.unmount()
  }
})

test('past the TTL one cold line with a squish button, on every surface', async ($, on) => {
  const { clock } = world(on, 204_000)
  await finishTurn($)
  await clock.advance(61 * MIN)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ text: '🧊 cache cold · 204k to re-cache' })).toBeDefined()
    expect(await ui.find({ key: 'squish' })).toBeDefined()
    await ui.unmount()
  }
})

test('with a price learned from a turn, the cold line says what a squish saves', async ($, on) => {
  const { clock, ledger } = world(on, 200_000)
  await $.turn.start({ turnId: 't' } as never)
  ledger.usd += 0.1
  await finishTurn($, { input_tokens: 1_000, output_tokens: 1_000, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 2_000, model: 'm' })
  await clock.advance(61 * MIN)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ text: '🧊 cache cold · squish saves ~$1.70 of $2.00' })).toBeDefined()
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
  expect(await ui.find({ text: /^✨ 204k → \d+k$/ })).toBeDefined()
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
  expect(await ui.find({ text: /^🧊 cache cold/ })).toBeDefined()
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
  expect(await ui.find({ text: '🧊 cache cold · squish saves ~$1.91 of $2.25' })).toBeDefined()
  expect(log).toEqual([])
})

test('a priced squish says what it saved, then goes away', { options: { autoCompactOnResume: false } }, async ($, on) => {
  const { clock } = world(on, 0)
  await $.classic.SessionStart({ source: 'resume', prompt_cache_likely_expired: true, context_tokens: 120_000, estimated_cache_write_usd: 2.25 })
  await $.session.compact({ trigger: 'manual', instructions: 'haiku', messages: TRANSCRIPT })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ text: /^✨ saved ~\$2\.2\d · 120k → \d+k$/ })).toBeDefined()
  await ui.unmount()
  await clock.advance(31_000)
  const later = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await later.find({ text: 'engine' })).toBeDefined()
})
