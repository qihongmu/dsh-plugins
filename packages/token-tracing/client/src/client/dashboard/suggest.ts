/**
 * Rule-based optimization suggestions for the M3 dashboard — a pure engine:
 * rollup slices in, ordered suggestions out. Copy is NOT baked in: each
 * suggestion carries a ruleId + interpolation params, and the panel resolves
 * `rule.<id>.title/.detail` through i18n at render time. Every rule emits at
 * most one suggestion (the most extreme target) and each carries evidence
 * the UI can locate (scroll + highlight).
 * @module @qihongmu/dsh-client-ui-token-tracing/src/client/dashboard/suggest
 */

import type { DayRollupView, SessionRollupView } from '@qihongmu/dsh-plugins-token-tracing/types'
import { cacheHitRatio, formatTokens } from '../format.ts'
import {
  componentFamilyTotal, dayAvgSystemPrompt, dayCacheHit, mergeComponents, mergeTools,
  median, positiveTotal, sessionDayRows, sessionRangeStats, shortId, sumDayBuckets,
} from './aggregate.ts'
import type { SessionRangeStats } from './aggregate.ts'

/** Initial rule thresholds — single source, locked by unit tests. */
export const SUGGESTION_THRESHOLDS = {
  /** R1: a single tool's share of the request side. */
  r1ToolShare: 0.4,
  /** R2a: range-wide cache hit ratio below this fires the "low hit" note. */
  r2aCacheHit: 0.5,
  /** R2b: consecutive-day hit-ratio drop, in percentage points. */
  r2bCacheDropPp: 20,
  /** R3: current-period daily per-turn system-prompt average vs the previous period. */
  r3Growth: 1.2,
  /** R4: injected-context + runtime-context share of the request side. */
  r4InjectedShare: 0.15,
  /** R5: compaction share of the request side. */
  r5CompactionShare: 0.1,
  /** R7: a session's range tokens vs the per-session median — the outlier
      gate; the session is reported only when a pathology is found too. */
  r7SessionFactor: 3,
} as const

/**
 * FR-13 (P2): the session scan lists tool-result components whose tokens
 * exceed this many (strictly above — a result at exactly the threshold is
 * tolerable). Same file as the suggestion thresholds per DESIGN §10.8.
 */
export const LONG_RESULT_TOKENS = 8_000

/** traceBatch batch size for the scan (DESIGN §10.8: 20 turns per batch, serial). */
export const SCAN_BATCH_TURNS = 20

export type SuggestionSeverity = 'high' | 'medium' | 'info'

export type SuggestionRuleId =
  | 'r1' | 'r2a' | 'r2b' | 'r3' | 'r4' | 'r5'
  | 'r7cache' | 'r7tool' | 'r7compaction' | 'r7injected'

/** Where the evidence lives; the UI scrolls to and highlights this anchor. */
export interface SuggestionEvidence {
  kind: 'tool' | 'component' | 'day' | 'session'
  /** Tool name / byComponent key / day key / session id. */
  key: string
}

export interface Suggestion {
  ruleId: SuggestionRuleId
  severity: SuggestionSeverity
  /** i18n interpolation params for `rule.<id>.title` / `.detail`. */
  params: Record<string, string | number>
  evidence: SuggestionEvidence
}

export interface SuggestionInput {
  /** Current-period day rows, ascending. */
  days: readonly DayRollupView[]
  /** Previous-period day rows (may be empty; R3 needs it). */
  previousDays: readonly DayRollupView[]
  /** Sessions active in the current period. */
  sessions: readonly SessionRollupView[]
}

const SEVERITY_ORDER: Record<SuggestionSeverity, number> = { high: 0, medium: 1, info: 2 }

function pct(ratio: number): number {
  return Math.round(ratio * 100)
}

/**
 * Classify a heavy session's concrete pathology, or return null when it is
 * merely heavy. A long output-driven task with a healthy cache is workload,
 * not waste — suggesting "split it" there reads as a false alarm. Cause
 * order is fixed: cache first (the costliest breaker), then component
 * shares, reusing the range-level thresholds so a session cause means the
 * same magnitude as its range-level rule.
 */
