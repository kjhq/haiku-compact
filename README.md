<div align="center">

# 🧊 haiku-compact

**Squish cold Claude Code sessions with Haiku before your main model re-caches them.**

[![license: MIT](https://img.shields.io/badge/license-MIT-black?style=flat-square)](LICENSE)
[![claude code mod](https://img.shields.io/badge/claude%20code-mod-d97757?style=flat-square)](https://github.com/kjhq/haiku-compact)
[![summarizer: haiku](https://img.shields.io/badge/summarizer-haiku-8a63d2?style=flat-square)](#settings)

```
🧊 cache cold · squish saves ~$1.70 of $2.00  [ squish ]
🌀 haiku squishing 204k…
✨ saved ~$1.68 · 204k → 9k
```

</div>

---

## Why

Claude Code keeps your conversation in the prompt cache for a while (5 minutes or 1 hour). Step away longer and the cache goes cold: your next message makes the main model re-read and re-cache the whole transcript at full price. On a 200k-token Opus session that is a real cost, paid again every time you come back.

haiku-compact summarizes the conversation with Haiku instead. Haiku reads the transcript at a fraction of the price, and your main model then re-caches a short summary. Your session model never changes.

## Install

```
/plugin install haiku-compact --marketplace kjhq/haiku-compact
```

Answer `y` to add the marketplace, then pick a scope.

## How it looks

While the cache is warm you see nothing. Once it goes cold, one line shows above the prompt:

| | |
| --- | --- |
| 🧊 **cold** | what re-caching costs and what a squish would save, with a *squish* button |
| 🌀 **squishing** | Haiku is reading the transcript |
| ✨ **saved** | what the squish saved you, net of the summary; gone after 30 seconds |

Prices come from Claude Code itself: its estimate on resume, or the rate implied by what your last turn cost. Until it knows a price, the line shows tokens (`204k to re-cache`). Small contexts (under 40k tokens) get no line and are never touched.

## When it squishes

- **On resume.** Resuming a large session whose cache has expired squishes it with Haiku at once.
- **In an open session.** Your first prompt after the cache went cold is held, and `/compact haiku` is put in the prompt box. Press Enter to squish; your held prompt is sent right after. Or send your prompt again to skip it and use the full context.
- **Any time.** Press *squish*, or type it yourself:

```
/compact haiku
/compact haiku keep the deployment plan and the open bugs
```

Anything after `haiku` tells the summarizer what to keep or stress. Plain `/compact` and Claude Code's own auto-compaction are left alone.

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
| `cacheTtlMinutes` | `60` | Your cache TTL (60 or 5). The line shows once it has passed. |
| `minTokens` | `40000` | Smaller contexts get no line and no compaction. |
| `autoCompactOnResume` | `true` | Squish at once when resuming a cold session. |
| `holdPromptWhenCold` | `true` | Hold the first prompt after the cache went cold and offer `/compact haiku`. |

## Trade-offs

- A summary is lossy, and a smaller model loses more than a larger one. Exact details from early in a long session may not survive. Name what must be kept after `/compact haiku`, or turn the automatic parts off and squish only when you choose.
- In an open session, "cold" is estimated from the time of your last turn; on resume, Claude Code's own cache-expiry flag is used.
- Dollar figures are estimates (hence the `~`).

## Develop

```
claude plugin validate .
claude plugin test .
```

The Claude Code function-hooks API is early access and may change between releases.

## License

[MIT](LICENSE) © Kripanshu Jindal
