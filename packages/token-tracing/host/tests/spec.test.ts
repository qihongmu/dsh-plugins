/**
 * Unit tests for the durable rollup schema and the domain spec shape.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { sessionRollupRecord, tokenTracingDomainSpec } from '../src/spec.ts'

const valid = {
  sessionId: 'session-1',
  sessionCreatedAt: 1_700_000_000_000,
  lastSeq: 42,
  turns: 3,
  incompleteTurns: 1,
  totals: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheReadTokens: 3, reasoningTokens: 1 },
  byComponent: { 'system-prompt': 100, 'tool-result/read': 250 },
  byTool: { read: 250 },
  byDay: {
    '2026-09-01': {
      turns: 3,
      incompleteTurns: 1,
      totals: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      byComponent: { 'system-prompt': 100 },
      byTool: {},
    },
  },
  firstAt: 1_700_000_000_000,
  lastAt: 1_700_000_100_000,
}

describe('sessionRollupRecord', () => {
  it('accepts a fully populated rollup', () => {
    const parsed = sessionRollupRecord.parse(valid)
    assert.equal(parsed.sessionId, 'session-1')
    assert.equal(parsed.byDay['2026-09-01'].turns, 3)
  })

  it('rejects a malformed day key', () => {
    assert.throws(() => sessionRollupRecord.parse({
      ...valid,
      byDay: { '20260901': valid.byDay['2026-09-01'] },
    }))
  })

  it('rejects negative counters', () => {
    assert.throws(() => sessionRollupRecord.parse({ ...valid, turns: -1 }))
  })

  it('rejects negative usage buckets', () => {
    assert.throws(() => sessionRollupRecord.parse({
      ...valid,
      totals: { inputTokens: -1, outputTokens: 5, totalTokens: 15 },
    }))
  })
})

describe('tokenTracingDomainSpec', () => {
  it('declares the sessions table under the token_tracing domain', () => {
    assert.equal(tokenTracingDomainSpec.name, 'token_tracing')
    assert.equal(tokenTracingDomainSpec.version, 1)
    assert.deepEqual(Object.keys(tokenTracingDomainSpec.tables), ['sessions'])
  })

  it('runs per-record layout with the backup-and-skip salvage policy', () => {
    assert.equal(tokenTracingDomainSpec.layout, 'per-record')
    assert.equal(tokenTracingDomainSpec.invalidRecords, 'backup-and-skip')
  })
})
