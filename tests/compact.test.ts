import { expect, test } from 'claude-code/testing'
import type { EngineInterface, ModelCompleteRequest, ModelCompleteResult, SessionMessage } from 'claude-code'

import { chunk, keepFrom, renderTranscript, summarize } from '../hooks/register'

const USAGE = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const prompt = (text: string): SessionMessage => ({ role: 'user', text, toolUses: [] })
const reply = (text: string): SessionMessage => ({
  role: 'assistant',
  text,
  toolUses: [{ tool_use_id: `t-${text}`, tool: 'Bash', input: { command: 'ls' }, text: 'a.txt' }],
})
const result = (id: string): SessionMessage => ({
  role: 'user',
  text: '',
  toolUses: [],
  toolResults: [{ tool_use_id: id, text: 'a.txt', isError: false }],
})

const TRANSCRIPT = [prompt('fix the bug'), reply('one'), result('t-one'), reply('done'), prompt('now test it'), reply('ok')]

/** A `$` holding only the model noun, answering as `answer` says. */
const fakeModel = (asked: ModelCompleteRequest[], answer: () => ModelCompleteResult) =>
  ({ model: { complete: async (req: ModelCompleteRequest) => (asked.push(req), answer()) } }) as unknown as EngineInterface

test('keepFrom keeps from a typed prompt, never mid tool loop', () => {
  expect(keepFrom(TRANSCRIPT, 4)).toBe(4)
  expect(keepFrom(TRANSCRIPT, 1)).toBe(TRANSCRIPT.length)
  expect(keepFrom(TRANSCRIPT, 0)).toBe(TRANSCRIPT.length)
  expect(keepFrom(TRANSCRIPT, 99)).toBe(0)
})

test('renderTranscript shows prompts, replies and tool calls with results', () => {
  const text = renderTranscript(TRANSCRIPT)
  expect(text).toContain('## User\nfix the bug')
  expect(text).toContain('→ Bash {"command":"ls"}')
  expect(text).toContain('⇒ a.txt')
})

test('chunk splits at message boundaries and loses nothing', () => {
  const text = Array.from({ length: 50 }, (_, i) => `## User\nmessage ${i}`).join('\n\n')
  const pieces = chunk(text, 200)
  expect(pieces.length).toBeGreaterThan(1)
  expect(pieces.join('')).toBe(text)
  for (const p of pieces) expect(p.length).toBeLessThanOrEqual(200)
})

test('summarize asks haiku for the older part and keeps the tail verbatim', async () => {
  const asked: ModelCompleteRequest[] = []
  const $ = fakeModel(asked, () => ({ isAnswered: true, text: 'SUMMARY', usage: USAGE }))
  const done = await summarize($, 'haiku', TRANSCRIPT, 4, 'the plan')

  expect(asked).toHaveLength(1)
  expect(asked[0]?.model).toBe('haiku')
  expect(asked[0]?.prompt).toContain('fix the bug')
  expect(asked[0]?.prompt).not.toContain('now test it')
  expect(String(asked[0]?.system)).toContain('the plan')
  expect(done.messages?.map(m => m.text)).toEqual([expect.stringContaining('SUMMARY'), 'now test it', 'ok'])
  expect(done.messages?.[0]?.role).toBe('user')
})

test('summarize carries the summary across chunks of a long transcript', async () => {
  const asked: ModelCompleteRequest[] = []
  let n = 0
  const $ = fakeModel(asked, () => ({ isAnswered: true, text: `S${++n}`, usage: USAGE }))
  const long = [...Array.from({ length: 300 }, (_, i) => [prompt(`p${i} ${'x'.repeat(2_000)}`), reply(`r${i}`)]).flat(), prompt('last')]
  const done = await summarize($, 'haiku', long, 1)

  expect(asked.length).toBeGreaterThan(1)
  expect(String(asked[1]?.prompt)).toContain('S1')
  expect(done.messages?.[0]?.text).toContain(`S${asked.length}`)
  expect(done.messages?.at(-1)?.text).toBe('last')
})

test('summarize skips when haiku fails, never handing back a broken transcript', async () => {
  const $ = fakeModel([], () => ({ isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: USAGE }))
  const done = await summarize($, 'haiku', TRANSCRIPT, 4)
  expect(done.skip).toContain('api-error')
  expect(done.messages).toBeUndefined()
})

test('plain /compact and auto-compaction go to core untouched', async ($, on) => {
  on('session.compact', () => ({ messages: [prompt('core summary')] }))
  for (const e of [
    { trigger: 'manual' as const, messages: TRANSCRIPT },
    { trigger: 'manual' as const, instructions: 'keep the plan', messages: TRANSCRIPT },
    { trigger: 'auto' as const, messages: TRANSCRIPT },
  ]) {
    const done = await $.session.compact(e)
    expect(done.messages?.[0]?.text).toBe('core summary')
  }
})

test('/compact haiku <notes> is summarized by haiku, not core', async ($, on) => {
  const asked: { model: string; system?: string }[] = []
  on('model.complete', (_, e) => {
    asked.push(e)
    return { value: { isAnswered: true as const, text: 'SUMMARY', usage: USAGE } }
  })
  on('session.compact', () => ({ messages: [prompt('core ran instead')] }))
  const done = await $.session.compact({ trigger: 'manual', instructions: 'Haiku keep the plan', messages: TRANSCRIPT })

  expect(asked[0]?.model).toBe('haiku')
  expect(asked[0]?.system).toContain('keep the plan')
  expect(done.messages?.map(m => m.text)).toEqual([expect.stringContaining('SUMMARY'), 'now test it', 'ok'])
})

test('a haiku failure on /compact haiku leaves the transcript, never runs core', async ($, on) => {
  let coreRan = false
  on('model.complete', () => ({
    value: { isAnswered: false as const, reason: 'empty-reply' as const, usage: USAGE },
  }))
  on('session.compact', () => {
    coreRan = true
    return { messages: [prompt('core')] }
  })
  const done = await $.session.compact({ trigger: 'manual', instructions: 'haiku', messages: TRANSCRIPT })
  expect(coreRan).toBe(false)
  expect(done.skip).toContain('haiku')
})


