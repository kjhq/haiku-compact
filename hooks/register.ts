import type { EngineInterface, ModelUsage, Register, SessionCompactResult, SessionMessage, Timer } from 'claude-code'

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

/** The status-line hint: it only tells; compacting is the person's call. */
export const coldHint = (model: string, tokens: number, cost?: number) =>
  `cache cold · ${Math.round(tokens / 1000)}k to re-cache${cost ? ` (~$${cost.toFixed(2)})` : ''} · /compact ${model} to shrink it`

export const register: Register = (on, options) => {
  const model = String(options.summaryModel ?? 'haiku')
  const keep = Math.max(0, Number(options.keepMessages ?? 4))
  const minTokens = Number(options.hintMinTokens ?? 40_000)
  const idleMs = Number(options.hintIdleMinutes ?? 60) * 60_000

  on('session.compact', async ($, e, next) => {
    const word = e.instructions?.match(WORD)?.[1]
    const isAsked = e.trigger === 'manual' && word?.toLowerCase() === model.toLowerCase()
    if (!isAsked || e.agentId !== undefined) return next(e)
    if (!Array.isArray(e.messages)) return { skip: 'no transcript to summarize' }

    const notes = e.instructions!.replace(WORD, '').trim() || undefined
    const done = await summarize($, model, e.messages, keep, notes)
    if (done.skip === undefined) $.ui.status(undefined)
    return done
  }).catch(($, e, next) =>
    // A failed summary must not fall through to core's expensive-model compaction.
    next.called ? next(e) : { skip: `${model} summary failed` },
  )

  // Hints only below: nothing here compacts or holds a prompt.
  on('classic.SessionStart', async ($, e, next) => {
    const done = await next(e)
    const isResume = e.source === 'resume' || e.source === 'fork'
    const tokens = e.context_tokens ?? 0
    if (isResume && e.prompt_cache_likely_expired && tokens >= minTokens) {
      $.ui.status(coldHint(model, tokens, e.estimated_cache_write_usd))
    }
    return done
  })

  on('turn.start', async ($, e, next) => {
    coldTimer?.cancel()
    coldTimer = undefined
    $.ui.status(undefined)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined || idleMs <= 0) return done
    const tokens = (await $.session.usage()).context.tokens ?? 0
    coldTimer?.cancel()
    coldTimer = tokens >= minTokens ? $.clock.after(idleMs, () => $.ui.status(coldHint(model, tokens))) : undefined
    return done
  })
}
