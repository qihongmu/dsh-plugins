/**
 * Unit tests for the token-tracing client pure functions: formatting helpers
 * and the fold-free trace-update logic (no DOM, no live Remote).
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { cacheHitRatio, formatRatio, formatTokens } from '../src/client/format.ts'
import { mergeAttempt, sumBuckets, turnCacheHitRatio, upsertTurn } from '../src/client/trace-state.ts'
import type { AttemptTrace, TurnTrace } from '@qihongmu/dsh-plugins-token-tracing/types'

function attempt(overrides: Partial<AttemptTrace> = {}): AttemptTrace {
  return {
    seq: 1,
    turn: 1,
    step: 0,
    kind: 'llm',
    usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadTokens: 50, cacheWriteTokens: 10, reasoningTokens: 5 },
    promptTotal: 100,
    composition: null,
    additions: null,
    cache: { read: 50, write: 10, hitRatio: 0.5 },
    ...overrides,
  }
}

function trace(overrides: Partial<TurnTrace> = {}): TurnTrace {
  return {
    sessionId: 's1',
    turn: 1,
    status: 'complete',
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_100_000,
    attempts: [attempt()],
    totals: { inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadTokens: 50, cacheWriteTokens: 10, reasoningTokens: 5 },
    cacheEvents: [],
    ...overrides,
  }
}

describe('formatTokens', () => {
  it('formats compact token counts', () => {
    assert.equal(formatTokens(0), '0')
    assert.equal(formatTokens(840), '840')
    assert.equal(formatTokens(12_400), '12.4k')
    assert.equal(formatTokens(3_180_000), '3.18M')
  })
})

describe('formatRatio', () => {
  it('renders ratios as percentages and dashes for missing', () => {
    assert.equal(formatRatio(0.5), '50%')
    assert.equal(formatRatio(undefined), '—')
    assert.equal(formatRatio(Number.NaN), '—')
  })
})

describe('cacheHitRatio', () => {
  it('computes read/prompt from exact buckets', () => {
    assert.equal(cacheHitRatio({ inputTokens: 50, outputTokens: 20, totalTokens: 120, cacheReadTokens: 50 }), 0.5)
  })

  it('returns undefined without cacheRead or with an unprovable prompt', () => {
    assert.equal(cacheHitRatio(null), undefined)
    assert.equal(cacheHitRatio({ inputTokens: 50, outputTokens: 50, totalTokens: 50, cacheReadTokens: 0 }), undefined)
  })
})

describe('sumBuckets', () => {
  it('sums every reported bucket', () => {
    assert.deepEqual(sumBuckets([attempt(), attempt()]), {
      inputTokens: 200,
      outputTokens: 40,
      totalTokens: 240,
      cacheReadTokens: 100,
      cacheWriteTokens: 20,
      reasoningTokens: 10,
    })
  })

  it('returns null when no attempt reported usage', () => {
    assert.equal(sumBuckets([attempt({ usage: null })]), null)
  })

  it('returns null when any attempt lacks usage (mirrors the host engine)', () => {
    // One reported + one unreported attempt must NOT produce a partial sum —
    // the live dash would then contradict the host-issued turn frame.
    assert.equal(sumBuckets([attempt(), attempt({ usage: null })]), null)
  })

  it('sums reported optional buckets even when other attempts omit them', () => {
    // Attempt 2 reports no optional buckets; attempt 1's reported values must
    // still count toward the aggregate (a whole turn's reads used to vanish).
    assert.deepEqual(sumBuckets([attempt(), attempt({ usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } })]), {
      inputTokens: 101,
      outputTokens: 21,
      totalTokens: 122,
      cacheReadTokens: 50,
      cacheWriteTokens: 10,
      reasoningTokens: 5,
    })
  })

  it('sums each optional bucket over its reporting attempts', () => {
    // Attempt 2 reports cacheRead but not cacheWrite/reasoning (DeepSeek chat
    // shape): cacheRead aggregates; the others keep attempt 1's values.
    const mixed = attempt({ usage: { inputTokens: 10, outputTokens: 2, totalTokens: 30, cacheReadTokens: 8 } })
    assert.deepEqual(sumBuckets([attempt(), mixed]), {
      inputTokens: 110,
      outputTokens: 22,
      totalTokens: 150,
      cacheReadTokens: 58,
      cacheWriteTokens: 10,
      reasoningTokens: 5,
    })
  })
})

describe('turnCacheHitRatio', () => {
  it('averages over the attempts that reported cacheRead only', () => {
    const mixed = trace({
      attempts: [
        attempt({ usage: { inputTokens: 50, outputTokens: 10, totalTokens: 60 }, promptTotal: 50 }),
        // cacheRead omitted on this attempt (some responses lack the bucket)
        attempt({ seq: 2, usage: { inputTokens: 40, outputTokens: 10, totalTokens: 50 }, promptTotal: 40 }),
      ],
    })
    assert.equal(turnCacheHitRatio(mixed), undefined)
  })

  it('computes read/prompt over reporting attempts', () => {
    const mixed = trace({
      attempts: [
        attempt({ usage: { inputTokens: 50, outputTokens: 10, totalTokens: 60, cacheReadTokens: 25 }, promptTotal: 50 }),
        attempt({ seq: 2, usage: { inputTokens: 40, outputTokens: 10, totalTokens: 50, cacheReadTokens: 30 }, promptTotal: 40 }),
      ],
    })
    assert.equal(turnCacheHitRatio(mixed), 55 / 90)
  })

  it('returns undefined when no attempt has a provable prompt', () => {
    assert.equal(turnCacheHitRatio(trace({ attempts: [attempt({ promptTotal: null, usage: null })] })), undefined)
  })
})

describe('upsertTurn', () => {
  it('replaces an existing turn and sorts newest first', () => {
    const base = [trace({ turn: 2 }), trace({ turn: 1 })]
    const next = upsertTurn(base, trace({ turn: 1, attempts: [attempt({ seq: 9 })] }))
    assert.deepEqual(next.map(turn => turn.turn), [2, 1])
    assert.equal(next[1].attempts[0].seq, 9)
  })

  it('appends an unknown turn', () => {
    const next = upsertTurn([trace({ turn: 1 })], trace({ turn: 3 }))
    assert.deepEqual(next.map(turn => turn.turn), [3, 1])
  })
})

describe('mergeAttempt', () => {
  it('merges into the matching active turn without duplicating seqs', () => {
    const active = trace({ turn: 1, status: 'active', endedAt: null, attempts: [attempt({ seq: 1 })] })
    const merged = mergeAttempt(active, attempt({ seq: 2, step: 1 }))
    assert.equal(merged.status, 'active')
    assert.deepEqual(merged.attempts.map(item => item.seq), [1, 2])
    assert.equal(merged.totals?.totalTokens, 240)
  })

  it('creates a fresh active turn when the attempt belongs to a different turn', () => {
    const merged = mergeAttempt(null, attempt({ seq: 5, turn: 2 }))
    assert.equal(merged.turn, 2)
    assert.equal(merged.status, 'active')
    assert.equal(merged.attempts.length, 1)
  })
})
