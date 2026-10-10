import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register, SessionCompactResult, SessionMessage, Timer } from 'claude-code'

import type { CacheState } from '../types'


// One Haiku request reads at most this much transcript (~100k tokens); a longer
// one is summarized in order, each request carrying the summary so far.
const CHUNK_CHARS = 400_000
const TOOL_INPUT_CHARS = 2_000
const TOOL_TEXT_CHARS = 4_000
const SUMMARY_MAX_TOKENS = 8_000
const CALL_TIMEOUT_MS = 5 * 60_000

const SYSTEM = `You compress the transcript of a coding-agent session so the agent can continue the work from your summary alone, without the original transcript.

Write a dense, factual summary with these sections:
1. User's requests and intent: every explicit request, in order, and what the user wants overall.
2. User's corrections and preferences: anything the user told the agent to do differently, verbatim where short.
3. Key technical context: languages, frameworks, services, hosts, commands that matter.
4. Files and code: every file path read or changed, what changed and why; include short code snippets that later work depends on.
5. Errors and fixes: what broke, the cause, and how it was fixed.
6. Decisions made and open questions.
7. Current state: what was being worked on in the latest messages, exactly where it stopped.
8. Next step: the immediate next action, only if the transcript makes it clear.

Keep exact file paths, identifiers, commands, URLs, versions and numbers. Do not invent anything that is not in the transcript. No preamble.`

const HEADER =
  'The earlier conversation was compacted into this summary (written by a smaller model). The most recent messages follow it word for word.\n\n'

const ZERO: ModelUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
}

const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max)}… [${text.length - max} chars cut]`

const isPrompt = (m: SessionMessage) => m.role === 'user' && !m.toolResults?.length && m.text.trim() !== ''

/** The transcript as plain text; tool results are read from the assistant's tool calls. */
export function renderTranscript(messages: readonly SessionMessage[]): string {
  const parts: string[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      if (m.text.trim()) parts.push(`## User\n${m.text}`)
      continue
    }
    const lines = m.text.trim() ? [m.text] : []
    for (const use of m.toolUses) {
      lines.push(`→ ${use.tool} ${clip(JSON.stringify(use.input), TOOL_INPUT_CHARS)}`)
      if (use.text !== undefined) lines.push(`  ⇒ ${use.isError ? 'ERROR ' : ''}${clip(use.text, TOOL_TEXT_CHARS)}`)
    }
    if (lines.length) parts.push(`## Assistant\n${lines.join('\n')}`)
  }
  return parts.join('\n\n')
}

/** Pieces of at most `max` chars, cut at a message boundary where one is near. */
export function chunk(text: string, max: number): string[] {
  const out: string[] = []
  let rest = text
  while (rest.length > max) {
    const cut = rest.lastIndexOf('\n\n## ', max)
    const at = cut > max / 2 ? cut : max
    out.push(rest.slice(0, at))
    rest = rest.slice(at)
  }
  if (rest) out.push(rest)
  return out
}

/**
 * Where the kept tail starts: the earliest typed prompt among the last `keep`
 * messages, so no tool call is separated from its result. `messages.length`
 * when there is none: everything is summarized.
 */
export function keepFrom(messages: readonly SessionMessage[], keep: number): number {
  for (let i = Math.max(0, messages.length - keep); i < messages.length; i++) {
    if (isPrompt(messages[i]!)) return i
  }
  return messages.length
}

const add = (a: ModelUsage, b: ModelUsage): ModelUsage => ({
  input_tokens: a.input_tokens + b.input_tokens,
  output_tokens: a.output_tokens + b.output_tokens,
  cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
  cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens,
})


// `/compact haiku [notes]` (the first word being the model option) is
// summarized by this mod; any other compaction is core's.
const WORD = /^\s*(\S+)\s*/
const MIN = 60_000
const BAR = 10

const cache = atom({ plugin: 'haiku-compact', key: 'cache' } as const, {
  phase: 'none',
  tokens: 0,
  warmUntil: 0,
} as CacheState)
// Ticks so the warm bar drains while nothing else happens.
const now = atom({ plugin: 'haiku-compact', key: 'now' } as const, 0)

// Set while this mod's own compaction runs, so its session.compact hook answers it.
let isOurs = false
// The person was told the cache is cold: their next prompt goes through as typed.
let isWarned = false
// The prompt held back for a `/compact <model>` the mod offered, sent after it.
let held: string | undefined
let coldTimer: Timer | undefined

