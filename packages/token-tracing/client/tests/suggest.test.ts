/**
 * Unit tests for the M3 suggestion engine: per-rule trigger boundaries
 * (threshold ± the smallest meaningful step), severity ordering, evidence
 * payloads, the one-suggestion-per-rule cap, and the single-session variant.
 * Pure functions — no DOM, no Remote.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { DayRollupView, SessionRollupView } from '@qihongmu/dsh-plugins-token-tracing/types'
import { buckets, contribution, day, session } from './fixtures.ts'
import { deriveSessionSuggestions, deriveSuggestions } from '../src/client/dashboard/suggest.ts'

const D1 = '2026-08-14'
const D2 = '2026-08-15'

/** Low cache-hit day: prompt 60 (80 total − 20 output), `read` cached. */
function lowHitDay(dayKey: string, cacheRead: number): DayRollupView {
  return day(dayKey, {
    totals: buckets({ inputTokens: 60, outputTokens: 20, totalTokens: 80, cacheReadTokens: cacheRead }),
  })
}

function rulesOf(suggestions: ReturnType<typeof deriveSuggestions>): string[] {
  return suggestions.map(entry => entry.ruleId)
}

describe('R1 — tool result domination', () => {
  const base = { byComponent: { 'tool-result/read': 40, 'system-prompt': 60 }, byTool: { read: 40 } }

  it('fires at exactly 40% with the tool as evidence', () => {
    const out = deriveSuggestions({ days: [day(D1, base)], previousDays: [], sessions: [] })
    assert.deepEqual(rulesOf(out), ['r1'])
    assert.equal(out[0].severity, 'high')
    assert.deepEqual(out[0].params, { tool: 'read', pct: 40 })
    assert.deepEqual(out[0].evidence, { kind: 'tool', key: 'read' })
  })

  it('does not fire below the threshold', () => {
    const out = deriveSuggestions({ days: [day(D1, { ...base, byTool: { read: 39 } })], previousDays: [], sessions: [] })
    assert.deepEqual(rulesOf(out), [])
  })

  it('picks the single largest tool', () => {
    const tools = { read: 41, grep: 2 }
    const out = deriveSuggestions({ days: [day(D1, { ...base, byTool: tools })], previousDays: [], sessions: [] })
    assert.equal(out[0].params.tool, 'read')
  })
})

describe('R2a — low range cache hit', () => {
  it('fires below 50% and anchors the worst day', () => {
    const days = [lowHitDay(D1, 30), lowHitDay(D2, 15)] // per-day hits 0.5 / 0.25
    const out = deriveSuggestions({ days, previousDays: [], sessions: [] })
    const r2a = out.find(entry => entry.ruleId === 'r2a')
    assert.ok(r2a !== undefined)
    assert.equal(r2a.severity, 'medium')
    assert.equal(r2a.params.pct, 38) // (30 + 15) / 120
    assert.deepEqual(r2a.evidence, { kind: 'day', key: D2 })
  })

  it('does not fire at exactly 50%', () => {
    const out = deriveSuggestions({ days: [lowHitDay(D1, 30)], previousDays: [], sessions: [] })
    assert.equal(out.find(entry => entry.ruleId === 'r2a'), undefined)
  })

  it('does not fire without reported cacheRead buckets', () => {
    const out = deriveSuggestions({ days: [day(D1, { byComponent: { 'system-prompt': 100 }, byTool: {} })], previousDays: [], sessions: [] })
    assert.deepEqual(rulesOf(out), [])
  })
})

describe('R2b — consecutive-day cache drop', () => {
  const highHit = day(D1, { totals: buckets({ outputTokens: 0, totalTokens: 100, cacheReadTokens: 80 }), byComponent: { 'system-prompt': 100 }, byTool: {} })
  const midHit = day(D2, { totals: buckets({ outputTokens: 0, totalTokens: 100, cacheReadTokens: 50 }), byComponent: { 'system-prompt': 100 }, byTool: {} })

  it('fires above 20pp with the later day as evidence', () => {
    const out = deriveSuggestions({ days: [highHit, midHit], previousDays: [], sessions: [] })
    assert.deepEqual(rulesOf(out), ['r2b'])
    assert.equal(out[0].severity, 'high')
    assert.deepEqual(out[0].params, { day: D2, pp: 30 })
    assert.deepEqual(out[0].evidence, { kind: 'day', key: D2 })
  })

  it('does not fire just below the threshold (ratio comparisons carry FP drift, so the strict > is asserted away from the knife edge)', () => {
    const justBelow = day(D2, { totals: buckets({ outputTokens: 0, totalTokens: 100, cacheReadTokens: 61 }) })
    const out = deriveSuggestions({ days: [highHit, justBelow], previousDays: [], sessions: [] })
    assert.deepEqual(rulesOf(out), [])
  })
})