function heavySessionSuggestion(
  peak: { session: SessionRollupView; range: SessionRangeStats; tokens: number },
  factor: number,
  thresholds: typeof SUGGESTION_THRESHOLDS,
): Suggestion | null {
  // Params are display strings: the copy interpolates them verbatim (PRD §9 —
  // numbers reach i18n through the shared formatters).
  const base = { id: shortId(peak.session.sessionId), tokens: formatTokens(peak.tokens), factor }
  const evidence: SuggestionEvidence = { kind: 'session', key: peak.session.sessionId }
  const total = positiveTotal(peak.range.byComponent)
  const share = (family: string): number =>
    total > 0 ? componentFamilyTotal(peak.range.byComponent, family) / total : 0
  const hit = cacheHitRatio(peak.range.totals)
  if (hit !== undefined && hit < thresholds.r2aCacheHit) {
    return { ruleId: 'r7cache', severity: 'high', params: { ...base, pct: pct(hit) }, evidence }
  }
  if (share('tool-result') >= thresholds.r1ToolShare) {
    return { ruleId: 'r7tool', severity: 'medium', params: { ...base, pct: pct(share('tool-result')) }, evidence }
  }
  if (share('compaction') >= thresholds.r5CompactionShare) {
    return { ruleId: 'r7compaction', severity: 'medium', params: { ...base, pct: pct(share('compaction')) }, evidence }
  }
  const injected = share('injected-context') + share('runtime-context')
  if (injected >= thresholds.r4InjectedShare) {
    return { ruleId: 'r7injected', severity: 'medium', params: { ...base, pct: pct(injected) }, evidence }
  }
  return null
}

/**
 * Derive the range-scope suggestions, severity-ordered. Every rule names a
 * concrete pathology — pure outlier pointers (the former day-spike R6) stay
 * out: the daily composition chart already surfaces spikes, and a heavy but
 * healthy session is workload, not waste. R3 is skipped when the previous
 * period has no data; R7 needs ≥ 2 active sessions AND a pathology in the
 * outlier session. R2a/R2b need reported cacheRead buckets. Component rules
 * address families — the bare kind plus its `kind/name` composites, matching
 * the leaf keys the fold actually stores.
 */