/** The compaction this mod installs: the older messages summarized by `model`, the tail kept. */
export async function summarize(
  $: EngineInterface,
  model: string,
  messages: readonly SessionMessage[],
  keep: number,
  notes?: string,
): Promise<SessionCompactResult> {
  const from = keepFrom(messages, keep)
  const older = messages.slice(0, from)
  if (older.length === 0) return { skip: 'nothing older than the kept messages to summarize' }

  const system = notes ? `${SYSTEM}\n\nThe user asks the summary to keep or stress: ${notes}` : SYSTEM
  let summary = ''
  let usage = ZERO
  for (const piece of chunk(renderTranscript(older), CHUNK_CHARS)) {
    const prompt = summary
      ? `Summary of the transcript so far:\n\n${summary}\n\nThe transcript continues below. Rewrite the summary so it covers everything.\n\n${piece}`
      : `Transcript:\n\n${piece}`
    const r = await $.model.complete({ model, system, prompt, maxTokens: SUMMARY_MAX_TOKENS, timeoutMs: CALL_TIMEOUT_MS })
    usage = add(usage, r.usage)
    // Never fall through to core here: that would summarize on the expensive model.
    if (!r.isAnswered) return { skip: `${model} could not summarize (${r.reason})` }
    summary = r.text
  }

  return {
    messages: [{ role: 'user', text: HEADER + summary, toolUses: [] }, ...messages.slice(from)],
    usage,
  }
}

/** A rough token count of a transcript: about four characters a token. */
export const estimateTokens = (messages: readonly SessionMessage[]) =>
  Math.round(messages.reduce((n, m) => n + m.text.length + JSON.stringify(m.toolUses).length, 0) / 4)

export const k = (tokens: number) => `${Math.max(1, Math.round(tokens / 1000))}k`

/** The warm bar: full when the cache was just written, empty as it goes cold. */
export function warmBar(remainingMs: number, ttlMs: number): string {
  const full = Math.max(0, Math.min(BAR, Math.ceil((remainingMs / ttlMs) * BAR)))
  return '▰'.repeat(full) + '▱'.repeat(BAR - full)
}

/** Compacts now through this mod; throws where the engine refuses a compaction (mid-turn). */
async function compactCold($: EngineInterface): Promise<void> {
  isOurs = true
  try {
    await $.session.compact()
  } finally {
    isOurs = false
  }
}

/** Holds `text` back and offers `/compact <model>` in the prompt box; it is resent once that ran. */
async function offerCompact($: EngineInterface, model: string, text: string | undefined): Promise<string> {
  held = text
  isWarned = true
  const command = `/compact ${model}`
  const filled = await $.prompt.fill({ text: command }).then(
    r => r.isFilled,
    () => false,
  )
  const run = filled ? 'Press Enter' : `Run ${command}`
  const after = text === undefined ? '' : ' (your prompt is sent right after)'
  return `Cache cold. ${run} to squish it with ${model} first${after}, or send the prompt again to use the full context.`
}

/** The band's button: compact now, or where the engine refuses that here, offer the command. */
async function pressCompact($: EngineInterface, model: string): Promise<void> {
  try {
    await compactCold($)
  } catch {
    $.ui.toast(await offerCompact($, model, undefined))
  }
}