describe('R3 — system-prompt growth vs the previous period', () => {
  const sp = (tokens: number): DayRollupView => day(D1, { byComponent: { 'system-prompt': tokens }, byTool: {} })

  it('fires at 1.2× and above; params carry the growth percentage', () => {
    const out = deriveSuggestions({ days: [sp(130), sp(130)], previousDays: [sp(100), sp(100)], sessions: [] })
    assert.deepEqual(rulesOf(out), ['r3'])
    assert.equal(out[0].params.pct, 30)
    assert.deepEqual(out[0].evidence, { kind: 'component', key: 'system-prompt' })
  })

  it('does not fire below 1.2×, without a baseline, or on a zero baseline', () => {
    assert.deepEqual(rulesOf(deriveSuggestions({ days: [sp(119), sp(119)], previousDays: [sp(100), sp(100)], sessions: [] })), [])
    assert.deepEqual(rulesOf(deriveSuggestions({ days: [sp(130)], previousDays: [], sessions: [] })), [])
    assert.deepEqual(rulesOf(deriveSuggestions({ days: [sp(130)], previousDays: [day(D2, { byComponent: {}, byTool: {} })], sessions: [] })), [])
  })

  it('compares per-turn averages, not raw daily totals — volume growth is not inflation', () => {
    // Same raw totals as the firing case, but the current period ran twice
    // the turns: 130/2 = 65 per turn vs 100 → 0.65×, far below 1.2×.
    const diluted = day(D1, { turns: 2, byComponent: { 'system-prompt': 130 }, byTool: {} })
    const out = deriveSuggestions({ days: [diluted, { ...diluted, day: '2026-08-16' }], previousDays: [sp(100), sp(100)], sessions: [] })
    assert.deepEqual(rulesOf(out), [])
  })
})

describe('R4 / R5 — injected content and compaction shares', () => {
  it('R4 fires at exactly 15%', () => {
    const out = deriveSuggestions({
      days: [day(D1, { byComponent: { 'injected-context/compact': 10, 'runtime-context': 5, 'system-prompt': 85 }, byTool: {} })],
      previousDays: [],
      sessions: [],
    })
    assert.deepEqual(rulesOf(out), ['r4'])
    assert.equal(out[0].params.pct, 15)
  })

  it('R4 does not fire below 15%', () => {
    const out = deriveSuggestions({
      days: [day(D1, { byComponent: { 'injected-context/compact': 14, 'system-prompt': 86 }, byTool: {} })],
      previousDays: [],
      sessions: [],
    })
    assert.deepEqual(rulesOf(out), [])
  })

  it('R4 sums the bare kind and kind/name leaves into one family', () => {
    const out = deriveSuggestions({
      days: [day(D1, { byComponent: { 'injected-context': 6, 'injected-context/compact': 4, 'injected-context/files': 5, 'system-prompt': 85 }, byTool: {} })],
      previousDays: [],
      sessions: [],
    })
    assert.deepEqual(rulesOf(out), ['r4'])
    assert.equal(out[0].params.pct, 15)
  })

  it('R5 fires at exactly 10%', () => {
    const out = deriveSuggestions({
      days: [day(D1, { byComponent: { compaction: 10, 'system-prompt': 90 }, byTool: {} })],
      previousDays: [],
      sessions: [],
    })
    assert.deepEqual(rulesOf(out), ['r5'])
  })

  it('R5 does not fire below 10%', () => {
    const out = deriveSuggestions({
      days: [day(D1, { byComponent: { compaction: 9, 'system-prompt': 91 }, byTool: {} })],
      previousDays: [],
      sessions: [],
    })
    assert.deepEqual(rulesOf(out), [])
  })
})

