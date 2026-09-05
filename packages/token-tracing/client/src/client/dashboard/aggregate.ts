/**
 * Pure cross-day aggregation for the M3 dashboard: bucket sums, component /
 * tool merges, shares, cache ratios, and range-scoped per-session stats.
 * All inputs are rollup views; all outputs are plain values so the suggestion
 * engine and the panels stay testable without a host. No DOM, no Remote.
 * @module @qihongmu/dsh-client-ui-token-tracing/src/client/dashboard/aggregate
 */

import type { DayRollupView, SessionRollupView, UsageBuckets } from '@qihongmu/dsh-plugins-token-tracing/types'
import { cacheHitRatio } from '../format.ts'
import { sumUsageBuckets } from '../usage.ts'

/**
 * Sum the usage buckets across day rows — optional buckets survive only when
 * at least one row reported them (shared rule in usage.ts).
 */
export function sumDayBuckets(rows: readonly DayRollupView[]): UsageBuckets {
  return sumUsageBuckets(rows.map(row => row.totals))
}

/** Merge `byComponent` maps across day rows (plain key addition). */
export function mergeComponents(rows: readonly DayRollupView[]): Record<string, number> {
  const merged: Record<string, number> = {}
  for (const row of rows) {
    for (const [key, tokens] of Object.entries(row.byComponent)) {
      merged[key] = (merged[key] ?? 0) + tokens
    }
  }
  return merged
}

/** Merge `byTool` maps across day rows (plain key addition). */
export function mergeTools(rows: readonly DayRollupView[]): Record<string, number> {
  const merged: Record<string, number> = {}
  for (const row of rows) {
    for (const [tool, tokens] of Object.entries(row.byTool)) {
      merged[tool] = (merged[tool] ?? 0) + tokens
    }
  }
  return merged
}

/** Sum the positive values of a component map (the request-side denominator). */
export function positiveTotal(components: Record<string, number>): number {
  let total = 0
  for (const tokens of Object.values(components)) {
    if (tokens > 0) total += tokens
  }
  return total
}

/**
 * Sum a component family: the bare kind key plus every `kind/name` composite
 * the fold emits for it (`tool-result/read`, `injected-context/compact`, …).
 * Rollup rules reason about categories, but byComponent only stores leaves —
 * a bare-key lookup reads 0 for every named kind.
 */
export function componentFamilyTotal(components: Record<string, number>, family: string): number {
  let total = 0
  for (const [key, tokens] of Object.entries(components)) {
    if (key === family || key.startsWith(`${family}/`)) total += tokens
  }
  return total
}

/** One component-share row of the composition panel. */
export interface ShareRow {
  /** byComponent key: a ComponentKind, or `kind/name` for named components. */
  key: string
  tokens: number
  /** tokens / Σ positive tokens across all keys. */
  ratio: number
}

/**
 * Component share rows sorted by tokens desc. Negative keys (`context-shrink`
 * after compaction) are skipped — they cannot be drawn as a share of the
 * request side, and the exact totals shown elsewhere already include them.
 */
export function componentShares(components: Record<string, number>): ShareRow[] {
  let total = 0
  for (const tokens of Object.values(components)) {
    if (tokens > 0) total += tokens
  }
  if (total <= 0) return []
  return Object.entries(components)
    .filter(([, tokens]) => tokens > 0)
    .map(([key, tokens]) => ({ key, tokens, ratio: tokens / total }))
    .sort((left, right) => right.tokens - left.tokens || left.key.localeCompare(right.key))
}

/** One row of the Top-tools table. */
export interface ToolRow {
  tool: string
  tokens: number
  /** tokens / Σ positive component tokens (the request-side denominator). */
  share: number
  /** Sessions with any range-scoped usage of this tool. */
  reach: number
  /** Δ vs the previous period's same-tool tokens; undefined when the base is 0. */
  delta: number | undefined
}

export function toolRows(args: {
  tools: Record<string, number>
  componentsTotal: number
  previousTools: Record<string, number>
  sessions: readonly SessionRollupView[]
  startDay: string
}): ToolRow[] {
  const { tools, componentsTotal, previousTools, sessions, startDay } = args
  return Object.entries(tools)
    .map(([tool, tokens]) => ({
      tool,
      tokens,
      share: componentsTotal > 0 ? tokens / componentsTotal : 0,
      reach: sessions.reduce(
        (count, session) => count + (sessionRangeStats(session, startDay).byTool[tool] !== undefined ? 1 : 0),
        0,
      ),
      delta: deltaRatio(tokens, previousTools[tool] ?? 0),
    }))
    .sort((left, right) => right.tokens - left.tokens || left.tool.localeCompare(right.tool))
}

/** Per-day cache hit ratio; undefined when the day reported no readable prompt. */
export function dayCacheHit(row: DayRollupView): number | undefined {
  return cacheHitRatio(row.totals)
}

/**
 * Per-day average system-prompt size per completed turn. The rollup only
 * carries the day's summed component, and every model call re-sends the
 * system prompt, so the raw daily total tracks call volume as much as prompt
 * size — dividing by turns is the closest available normalization (DESIGN
 * has no per-attempt count). Undefined when the day has no completed turns.
 */
export function dayAvgSystemPrompt(row: DayRollupView): number | undefined {
  if (row.turns <= 0) return undefined
  return (row.byComponent['system-prompt'] ?? 0) / row.turns
}

/** Median of a numeric list (lower middle for even lengths); undefined when empty. */
export function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  const lower = sorted[middle - 1]
  const upper = sorted[middle]
  if (lower === undefined || upper === undefined) return undefined
  return sorted.length % 2 === 1 ? upper : (lower + upper) / 2
}

/** (current − previous) / previous; undefined when the base is not positive. */
export function deltaRatio(current: number, previous: number): number | undefined {
  if (previous <= 0) return undefined
  return (current - previous) / previous
}

/** Range-scoped per-session aggregate: only the session's `byDay` entries at or after `startDay`. */
export interface SessionRangeStats {
  turns: number
  totals: UsageBuckets
  byComponent: Record<string, number>
  byTool: Record<string, number>
}

/**
 * A session's `byDay` contributions as day rows, ascending; with `startDay`,
 * scoped to days at or after it. The shape both the range-scoped session
 * stats and the single-session suggestion variant consume.
 */
export function sessionDayRows(session: SessionRollupView, startDay?: string): DayRollupView[] {
  return Object.entries(session.byDay)
    .filter(([day]) => startDay === undefined || day >= startDay)
    .map(([day, contribution]) => ({
      day,
      sessions: 1,
      turns: contribution.turns,
      incompleteTurns: contribution.incompleteTurns,
      totals: contribution.totals,
      byComponent: contribution.byComponent,
      byTool: contribution.byTool,
    }))
    .sort((left, right) => left.day.localeCompare(right.day))
}

/**
 * Per-session numbers scoped to the selected period. Session rollups are
 * lifetime aggregates; the dashboard always shows the range slice, computed
 * from the session's own `byDay` contributions (zero when the session had no
 * completed turns in range — e.g. activity was interrupted turns only).
 */
export function sessionRangeStats(session: SessionRollupView, startDay: string): SessionRangeStats {
  const rows = sessionDayRows(session, startDay)
  return {
    turns: rows.reduce((acc, row) => acc + row.turns, 0),
    totals: sumDayBuckets(rows),
    byComponent: mergeComponents(rows),
    byTool: mergeTools(rows),
  }
}

/** Shorten a session id for row display: first 8 chars + ellipsis. */
export function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id
}
