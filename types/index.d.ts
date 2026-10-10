/** Where the prompt cache stands, as the band above the prompt draws it. */
export type CachePhase = 'none' | 'warm' | 'cold' | 'compacting' | 'done'

export type CacheState = {
  phase: CachePhase
  /** Context tokens the next request re-sends. */
  tokens: number
  /** When the cache is expected to go cold, in `$.clock.now()` milliseconds. */
  warmUntil: number
  /** Estimated cost of re-caching `tokens`, when the engine said. */
  costUsd?: number
  /** Context before and after the last compaction, in tokens. */
  before?: number
  after?: number
  /** One line about the last thing that went wrong, if anything. */
  note?: string
}

declare module 'claude-code' {
  interface PluginState {
    'haiku-compact': { cache: CacheState; now: number }
  }
}