describe('R7 — a heavy session, reported only with a concrete pathology', () => {
  const days = [day(D1, { byComponent: {}, byTool: {} }), day(D2, { byComponent: {}, byTool: {} })]
  const peers = (): SessionRollupView[] => [
    session('s1', { byDay: { [D1]: contribution({ totals: buckets({ totalTokens: 100 }) }) } }),
    session('s2', { byDay: { [D1]: contribution({ totals: buckets({ totalTokens: 100 }) }) } }),
  ]
  /** 9× the peers' median, active on `dayKey`; fixture components carry the
      tool-result pathology by default (the `tool-result/read` leaf, 40%). */
  const heavyOn = (dayKey: string, overrides: Partial<Parameters<typeof contribution>[0]> = {}): SessionRollupView =>
    session('s3-long-id-xxxx', { byDay: { [dayKey]: contribution({ totals: buckets({ totalTokens: 900 }), ...overrides }) } })

  it('classifies a low-cache outlier as r7cache', () => {
    const heavy = heavyOn(D1, {
      totals: buckets({ inputTokens: 880, outputTokens: 20, totalTokens: 900, cacheReadTokens: 100 }),
    })
    const out = deriveSuggestions({ days, previousDays: [], sessions: [...peers(), heavy] })
    assert.deepEqual(rulesOf(out), ['r7cache'])
    assert.equal(out[0].severity, 'high')
    assert.deepEqual(out[0].params, { id: 's3-long-…', tokens: '900', factor: 9, pct: 11 })
    assert.deepEqual(out[0].evidence, { kind: 'session', key: 's3-long-id-xxxx' })
  })

  it('classifies dominant fixable components: tool / compaction / injected', () => {
    const tool = heavyOn(D1) // fixture default: tool-result/read leaf, share 40%
    const compaction = heavyOn(D1, { byComponent: { compaction: 10, 'system-prompt': 90 } })
    const injected = heavyOn(D1, { byComponent: { 'injected-context/compact': 10, 'runtime-context': 5, 'system-prompt': 85 } })
    assert.deepEqual(rulesOf(deriveSuggestions({ days, previousDays: [], sessions: [...peers(), tool] })), ['r7tool'])
    assert.deepEqual(rulesOf(deriveSuggestions({ days, previousDays: [], sessions: [...peers(), compaction] })), ['r7compaction'])
    assert.deepEqual(rulesOf(deriveSuggestions({ days, previousDays: [], sessions: [...peers(), injected] })), ['r7injected'])
  })

  it('stays silent on a healthy heavy session — workload, not waste', () => {
    const heavy = heavyOn(D1, {
      totals: buckets({ inputTokens: 880, outputTokens: 20, totalTokens: 900, cacheReadTokens: 800 }),
      byComponent: { 'system-prompt': 30, 'assistant-output': 70 },
    })
    assert.deepEqual(rulesOf(deriveSuggestions({ days, previousDays: [], sessions: [...peers(), heavy] })), [])
  })

  it('does not fire below 3×, with one session, or with no active sessions', () => {
    const mild = heavyOn(D1, { totals: buckets({ totalTokens: 250 }) })
    assert.deepEqual(rulesOf(deriveSuggestions({ days, previousDays: [], sessions: [...peers(), mild] })), [])
    assert.deepEqual(rulesOf(deriveSuggestions({ days, previousDays: [], sessions: [heavyOn(D1)] })), [])
    assert.deepEqual(rulesOf(deriveSuggestions({ days, previousDays: [], sessions: [] })), [])
  })
})

describe('ordering and the one-per-rule cap', () => {
  // Two days: tool-result leaf share 120/300 = 40% (R1), injected leaf 45/300 = 15% (R4).
  const composition = { 'tool-result/read': 40, 'injected-context/compact': 15, 'system-prompt': 45 }
  const days = [
    day('2026-08-13', { turns: 1, totals: buckets({ totalTokens: 100 }), byComponent: composition, byTool: { read: 40 } }),
    day(D1, { turns: 1, totals: buckets({ totalTokens: 100 }), byComponent: composition, byTool: { read: 40 } }),
    day(D2, { turns: 1, totals: buckets({ totalTokens: 400 }), byComponent: composition, byTool: { read: 40 } }),
  ]

  it('orders high → medium → info', () => {
    const out = deriveSuggestions({ days, previousDays: [], sessions: [] })
    assert.deepEqual(rulesOf(out), ['r1', 'r4'])
  })

  it('emits at most one suggestion per rule', () => {
    const counts = new Map<string, number>()
    for (const entry of deriveSuggestions({ days, previousDays: [], sessions: [] })) {
      counts.set(entry.ruleId, (counts.get(entry.ruleId) ?? 0) + 1)
    }
    for (const count of counts.values()) assert.equal(count, 1)
  })
})

describe('deriveSessionSuggestions', () => {
  it('reuses the shared rules over the session byDay; never fires cross-session rules', () => {
    const rollup = session('s1', {
      byDay: {
        [D1]: contribution({ totals: buckets({ inputTokens: 60, outputTokens: 20, totalTokens: 80, cacheReadTokens: 20 }) }),
        [D2]: contribution({ totals: buckets({ inputTokens: 60, outputTokens: 20, totalTokens: 80, cacheReadTokens: 20 }) }),
      },
    })
    const out = deriveSessionSuggestions(rollup)
    assert.ok(out.some(entry => entry.ruleId === 'r2a'))
    assert.equal(out.find(entry => entry.ruleId.startsWith('r7')), undefined)
    assert.equal(out.find(entry => entry.ruleId === 'r3'), undefined)
  })

  it('returns [] for a session without byDay data', () => {
    assert.deepEqual(deriveSessionSuggestions(session('s1', { byDay: {} })), [])
  })
})
