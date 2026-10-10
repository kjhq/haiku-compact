# haiku-compact

A Claude Code mod that compacts your conversation with a cheap model.

Claude Code keeps your conversation in the prompt cache for a short while (5 minutes or 1 hour). Step away longer and the cache goes cold: your next message makes the main model re-read and re-cache the whole transcript at full price. On a 200k-token Opus session that is a real cost, paid again every time you come back.

`/compact haiku` summarizes the conversation with Haiku instead of your main model. Haiku reads the transcript at a fraction of the price, and your main model then only re-caches a short summary. Your session model never changes.

## Install

```
/plugin install haiku-compact --marketplace kjhq/haiku-compact
```

Answer `y` to add the marketplace, then pick a scope.

## Use

```
/compact haiku
/compact haiku keep the deployment plan and the open bugs
```

Anything after `haiku` is passed to the summarizer as what to keep or stress. Plain `/compact` and auto-compaction are left to Claude Code as usual.

The mod never compacts on its own. When the cache has likely gone cold (after a resume, or after a long idle in an open session) and the context is large, it shows a hint in the status line:

```
cache cold · 204k to re-cache (~$0.77) · /compact haiku to shrink it
```

The hint clears when the next turn starts.

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
| `hintIdleMinutes` | `60` | Idle minutes before the cold-cache hint. Match your cache TTL (5 or 60). `0` turns the idle hint off. |
| `hintMinTokens` | `40000` | Only hint for contexts at least this large. |

## Trade-offs

A summary is lossy, and a smaller model loses more than a larger one. On long technical sessions, exact details from early in the conversation may not survive. Use the notes after `/compact haiku` to name what must be kept.

## Develop

```
claude plugin validate .
claude plugin test .
```

The Claude Code function-hooks API is early access and may change between releases.

## License

MIT
