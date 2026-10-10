# haiku-compact

A Claude Code mod that compacts your conversation with a cheap model when the prompt cache goes cold.

Claude Code keeps your conversation in the prompt cache for a while (5 minutes or 1 hour). Step away longer and the cache goes cold: your next message makes the main model re-read and re-cache the whole transcript at full price. On a 200k-token Opus session that is a real cost, paid again every time you come back.

This mod summarizes the conversation with Haiku instead. Haiku reads the transcript at a fraction of the price, and your main model then only re-caches a short summary. Your session model never changes.

## Install

```
/plugin install haiku-compact --marketplace kjhq/haiku-compact
```

Answer `y` to add the marketplace, then pick a scope.

## What it does

A band above the prompt shows your cache as it goes:

```
🔥 ▰▰▰▰▰▰▱▱▱▱ cache warm · 36m left · 204k cached
🧊 cache cold · 204k to re-cache (~$0.77)  [ squish with haiku ]
🌀 haiku is squishing 204k of context…
✨ squished 204k → 9k (−96%) by haiku · next turn re-caches the small one
```

Small contexts (under 40k tokens) get no band and are never touched.

When the cache is cold:

- **On resume.** Resuming a large session whose cache has expired squishes it with Haiku at once.
- **In an open session.** Your first prompt after the cache went cold is held, and `/compact haiku` is put in the prompt box. Press Enter to squish; your held prompt is sent right after. Or send your prompt again to skip that and use the full context.
- **Any time.** Press *squish with haiku* in the band, or type it yourself:

```
/compact haiku
/compact haiku keep the deployment plan and the open bugs
```

Anything after `haiku` is passed to the summarizer as what to keep or stress. Plain `/compact` and Claude Code's own auto-compaction are left alone.

## What the summary keeps

- The last few messages, word for word, cut at a prompt you typed so no tool call is split from its result.
- Everything before that, summarized: your requests, corrections, files and code touched, errors and fixes, decisions, where work stopped and the next step.
- Long transcripts are summarized in pieces of about 100k tokens, each carrying the summary so far.

If Haiku fails, the compaction is skipped and your transcript is left as it was. It never falls back to compacting on the expensive model.

## Settings

Set in `/config` or under `pluginConfigs` in `settings.json`:

| Option | Default | |
| --- | --- | --- |
| `summaryModel` | `haiku` | Model that summarizes, and the word after `/compact` that selects it. |
| `keepMessages` | `4` | Recent messages kept verbatim. |
| `cacheTtlMinutes` | `60` | Your cache TTL (60 or 5). The band counts down from it. |
| `minTokens` | `40000` | Smaller contexts get no band and no compaction. |
| `autoCompactOnResume` | `true` | Squish at once when resuming a cold session. |
| `holdPromptWhenCold` | `true` | Hold the first prompt after the cache went cold and offer `/compact haiku`. |

## Trade-offs

A summary is lossy, and a smaller model loses more than a larger one. On long technical sessions, exact details from early in the conversation may not survive. Use the notes after `/compact haiku` to name what must be kept, or turn the automatic parts off and squish only when you choose.

The idle countdown is an estimate from the time of the last turn; the engine's own cache-expiry flag is used on resume.

## Develop

```
claude plugin validate .
claude plugin test .
```

The Claude Code function-hooks API is early access and may change between releases.

## License

MIT