export function deriveSuggestions(input: SuggestionInput): Suggestion[] {
  const thresholds = SUGGESTION_THRESHOLDS
  const out: Suggestion[] = []
  const { days, previousDays, sessions } = input

  const components = mergeComponents(days)
  const componentsTotal = positiveTotal(components)

  if (componentsTotal > 0) {
    // R1 — a single tool dominating the request side.
    const tools = mergeTools(days)
    let topTool: { tool: string; share: number } | null = null
    for (const [tool, tokens] of Object.entries(tools)) {
      const share = tokens / componentsTotal
      if (topTool === null || share > topTool.share) topTool = { tool, share }
    }
    if (topTool !== null && topTool.share >= thresholds.r1ToolShare) {
      out.push({
        ruleId: 'r1',
        severity: 'high',
        params: { tool: topTool.tool, pct: pct(topTool.share) },
        evidence: { kind: 'tool', key: topTool.tool },
      })
    }

    // R4 — injected context (context files + runtime snapshot) share.
    const injectedShare
      = (componentFamilyTotal(components, 'injected-context')
        + componentFamilyTotal(components, 'runtime-context')) / componentsTotal
    if (injectedShare >= thresholds.r4InjectedShare) {
      out.push({
        ruleId: 'r4',
        severity: 'medium',
        params: { pct: pct(injectedShare) },
        evidence: { kind: 'component', key: 'injected-context' },
      })
    }

    // R5 — compaction summaries as a share of the request side.
    const compactionShare = componentFamilyTotal(components, 'compaction') / componentsTotal
    if (compactionShare >= thresholds.r5CompactionShare) {
      out.push({
        ruleId: 'r5',
        severity: 'medium',
        params: { pct: pct(compactionShare) },
        evidence: { kind: 'component', key: 'compaction' },
      })
    }
  }

  // R2a — range-wide cache hit below threshold; evidence anchors the worst day.
  const rangeHit = cacheHitRatio(sumDayBuckets(days))
  if (rangeHit !== undefined && rangeHit < thresholds.r2aCacheHit) {
    let worst: { day: string; hit: number } | null = null
    for (const row of days) {
      const hit = dayCacheHit(row)
      if (hit !== undefined && (worst === null || hit < worst.hit)) worst = { day: row.day, hit }
    }
    if (worst !== null) {
      out.push({
        ruleId: 'r2a',
        severity: 'medium',
        params: { pct: pct(rangeHit) },
        evidence: { kind: 'day', key: worst.day },
      })
    }
  }

  // R2b — largest consecutive-day hit-ratio drop.
  const hitSeries = days
    .map(row => ({ day: row.day, hit: dayCacheHit(row) }))
    .filter((entry): entry is { day: string; hit: number } => entry.hit !== undefined)
  let worstDrop: { day: string; pp: number } | null = null
  for (let index = 1; index < hitSeries.length; index += 1) {
    const previousEntry = hitSeries[index - 1]
    const currentEntry = hitSeries[index]
    if (previousEntry === undefined || currentEntry === undefined) continue
    const pp = (previousEntry.hit - currentEntry.hit) * 100
    if (pp > thresholds.r2bCacheDropPp && (worstDrop === null || pp > worstDrop.pp)) {
      worstDrop = { day: currentEntry.day, pp }
    }
  }
  if (worstDrop !== null) {
    out.push({
      ruleId: 'r2b',
      severity: 'high',
      params: { day: worstDrop.day, pp: Math.round(worstDrop.pp) },
      evidence: { kind: 'day', key: worstDrop.day },
    })
  }

  // R3 — system-prompt growth vs the previous period, on per-turn averages:
  // the raw daily total also tracks call volume, which would dress usage
  // growth up as prompt inflation.
  if (previousDays.length > 0) {
    const avgOf = (rows: readonly DayRollupView[]): number => {
      const perTurn = rows
        .map(row => dayAvgSystemPrompt(row))
        .filter((value): value is number => value !== undefined)
      if (perTurn.length === 0) return 0
      return perTurn.reduce((acc, value) => acc + value, 0) / perTurn.length
    }
    const previousAvg = avgOf(previousDays)
    const currentAvg = avgOf(days)
    if (previousAvg > 0 && currentAvg / previousAvg >= thresholds.r3Growth) {
      out.push({
        ruleId: 'r3',
        severity: 'high',
        params: { pct: pct(currentAvg / previousAvg - 1) },
        evidence: { kind: 'component', key: 'system-prompt' },
      })
    }
  }

  // R7 — a session whose range tokens dwarf the per-session median, reported
  // only with a concrete pathology (heavySessionSuggestion).
  if (sessions.length >= 2) {
    const startDay = days[0]?.day ?? ''
    const stats = sessions.map(session => ({
      session,
      range: sessionRangeStats(session, startDay),
    })).filter(entry => entry.range.totals.totalTokens > 0)
    if (stats.length >= 2) {
      const med = median(stats.map(entry => entry.range.totals.totalTokens))
      let peak: { session: SessionRollupView; range: SessionRangeStats; tokens: number } | null = null
      for (const entry of stats) {
        if (peak === null || entry.range.totals.totalTokens > peak.tokens) {
          peak = { session: entry.session, range: entry.range, tokens: entry.range.totals.totalTokens }
        }
      }
      if (med !== undefined && med > 0 && peak !== null && peak.tokens >= med * thresholds.r7SessionFactor) {
        const suggestion = heavySessionSuggestion(peak, Math.round(peak.tokens / med), thresholds)
        if (suggestion !== null) out.push(suggestion)
      }
    }
  }

  return out.sort((left, right) =>
    SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity]
    || left.ruleId.localeCompare(right.ruleId))
}

/**
 * Single-session variant: the session's own `byDay` slices become the day
 * rows, so the shared rules apply unchanged. Cross-session/period rules
 * (R3, R7) drop out naturally — no baseline days, one session.
 */
export function deriveSessionSuggestions(session: SessionRollupView): Suggestion[] {
  return deriveSuggestions({ days: sessionDayRows(session), previousDays: [], sessions: [session] })
}
