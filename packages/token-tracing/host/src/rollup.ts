/**
 * Rollup aggregation: completed-turn traces and maintenance attempts fold
 * into a durable per-session aggregate, and per-session aggregates merge
 * into cross-session day rollups. Pure arithmetic — no storage, no context.
 *
 * Cost口径: `totals` sums exact provider usage; `byComponent`/`byTool` sum the
 * calibrated composition estimates (the billed view — a component re-sent on
 * every request of a turn is billed every time, and this accounting reflects
 * that). By construction ΣbyComponent ≈ ΣpromptTotal across attempts.
 * @module @qihongmu/dsh-plugins-token-tracing/src/rollup
 */

import type {
  AttemptTrace,
  DayRollupView,
  RollupContribution,
  RollupQuery,
  SessionRollupView,
  TurnTrace,
} from './types.ts'
import { addBuckets, emptyBuckets } from './usage.ts'

/** Local-midnight-free UTC day key for an epoch-ms timestamp. */
export function dayKeyOf(timeMs: number): string {
  return new Date(timeMs).toISOString().slice(0, 10)
}

/** Add every numeric entry of `addend` into `target` (shared accumulation shape). */
function addInto(target: Record<string, number>, addend: Record<string, number>): Record<string, number> {
  for (const [key, tokens] of Object.entries(addend)) {
    target[key] = (target[key] ?? 0) + tokens
  }
  return target
}

function componentKey(split: { kind: string; name?: string }): string {
  return split.name === undefined ? split.kind : `${split.kind}/${split.name}`
}

export function emptyContribution(): RollupContribution {
  return { turns: 0, incompleteTurns: 0, totals: emptyBuckets(), byComponent: {}, byTool: {} }
}

export function emptySessionRollup(sessionId: string, sessionCreatedAt: number): SessionRollupView {
  return {
    sessionId,
    sessionCreatedAt,
    lastSeq: 0,
    turns: 0,
    incompleteTurns: 0,
    totals: emptyBuckets(),
    byComponent: {},
    byTool: {},
    byDay: {},
    firstAt: 0,
    lastAt: 0,
  }
}

function attemptComponents(attempt: AttemptTrace): { byComponent: Record<string, number>; byTool: Record<string, number> } {
  const byComponent: Record<string, number> = {}
  const byTool: Record<string, number> = {}
  const splits = attempt.composition ?? attempt.additions ?? []
  for (const split of splits) {
    const key = componentKey(split)
    byComponent[key] = (byComponent[key] ?? 0) + split.tokens
    if (split.kind === 'tool-result' && split.name !== undefined) {
      byTool[split.name] = (byTool[split.name] ?? 0) + split.tokens
    }
  }
  return { byComponent, byTool }
}

/** Fold one completed turn into the session rollup (idempotent per turn — callers own dedup). */
export function applyTurnToRollup(rollup: SessionRollupView, trace: TurnTrace): SessionRollupView {
  if (trace.attempts.length === 0) return rollup
  const day = dayKeyOf(trace.endedAt ?? trace.startedAt)
  const contribution = rollup.byDay[day] ?? emptyContribution()
  contribution.turns += 1
  if (trace.status !== 'complete') contribution.incompleteTurns += 1
  if (trace.totals !== null) addBuckets(contribution.totals, trace.totals)
  for (const attempt of trace.attempts) {
    const { byComponent, byTool } = attemptComponents(attempt)
    addInto(contribution.byComponent, byComponent)
    addInto(contribution.byTool, byTool)
  }
  rollup.byDay[day] = contribution
  rollup.turns += 1
  if (trace.status !== 'complete') rollup.incompleteTurns += 1
  if (trace.totals !== null) addBuckets(rollup.totals, trace.totals)
  addInto(rollup.byComponent, contribution.byComponent)
  addInto(rollup.byTool, contribution.byTool)
  rollup.latestTurn = Math.max(rollup.latestTurn ?? 0, trace.turn)
  rollup.firstAt = rollup.firstAt === 0 ? trace.startedAt : Math.min(rollup.firstAt, trace.startedAt)
  rollup.lastAt = Math.max(rollup.lastAt, trace.endedAt ?? trace.startedAt)
  return rollup
}

/**
 * Fold a turn-less (idle) compaction attempt into the rollup: real billed
 * cost with no owning turn, attributed to its own day (the attempt's own
 * close time — a backfill replay must not drift it into "today") under
 * `compaction`.
 */
export function applyMaintenanceToRollup(rollup: SessionRollupView, attempt: AttemptTrace): SessionRollupView {
  const day = dayKeyOf(attempt.time ?? Date.now())
  const contribution = rollup.byDay[day] ?? emptyContribution()
  if (attempt.usage !== null) addBuckets(contribution.totals, attempt.usage)
  const { byComponent } = attemptComponents(attempt)
  addInto(contribution.byComponent, byComponent)
  rollup.byDay[day] = contribution
  rollup.lastAt = Math.max(rollup.lastAt, attempt.time ?? Date.now())
  return rollup
}

/**
 * Merge per-session rollups into one row per UTC day. `sessions` counts
 * distinct sessions contributing to that day; rows sort newest first.
 */
export function mergeDayRollups(rollups: readonly SessionRollupView[], query: RollupQuery = {}): DayRollupView[] {
  const sinceMs = query.sinceDays === undefined ? undefined : Date.now() - query.sinceDays * 86_400_000
  const merged = new Map<string, { view: DayRollupView; sessions: Set<string> }>()
  for (const rollup of rollups) {
    for (const [day, contribution] of Object.entries(rollup.byDay)) {
      const dayStart = Date.parse(`${day}T00:00:00.000Z`)
      if (sinceMs !== undefined && dayStart < sinceMs) continue
      let entry = merged.get(day)
      if (entry === undefined) {
        entry = {
          view: {
            day,
            sessions: 0,
            turns: 0,
            incompleteTurns: 0,
            totals: emptyBuckets(),
            byComponent: {},
            byTool: {},
          },
          sessions: new Set(),
        }
        merged.set(day, entry)
      }
      entry.view.turns += contribution.turns
      entry.view.incompleteTurns += contribution.incompleteTurns
      addBuckets(entry.view.totals, contribution.totals)
      addInto(entry.view.byComponent, contribution.byComponent)
      addInto(entry.view.byTool, contribution.byTool)
      if (contribution.turns > 0 || contribution.totals.totalTokens > 0) entry.sessions.add(rollup.sessionId)
    }
  }
  const rows = [...merged.values()].map(entry => ({ ...entry.view, sessions: entry.sessions.size }))
  rows.sort((left, right) => right.day.localeCompare(left.day))
  return query.limit === undefined ? rows : rows.slice(0, Math.max(0, query.limit))
}
