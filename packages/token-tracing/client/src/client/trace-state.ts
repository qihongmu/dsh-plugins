/**
 * Pure fold-free trace state helpers shared by the token-tracing view and its
 * tests: usage summation, turn upsert, and live attempt merge. No DOM, no
 * Remote — the view feeds these from the follow stream frames.
 * @module @qihongmu/dsh-client-ui-token-tracing/src/client/trace-state
 */

import type { AttemptTrace, TurnTrace, UsageBuckets } from '@qihongmu/dsh-plugins-token-tracing/types'
import { sumUsageBuckets } from './usage.ts'

/**
 * Sum usage across attempts.
 *
 * MIRROR OF host/src/usage.ts `sumUsages` — the bundle boundary forces a copy,
 * but the SEMANTICS must stay identical or live numbers will contradict the
 * host-issued turn frames (dash shows a value, turn completes, flips to "—").
 * Rule: any attempt without usage → whole total null (exactness over
 * availability); bucket summing is shared with the dashboard (usage.ts).
 */
export function sumBuckets(attempts: readonly AttemptTrace[]): UsageBuckets | null {
  if (attempts.some(item => item.usage === null)) return null
  const known: UsageBuckets[] = []
  for (const item of attempts) {
    if (item.usage !== null) known.push(item.usage)
  }
  if (known.length === 0) return null
  return sumUsageBuckets(known)
}

/** Upsert a completed turn into a list ordered newest first. */
export function upsertTurn(turns: readonly TurnTrace[], next: TurnTrace): TurnTrace[] {
  const updated = turns.filter(existing => existing.turn !== next.turn)
  updated.push(next)
  updated.sort((left, right) => right.turn - left.turn)
  return updated
}

/** Merge a live attempt frame into the active turn (or start one). */
export function mergeAttempt(active: TurnTrace | null, attempt: AttemptTrace): TurnTrace {
  if (active === null || active.turn !== attempt.turn) {
    return {
      sessionId: '',
      turn: attempt.turn,
      status: 'active',
      startedAt: Date.now(),
      endedAt: null,
      attempts: [attempt],
      totals: sumBuckets([attempt]),
      cacheEvents: attempt.invalidated === true ? [{ atSeq: attempt.seq, kind: 'invalidated' }] : [],
    }
  }
  const attempts = active.attempts.filter(existing => existing.seq !== attempt.seq)
  attempts.push(attempt)
  attempts.sort((left, right) => left.seq - right.seq)
  return { ...active, attempts, totals: sumBuckets(attempts) }
}

/**
 * Cache hit ratio over the attempts that REPORTED cacheRead (some responses
 * omit the bucket — per-turn totals drop it entirely in that case, which would
 * hide the ratio even when most attempts reported it).
 */
export function turnCacheHitRatio(trace: TurnTrace): number | undefined {
  let read = 0
  let prompt = 0
  for (const attempt of trace.attempts) {
    if (attempt.usage?.cacheReadTokens !== undefined && attempt.promptTotal !== null) {
      read += attempt.usage.cacheReadTokens
      prompt += attempt.promptTotal
    }
  }
  if (prompt <= 0) return undefined
  return read / prompt
}