export const register: Register = (on, options) => {
  const model = String(options.summaryModel ?? 'haiku')
  const keep = Math.max(0, Number(options.keepMessages ?? 4))
  const ttlMs = Math.max(1, Number(options.cacheTtlMinutes ?? 60)) * MIN
  const minTokens = Number(options.minTokens ?? 40_000)
  const isAutoResume = options.autoCompactOnResume !== false
  const isHolding = options.holdPromptWhenCold !== false

  on('session.start', async ($, e, next) => {
    const done = await next(e)
    await update($, now, () => 0)
    $.clock.every(30_000, () => {
      void $.clock.now().then(t => update($, now, () => t))
    })
    return done
  })

  on('classic.SessionStart', async ($, e, next) => {
    const done = await next(e)
    const isResume = e.source === 'resume' || e.source === 'fork'
    const tokens = e.context_tokens ?? 0
    if (!isResume || !e.prompt_cache_likely_expired || tokens < minTokens) return done

    await update($, cache, () => ({ phase: 'cold' as const, tokens, warmUntil: 0, costUsd: e.estimated_cache_write_usd }))
    if (!isAutoResume) return done
    try {
      await compactCold($)
    } catch {
      // Refused at this start: the band stays cold, and the first prompt is held for it.
    }
    return done
  })

  on('turn.start', async ($, e, next) => {
    coldTimer?.cancel()
    coldTimer = undefined
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done
    isWarned = false
    const tokens = (await $.session.usage()).context.tokens ?? 0
    if (tokens < minTokens) {
      await update($, cache, () => ({ phase: 'none' as const, tokens, warmUntil: 0 }))
      return done
    }
    const at = await $.clock.now()
    await update($, now, () => at)
    await update($, cache, () => ({ phase: 'warm' as const, tokens, warmUntil: at + ttlMs }))
    coldTimer?.cancel()
    coldTimer = $.clock.after(ttlMs, () => {
      void update($, cache, c => (c.phase === 'warm' ? { ...c, phase: 'cold' as const } : c))
    })
    return done
  })

  on('prompt.submit', async ($, e, next) => {
    // Leave alone: prompts typed mid-turn, slash commands, prompts with images
    // (a resend would lose them), other plugins' prompts (this one's resend
    // included), and the prompt after a warning, which goes through as typed.
    const isPlain =
      e.turnId === undefined && !e.text.startsWith('/') && !e.attachments?.length && e.origin.kind !== 'plugin'
    if (!e.text.startsWith('/')) held = undefined
    if (!isPlain || isWarned || !isHolding) return next(e)

    const state = await read($, cache)
    if (state.phase !== 'cold') return next(e)
    return { drop: await offerCompact($, model, e.text) }
  })

  on('session.compact', async ($, e, next) => {
    const word = e.instructions?.match(WORD)?.[1]
    const isAsked = e.trigger === 'manual' && word?.toLowerCase() === model.toLowerCase()
    if ((!isOurs && !isAsked) || e.agentId !== undefined) return next(e)
    if (!Array.isArray(e.messages)) return { skip: 'no transcript to summarize' }

    const before = (await read($, cache)).tokens || estimateTokens(e.messages)
    await update($, cache, c => ({ ...c, phase: 'compacting' as const, tokens: before, note: undefined }))
    const notes = isAsked ? e.instructions!.replace(WORD, '').trim() || undefined : undefined
    const done = await summarize($, model, e.messages, keep, notes)

    if (done.skip === undefined) {
      const after = estimateTokens(done.messages)
      await update($, cache, () => ({ phase: 'done' as const, tokens: after, warmUntil: 0, before, after }))
    } else {
      await update($, cache, c => ({ ...c, phase: 'cold' as const, note: done.skip }))
    }
    // The held prompt goes either way: on a skip it meets the full context.
    if (held !== undefined) {
      const text = held
      held = undefined
      // Queued: it runs once the compaction is in and the session idle.
      await $.prompt.submit({ text, asUser: true }).catch(() => $.prompt.fill({ text }))
    }
    return done
  }).catch(($, e, next) =>
    // A failed summary must not fall through to core's expensive-model compaction.
    next.called ? next(e) : { skip: `${model} summary failed` },
  )

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const state = await read($, cache)
    if (state.phase === 'none') return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)

    if (state.phase === 'warm') {
      const left = state.warmUntil - Math.max(await read($, now), await $.clock.now())
      const mins = Math.max(0, Math.ceil(left / MIN))
      return (
        <Box gap={1}>
          <Text>🔥</Text>
          <Text color="warning">{warmBar(left, ttlMs)}</Text>
          <Text dimColor>
            {`cache warm · ${mins}m left · ${k(state.tokens)} cached`}
          </Text>
        </Box>
      )
    }

    if (state.phase === 'cold') {
      const cost = state.costUsd ? ` (~$${state.costUsd.toFixed(2)})` : ''
      return (
        <Box gap={1}>
          <Text>🧊</Text>
          <Text color="suggestion" bold>
            cache cold
          </Text>
          <Text dimColor>
            {`· ${k(state.tokens)} to re-cache${cost}${state.note ? ` · ${state.note}` : ''}`}
          </Text>
          <Button key="squish" label={`squish with ${model}`} variant="primary" onPress={() => pressCompact($, model)} />
        </Box>
      )
    }

    if (state.phase === 'compacting') {
      return (
        <Box gap={1}>
          <Text>🌀</Text>
          <Text color="claude">
            {`${model} is squishing ${k(state.tokens)} of context…`}
          </Text>
        </Box>
      )
    }

    const before = state.before ?? 0
    const after = state.after ?? 0
    const saved = before > 0 ? Math.round((1 - after / before) * 100) : 0
    return (
      <Box gap={1}>
        <Text>✨</Text>
        <Text color="success" bold>
          {`squished ${k(before)} → ${k(after)}`}
        </Text>
        <Text dimColor>
          {`(−${saved}%) by ${model} · next turn re-caches the small one`}
        </Text>
      </Box>
    )
  })
}
