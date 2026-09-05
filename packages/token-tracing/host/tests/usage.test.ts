/**
 * Unit tests for the exact usage arithmetic: prompt-total derivation paths,
 * the harness TokenUsage conversion, and the strict aggregation semantics.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { promptTotalOf, sumUsages, toBuckets } from '../src/usage.ts'
import type { UsageBuckets } from '../src/types.ts'

describe('promptTotalOf', () => {
  it('prefers the exact total minus output', () => {
    assert.equal(promptTotalOf({ inputTokens: 50, outputTokens: 20, totalTokens: 120, cacheReadTokens: 50 }), 100)
  })

  it('falls back to the known prompt buckets when the total is inconsistent', () => {
    // total < output is unprovable — fall back to input + cacheRead + cacheWrite.
    assert.equal(
      promptTotalOf({ inputTokens: 10, outputTokens: 5, totalTokens: 3, cacheReadTokens: 2, cacheWriteTokens: 3 }),
      15,
    )
  })

  it('returns 0 for a genuinely empty report and null only via callers', () => {
    assert.equal(promptTotalOf({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }), 0)
  })
})

describe('toBuckets', () => {
  it('keeps a provider-reported total and the reported optional buckets', () => {
    assert.deepEqual(
      toBuckets({ inputTokens: 10, outputTokens: 4, totalTokens: 14, reasoningTokens: 2 }),
      { inputTokens: 10, outputTokens: 4, totalTokens: 14, reasoningTokens: 2 },
    )
  })

  it('derives the total when the provider omitted it (token-meter invariant)', () => {
    const derived = toBuckets({ inputTokens: 10, outputTokens: 4, cacheReadTokens: 6, cacheWriteTokens: 1 })
    assert.equal(derived.totalTokens, 21)
  })
})

describe('sumUsages', () => {
  it('returns null when any attempt lacks usage (strict exactness)', () => {
    const partial: UsageBuckets = { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
    assert.equal(sumUsages([partial, null]), null)
  })

  it('sums reported optional buckets independently of the others', () => {
    const withCache: UsageBuckets = { inputTokens: 50, outputTokens: 10, totalTokens: 60, cacheReadTokens: 25 }
    const withoutOptionals: UsageBuckets = { inputTokens: 40, outputTokens: 10, totalTokens: 50 }
    assert.deepEqual(sumUsages([withCache, withoutOptionals]), {
      inputTokens: 90,
      outputTokens: 20,
      totalTokens: 110,
      cacheReadTokens: 25,
    })
  })
})
