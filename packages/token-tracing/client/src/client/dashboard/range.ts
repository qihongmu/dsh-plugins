/**
 * Pure period-splitting for the M3 dashboard: the fetched window (2× the
 * selected range) splits into the current period — the most recent
 * `rangeDays` UTC days, today included — and the previous one, which backs
 * every period-over-period Δ on the dashboard. No DOM, no Remote; the view
 * feeds these right after a fetch with the fetch timestamp.
 * @module @qihongmu/dsh-client-ui-token-tracing/src/client/dashboard/range
 */

import type { DayRollupView, SessionRollupView } from '@qihongmu/dsh-plugins-token-tracing/types'

/** Epoch ms → UTC calendar day `'YYYY-MM-DD'` (the host's day-bucket key). */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** Shift a `'YYYY-MM-DD'` day key by `delta` days (UTC arithmetic). */
export function shiftDay(day: string, delta: number): string {
  return utcDay(Date.parse(`${day}T00:00:00.000Z`) + delta * 86_400_000)
}

/** First day (inclusive) of the current period: today − (rangeDays − 1). */
export function periodStart(rangeDays: number, nowMs: number): string {
  return shiftDay(utcDay(nowMs), -(Math.max(1, rangeDays) - 1))
}

/** Current/previous period pair; `previous` may be empty (no older data). */
export interface SplitPeriods<T> {
  current: T[]
  previous: T[]
}

/**
 * Split day rows into current/previous periods. Rows older than the previous
 * period start are dropped — the fetch window is 2× the range, so at most
 * boundary stragglers land there. Both halves sort ascending by day.
 */
export function splitDays(days: readonly DayRollupView[], rangeDays: number, nowMs: number): SplitPeriods<DayRollupView> {
  const start = periodStart(rangeDays, nowMs)
  const previousStart = shiftDay(start, -rangeDays)
  const current: DayRollupView[] = []
  const previous: DayRollupView[] = []
  for (const row of days) {
    if (row.day >= start) current.push(row)
    else if (row.day >= previousStart) previous.push(row)
  }
  current.sort((left, right) => left.day.localeCompare(right.day))
  previous.sort((left, right) => left.day.localeCompare(right.day))
  return { current, previous }
}

/**
 * Split session rollups by last activity into current/previous periods.
 * Note the rollups themselves are lifetime aggregates — range-scoped per-
 * session numbers come from `sessionRangeStats` (aggregate.ts).
 */
export function splitSessions(sessions: readonly SessionRollupView[], rangeDays: number, nowMs: number): SplitPeriods<SessionRollupView> {
  const startMs = Date.parse(`${periodStart(rangeDays, nowMs)}T00:00:00.000Z`)
  const current: SessionRollupView[] = []
  const previous: SessionRollupView[] = []
  for (const row of sessions) {
    if (row.lastAt >= startMs) current.push(row)
    else previous.push(row)
  }
  return { current, previous }
}

/** Ascending list of the current period's day keys, today last. */
export function dayWindow(rangeDays: number, nowMs: number): string[] {
  const start = periodStart(rangeDays, nowMs)
  const today = utcDay(nowMs)
  const window: string[] = []
  for (let day = start; day <= today; day = shiftDay(day, 1)) window.push(day)
  return window
}
