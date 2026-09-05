/**
 * Wire-facing pure types for the token-tracing plugin. Client-safe: no
 * runtime imports, branded ids flattened to plain strings, JSON-serializable
 * throughout. The vendored remote-client codecs (zod) must stay in sync with
 * every shape declared here.
 * @module @qihongmu/dsh-plugins-token-tracing/types
 */

/**
 * Provider-reported usage buckets for one billed attempt, mirroring the dsh
 * `TokenUsage` field-for-field. `inputTokens` is uncached prompt input only;
 * `inputTokens + cacheReadTokens + cacheWriteTokens` equals the full prompt
 * whenever the provider reports all three.
 */
export interface UsageBuckets {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

/** One attributed token component on the request/response chain. */
export interface ComponentSplit {
  kind: ComponentKind
  /** Tool name for tool results, plugin name for injected context. */
  name?: string
  /** Attributed tokens; negative for `context-shrink`. */
  tokens: number
  /** `exact` — provable from provider numbers; `estimated` — calibrated estimate. */
  basis: 'exact' | 'estimated'
}

export type ComponentKind =
  | 'user-input'
  | 'injected-context'
  | 'runtime-context'
  | 'system-prompt'
  | 'tool-definitions'
  | 'tool-result'
  | 'assistant-output'
  | 'reasoning'
  | 'compaction'
  | 'context-shrink'
  | 'unattributed'

/** One billed LLM call (or compaction LLM call) inside a turn. */
export interface AttemptTrace {
  /** Seq of the event that closed the attempt (assistant/message, llm/retry, compaction/summary). */
  seq: number
  turn: number
  step: number
  /** Wall-clock close time (epoch ms) — day-bucketing for maintenance attempts. */
  time?: number
  kind: 'llm' | 'compaction'
  retry?: true
  interrupted?: true
  /** Exact provider usage; null when the adapter reported none. */
  usage: UsageBuckets | null
  /** Prompt-side total for this request: totalTokens - outputTokens when provable. */
  promptTotal: number | null
  /** Full request composition (calibrated estimate), present at series starts. */
  composition: ComponentSplit[] | null
  /** Exact-total additions vs the previous attempt in the same series. */
  additions: ComponentSplit[] | null
  cache: { read: number; write: number; hitRatio: number } | null
  /** The prefix cache is believed invalidated at this attempt. */
  invalidated?: true
}

/** Token accounting of one user turn — the plugin's core wire product. */
export interface TurnTrace {
  sessionId: string
  turn: number
  status: 'active' | 'complete' | 'incomplete'
  startedAt: number
  endedAt: number | null
  attempts: AttemptTrace[]
  /** Exact sum over every attempt with usage; null when any attempt lacks usage. */
  totals: UsageBuckets | null
  cacheEvents: { atSeq: number; kind: 'invalidated' | 'compacted' }[]
}

/** Aggregated usage contribution of one session (or one day) per UTC day. */
export interface RollupContribution {
  turns: number
  incompleteTurns: number
  totals: UsageBuckets
  /** Composite-keyed token totals: kind, or `kind/name` for named components (estimated basis). */
  byComponent: Record<string, number>
  /** Per-tool result token totals (estimated basis). */
  byTool: Record<string, number>
}

/** Durable per-session aggregate maintained incrementally from completed turns. */
export interface SessionRollupView {
  sessionId: string
  sessionCreatedAt: number
  /** Fold-engine version that produced these numbers; mismatched rows are re-backfilled. */
  engine?: number
  /** Highest session-log seq folded into these numbers. */
  lastSeq: number
  /** Highest turn number actually traced (the turn COUNT is lower when zero-attempt turns are dropped). */
  latestTurn?: number
  turns: number
  incompleteTurns: number
  totals: UsageBuckets
  byComponent: Record<string, number>
  byTool: Record<string, number>
  byDay: Record<string, RollupContribution>
  firstAt: number
  lastAt: number
}

/** Cross-session aggregate for one UTC day. */
export interface DayRollupView {
  day: string
  sessions: number
  turns: number
  incompleteTurns: number
  totals: UsageBuckets
  byComponent: Record<string, number>
  byTool: Record<string, number>
}

/** Query options for `sessions` and `days`. */
export interface RollupQuery {
  /** Maximum rows (default 50). */
  limit?: number
  /** Only include rows newer than this many days. */
  sinceDays?: number
}

/** Live frames pushed by the `follow` stream. */
export type TokenTraceFrame =
  | { kind: 'snapshot'; summary: SessionRollupView; activeTurn: TurnTrace | null }
  | { kind: 'turn'; trace: TurnTrace }
  | { kind: 'attempt'; sessionId: string; attempt: AttemptTrace }
