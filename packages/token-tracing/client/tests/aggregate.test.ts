/**
 * Unit tests for the M3 dashboard cross-day aggregation: bucket sums,
 * component/tool merges, shares, cache ratios, medians, deltas, and
 * range-scoped per-session stats. Pure functions — no DOM, no Remote.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { DayRollupView } from '@qihongmu/dsh-plugins-token-tracing/types'
import { buckets, contribution, day, session } from './fixtures.ts'
import {
  componentShares, dayAvgSystemPrompt, dayCacheHit, deltaRatio,
  mergeComponents, mergeTools, median, sessionRangeStats, sumDayBuckets, toolRows,
} from '../src/client/dashboard/aggregate.ts'
import { cacheHitRatio } from '../src/client/format.ts'

describe('sumDayBuckets', () => {
  it('sums the mandatory buckets across rows', () => {
    const rows = [day('2026-08-14'), day('2026-08-15', { totals: buckets({ inputTokens: 50, totalTokens: 70 }) })]
    const totals = sumDayBuckets(rows)
    assert.equal(totals.inputTokens, 150)
    assert.equal(totals.outputTokens, 40)
    assert.equal(totals.totalTokens, 190)
  })

  it('keeps optional buckets only when at least one row reported them', () => {
    const reported = day('2026-08-14', { totals: buckets({ cacheReadTokens: 30, reasoningTokens: 5 }) })
    const totals = sumDayBuckets([reported, day('2026-08-15')])
    assert.equal(totals.cacheReadTokens, 30)
    assert.equal(totals.reasoningTokens, 5)
    assert.equal(totals.cacheWriteTokens, undefined)
  })

  it('returns zeroed buckets without optionals for empty input', () => {
    const totals = sumDayBuckets([])
    assert.deepEqual(totals, { inputTokens: 0, outputTokens: 0, totalTokens: 0 })
  })
})

describe('mergeComponents / mergeTools', () => {
  it('adds keys across rows', () => {
    const rows = [
      day('2026-08-14'),
      day('2026-08-15', { byComponent: { 'system-prompt': 10, 'tool-result/read': 25 }, byTool: { read: 25, grep: 5 } }),
    ]
    assert.deepEqual(mergeComponents(rows), { 'system-prompt': 70, 'tool-result/read': 65 })
    assert.deepEqual(mergeTools(rows), { read: 65, grep: 5 })
  })
})

describe('componentShares', () => {
  it('sorts desc and ratios over the positive total', () => {
    const rows = componentShares({ 'system-prompt': 60, 'tool-result': 30, 'user-input': 10 })
    assert.deepEqual(rows.map(row => row.key), ['system-prompt', 'tool-result', 'user-input'])
    assert.ok(Math.abs(rows.reduce((acc, row) => acc + row.ratio, 0) - 1) < 1e-9)
  })

  it('skips negative keys and returns [] when nothing is positive', () => {
    assert.deepEqual(componentShares({ 'system-prompt': 50, 'context-shrink': -20 }).map(row => row.key), ['system-prompt'])
    assert.deepEqual(componentShares({ 'context-shrink': -20 }), [])
    assert.deepEqual(componentShares({}), [])
  })
})

describe('cache hit ratios', () => {
  it('cacheHitRatio: cacheRead/(total − output)', () => {
    assert.equal(cacheHitRatio(buckets({ cacheReadTokens: 40 })), 0.4)
    assert.equal(cacheHitRatio(buckets()), undefined)                 // no cacheRead bucket
    assert.equal(cacheHitRatio(buckets({ cacheReadTokens: 10, outputTokens: 100, totalTokens: 100 })), undefined)
  })

  it('dayCacheHit delegates to the day totals', () => {
    const row: DayRollupView = day('2026-08-15', { totals: buckets({ cacheReadTokens: 25 }) })
    assert.equal(dayCacheHit(row), 0.25)
  })
})

describe('dayAvgSystemPrompt', () => {
  it('system-prompt total / turns; undefined when the day has no turns', () => {
    assert.equal(dayAvgSystemPrompt(day('2026-08-15', { turns: 2, byComponent: { 'system-prompt': 120 } })), 60)
    assert.equal(dayAvgSystemPrompt(day('2026-08-15', { turns: 0 })), undefined)
  })
})

describe('median', () => {
  it('picks the middle; lower-middle for even lengths; undefined when empty', () => {
    assert.equal(median([3, 1, 2]), 2)
    assert.equal(median([4, 1, 2, 3]), 2.5)
    assert.equal(median([]), undefined)
  })
})

describe('deltaRatio', () => {
  it('signed ratio; undefined on a non-positive base', () => {
    assert.equal(deltaRatio(150, 100), 0.5)
    assert.equal(deltaRatio(50, 100), -0.5)
    assert.equal(deltaRatio(10, 0), undefined)
  })
})

describe('sessionRangeStats', () => {
  it('scopes the session aggregate to days at/after startDay', () => {
    const rollup = session('s1', {
      byDay: {
        '2026-08-01': contribution({ turns: 5, totals: buckets({ totalTokens: 5_000 }), byTool: { legacy: 999 } }),
        '2026-08-14': contribution(),
        '2026-08-15': contribution({ turns: 2, totals: buckets({ totalTokens: 240 }), byTool: { read: 80 } }),
      },
    })
    const stats = sessionRangeStats(rollup, '2026-08-14')
    assert.equal(stats.turns, 3)
    assert.equal(stats.totals.totalTokens, 360)
    assert.deepEqual(stats.byTool, { read: 120 })
  })

  it('zeros when the session has no in-range days', () => {
    const stats = sessionRangeStats(session('s1'), '2026-09-01')
    assert.equal(stats.turns, 0)
    assert.equal(stats.totals.totalTokens, 0)
    assert.deepEqual(stats.byTool, {})
  })
})

describe('toolRows', () => {
  const startDay = '2026-08-14'

  it('computes share, range-scoped reach, and previous-period delta', () => {
    const sessions = [
      session('a', { byDay: { '2026-08-14': contribution(), '2026-08-15': contribution({ byTool: { grep: 7 } }) } }),
      session('b', { byDay: { '2026-08-15': contribution() } }),
      session('c', { byDay: { '2026-07-01': contribution() } }), // outside the range
    ]
    const rows = toolRows({
      tools: { read: 40, grep: 7 },
      componentsTotal: 100,
      previousTools: { read: 20 },
      sessions,
      startDay,
    })
    assert.deepEqual(rows.map(row => row.tool), ['read', 'grep'])
    const read = rows[0]
    assert.equal(read.share, 0.4)
    assert.equal(read.reach, 2)      // a and b used read in range; c only out of range
    assert.equal(read.delta, 1)      // 40 vs 20 → +100%
    const grep = rows[1]
    assert.equal(grep.share, 0.07)
    assert.equal(grep.reach, 1)
    assert.equal(grep.delta, undefined) // no previous data
  })
})
