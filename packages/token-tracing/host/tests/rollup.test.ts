/**
 * Unit tests for the rollup arithmetic: turn application (latestTurn, byTool,
 * incomplete counting), maintenance day bucketing from the attempt's own time,
 * and cross-session day merging.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  applyMaintenanceToRollup,
  applyTurnToRollup,
  emptySessionRollup,
  mergeDayRollups,
} from '../src/rollup.ts'
import type { AttemptTrace, TurnTrace } from '../src/types.ts'

const BASE = Date.parse('2026-09-01T08:00:00.000Z')

function attempt(overrides: Partial<AttemptTrace> = {}): AttemptTrace {
  return {
    seq: 1,
    turn: 1,
    step: 0,
    kind: 'llm',
    usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadTokens: 50 },
    promptTotal: 100,
    composition: [
      { kind: 'system-prompt', tokens: 40, basis: 'estimated' },
      { kind: 'tool-result', name: 'read', tokens: 40, basis: 'estimated' },
      { kind: 'user-input', tokens: 20, basis: 'estimated' },
    ],
    additions: null,
    cache: { read: 50, write: 0, hitRatio: 0.5 },
    ...overrides,
  }
}

function trace(overrides: Partial<TurnTrace> = {}): TurnTrace {
  return {
    sessionId: 's1',
    turn: 1,
    status: 'complete',
    startedAt: BASE,
    endedAt: BASE + 60_000,
    attempts: [attempt()],
    totals: { inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadTokens: 50 },
    cacheEvents: [],
    ...overrides,
  }
}

describe('applyTurnToRollup', () => {
  it('tracks latestTurn, byTool, and component totals', () => {
    const rollup = emptySessionRollup('s1', BASE)
    applyTurnToRollup(rollup, trace({ turn: 3, endedAt: BASE + 60_000 }))
    assert.equal(rollup.latestTurn, 3)
    assert.equal(rollup.turns, 1)
    assert.equal(rollup.byTool.read, 40)
    assert.equal(rollup.byComponent['system-prompt'], 40)
    assert.equal(rollup.byComponent['tool-result/read'], 40)
    assert.equal(rollup.totals.totalTokens, 120)
  })

  it('counts incomplete turns separately', () => {
    const rollup = emptySessionRollup('s1', BASE)
    applyTurnToRollup(rollup, trace({ status: 'incomplete' }))
    assert.equal(rollup.turns, 1)
    assert.equal(rollup.incompleteTurns, 1)
  })

  it('keeps the highest turn number across applications', () => {
    const rollup = emptySessionRollup('s1', BASE)
    applyTurnToRollup(rollup, trace({ turn: 5 }))
    applyTurnToRollup(rollup, trace({ turn: 2 }))
    assert.equal(rollup.latestTurn, 5)
    assert.equal(rollup.turns, 2)
  })
})

describe('applyMaintenanceToRollup', () => {
  it('buckets the compaction cost under the attempt OWN close time, not today', () => {
    const rollup = emptySessionRollup('s1', BASE)
    const stale = attempt({
      kind: 'compaction',
      time: Date.parse('2026-08-15T23:00:00.000Z'),
      usage: { inputTokens: 90, outputTokens: 40, totalTokens: 130 },
      composition: [{ kind: 'compaction', tokens: 90, basis: 'exact' }],
    })
    applyMaintenanceToRollup(rollup, stale)
    assert.deepEqual(Object.keys(rollup.byDay), ['2026-08-15'])
    assert.equal(rollup.byDay['2026-08-15'].totals.totalTokens, 130)
    assert.equal(rollup.byDay['2026-08-15'].byComponent.compaction, 90)
  })
})

describe('mergeDayRollups', () => {
  it('merges sessions per day and counts distinct contributors', () => {
    const day = (sessionId: string, turns: number): Parameters<typeof mergeDayRollups>[0][number] => {
      const rollup = emptySessionRollup(sessionId, BASE)
      rollup.byDay['2026-09-01'] = {
        turns,
        incompleteTurns: 0,
        totals: { inputTokens: turns * 10, outputTokens: 0, totalTokens: turns * 10 },
        byComponent: { 'system-prompt': turns },
        byTool: {},
      }
      return rollup
    }
    const rows = mergeDayRollups([day('a', 2), day('b', 3), day('a', 0)])
    assert.equal(rows.length, 1)
    assert.equal(rows[0].day, '2026-09-01')
    assert.equal(rows[0].sessions, 2)
    assert.equal(rows[0].turns, 5)
    assert.equal(rows[0].totals.totalTokens, 50)
  })
})
