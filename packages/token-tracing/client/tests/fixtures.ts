/**
 * Synthetic rollup fixtures for the M3 dashboard pure-function tests: small,
 * explicit builders over DayRollupView / SessionRollupView with neutral demo
 * values. Kept beside the tests (not in src) — they are test-only.
 */

import type {
  AttemptTrace, DayRollupView, RollupContribution, SessionRollupView, TurnTrace, UsageBuckets,
} from '@qihongmu/dsh-plugins-token-tracing/types'

export const BASE_DAY = '2026-08-15'

/** Noon UTC of BASE_DAY — safely inside the day for boundary tests. */
export const BASE_MS = Date.parse(`${BASE_DAY}T12:00:00.000Z`)

export function buckets(overrides: Partial<UsageBuckets> = {}): UsageBuckets {
  return { inputTokens: 100, outputTokens: 20, totalTokens: 120, ...overrides }
}

export function contribution(overrides: Partial<RollupContribution> = {}): RollupContribution {
  return {
    turns: 1,
    incompleteTurns: 0,
    totals: buckets(),
    // Production leaf-key shape: the fold names tool results and injected
    // content as `kind/name` composites, never a bare family key.
    byComponent: { 'system-prompt': 60, 'tool-result/read': 40 },
    byTool: { read: 40 },
    ...overrides,
  }
}

export function day(dayKey: string, overrides: Partial<Omit<DayRollupView, 'day'>> = {}): DayRollupView {
  return {
    day: dayKey,
    sessions: 1,
    turns: 1,
    incompleteTurns: 0,
    totals: buckets(),
    byComponent: { 'system-prompt': 60, 'tool-result/read': 40 },
    byTool: { read: 40 },
    ...overrides,
  }
}

export function session(id: string, overrides: Partial<Omit<SessionRollupView, 'sessionId'>> = {}): SessionRollupView {
  return {
    sessionId: id,
    sessionCreatedAt: BASE_MS,
    lastSeq: 10,
    turns: 1,
    incompleteTurns: 0,
    totals: buckets(),
    byComponent: { 'system-prompt': 60, 'tool-result/read': 40 },
    byTool: { read: 40 },
    byDay: { [BASE_DAY]: contribution() },
    firstAt: BASE_MS,
    lastAt: BASE_MS,
    ...overrides,
  }
}

/** Named tool-result component split for trace fixtures. */
export function toolResult(name: string, tokens: number): { kind: 'tool-result'; name: string; tokens: number; basis: 'estimated' } {
  return { kind: 'tool-result', name, tokens, basis: 'estimated' }
}

export function attempt(overrides: Partial<AttemptTrace> = {}): AttemptTrace {
  return {
    seq: 1,
    turn: 1,
    step: 1,
    kind: 'llm',
    usage: buckets(),
    promptTotal: 120,
    composition: null,
    additions: null,
    cache: null,
    ...overrides,
  }
}

export function trace(
  turn: number,
  attempts: AttemptTrace[],
  overrides: Partial<Omit<TurnTrace, 'turn' | 'attempts'>> = {},
): TurnTrace {
  return {
    sessionId: 'session-1',
    turn,
    status: 'complete',
    startedAt: BASE_MS,
    endedAt: BASE_MS,
    attempts,
    totals: buckets(),
    cacheEvents: [],
    ...overrides,
  }
}
