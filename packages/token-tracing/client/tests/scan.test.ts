/**
 * Unit tests for the FR-13 oversized tool-result scanner: threshold
 * semantics (strictly above), composition/additions coverage, per-turn
 * dedup keeping the max observation, ordering, and the batch helper.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ComponentSplit } from '@qihongmu/dsh-plugins-token-tracing/types'
import { batchTurnNumbers, scanTurns } from '../src/client/dashboard/scan.ts'
import { LONG_RESULT_TOKENS, SCAN_BATCH_TURNS } from '../src/client/dashboard/suggest.ts'
import { attempt, toolResult, trace } from './fixtures.ts'

function splitOf(...components: ComponentSplit[]): ComponentSplit[] {
  return components
}

describe('scanTurns', () => {
  it('lists tool results strictly above the threshold, worst first', () => {
    const findings = scanTurns([
      trace(1, [attempt({ step: 1, composition: splitOf(toolResult('read', LONG_RESULT_TOKENS + 1), toolResult('grep', 500)) })]),
      trace(2, [attempt({ step: 1, composition: splitOf(toolResult('search', 12_000)) })]),
    ])
    assert.deepEqual(findings, [
      { turn: 2, step: 1, tool: 'search', tokens: 12_000 },
      { turn: 1, step: 1, tool: 'read', tokens: LONG_RESULT_TOKENS + 1 },
    ])
  })

  it('does not fire at or below the threshold', () => {
    const findings = scanTurns([
      trace(1, [attempt({ composition: splitOf(toolResult('read', LONG_RESULT_TOKENS)) })]),
      trace(2, [attempt({ composition: splitOf(toolResult('read', LONG_RESULT_TOKENS - 1)) })]),
    ])
    assert.deepEqual(findings, [])
  })

  it('covers in-series additions as well as series-start compositions', () => {
    const findings = scanTurns([
      trace(1, [
        attempt({ step: 1, composition: splitOf(toolResult('small', 100)) }),
        attempt({ step: 2, seq: 2, additions: splitOf(toolResult('huge', 9_500)) }),
      ]),
    ])
    assert.deepEqual(findings, [{ turn: 1, step: 2, tool: 'huge', tokens: 9_500 }])
  })

  it('deduplicates recompositions per turn, keeping the max observation', () => {
    // Cache invalidation: the same result re-enters via a later series-start
    // composition (plus a copy under a second tool, kept separately).
    const findings = scanTurns([
      trace(1, [
        attempt({ step: 1, composition: splitOf(toolResult('read', 9_000)) }),
        attempt({ step: 2, seq: 2, additions: splitOf(toolResult('write', 300)) }),
        attempt({ step: 3, seq: 3, composition: splitOf(toolResult('read', 9_400), toolResult('write', 300)) }),
      ]),
    ])
    assert.deepEqual(findings, [{ turn: 1, step: 3, tool: 'read', tokens: 9_400 }])
  })

  it('ignores attempts without a composition and non-tool-result components', () => {
    const findings = scanTurns([
      trace(1, [
        attempt({ composition: splitOf({ kind: 'system-prompt', tokens: 50_000, basis: 'estimated' }) }),
        attempt({ seq: 2, step: 2, kind: 'compaction', composition: null, additions: null }),
      ]),
    ])
    assert.deepEqual(findings, [])
  })

  it('keeps distinct tools of one turn as separate findings', () => {
    const findings = scanTurns([
      trace(7, [attempt({ composition: splitOf(toolResult('read', 9_000), toolResult('search', 8_500)) })]),
    ])
    assert.deepEqual(findings, [
      { turn: 7, step: 1, tool: 'read', tokens: 9_000 },
      { turn: 7, step: 1, tool: 'search', tokens: 8_500 },
    ])
  })

  it('breaks token ties by turn then tool', () => {
    const findings = scanTurns([
      trace(2, [attempt({ composition: splitOf(toolResult('b', 9_000)) })]),
      trace(1, [attempt({ composition: splitOf(toolResult('b', 9_000)) })]),
      trace(3, [attempt({ composition: splitOf(toolResult('a', 9_000)) })]),
    ])
    assert.deepEqual(findings.map(finding => [finding.turn, finding.tool]), [
      [1, 'b'], [2, 'b'], [3, 'a'],
    ])
  })
})

describe('batchTurnNumbers', () => {
  it('chunks ascending turns in batches of twenty with a remainder tail', () => {
    assert.deepEqual(batchTurnNumbers(45), [
      Array.from({ length: 20 }, (_, index) => index + 1),
      Array.from({ length: 20 }, (_, index) => index + 21),
      [41, 42, 43, 44, 45],
    ])
  })

  it('returns no batches below the first turn', () => {
    assert.deepEqual(batchTurnNumbers(0), [])
    assert.deepEqual(batchTurnNumbers(-3), [])
  })

  it('honors a custom batch size', () => {
    assert.deepEqual(batchTurnNumbers(5, 2), [[1, 2], [3, 4], [5]])
  })

  it('defaults to the shared scan batch size', () => {
    assert.equal(SCAN_BATCH_TURNS, 20)
  })
})
