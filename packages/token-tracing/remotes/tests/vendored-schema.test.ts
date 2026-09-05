/**
 * Contract tests for the hand-vendored remote-client (AGENTS.md: vendored
 * mirrors are "covered by tests"). Parses representative wire payloads through
 * the vendored zod codecs and pins the surface shape (method set, stream mode).
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import TYPERT_REMOTE from '../src/client/remote-client.js'
import type { TurnTrace, TokenTraceFrame, SessionRollupView } from '@qihongmu/dsh-plugins-token-tracing/types'

function resultSchema(method: string) {
  const descriptor = TYPERT_REMOTE.descriptors.find(entry => entry.method === method)
  assert.ok(descriptor !== undefined, `descriptor for ${method} missing`)
  return descriptor.result.schema
}

const turnTraceFixture = {
  sessionId: 'session-1',
  turn: 2,
  status: 'complete',
  startedAt: 1_700_000_000_000,
  endedAt: 1_700_000_100_000,
  attempts: [
    {
      seq: 10,
      turn: 2,
      step: 0,
      time: 1_700_000_050_000,
      kind: 'llm',
      retry: true,
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadTokens: 50 },
      promptTotal: 100,
      composition: [{ kind: 'system-prompt', tokens: 60, basis: 'estimated' }],
      additions: null,
      cache: { read: 50, write: 0, hitRatio: 0.5 },
      invalidated: true,
    },
    {
      seq: 12,
      turn: 2,
      step: 1,
      kind: 'compaction',
      usage: null,
      promptTotal: null,
      composition: null,
      additions: [{ kind: 'context-shrink', tokens: -500, basis: 'estimated' }],
      cache: null,
    },
  ],
  totals: { inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadTokens: 50 },
  cacheEvents: [{ atSeq: 12, kind: 'compacted' }],
}

const sessionRollupFixture = {
  sessionId: 'session-1',
  sessionCreatedAt: 1_700_000_000_000,
  engine: 4,
  lastSeq: 40,
  latestTurn: 2,
  turns: 2,
  incompleteTurns: 1,
  totals: { inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadTokens: 50 },
  byComponent: { 'system-prompt': 60 },
  byTool: { read: 20 },
  byDay: {
    '2026-09-01': {
      turns: 2,
      incompleteTurns: 1,
      totals: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      byComponent: {},
      byTool: {},
    },
  },
  firstAt: 1_700_000_000_000,
  lastAt: 1_700_000_100_000,
}

describe('vendored remote-client surface', () => {
  it('declares all seven methods with follow as the only stream', () => {
    assert.deepEqual(
      TYPERT_REMOTE.descriptors.map(entry => entry.method).sort(),
      ['backfillAll', 'days', 'follow', 'sessions', 'summary', 'trace', 'traceBatch'],
    )
    const streams = TYPERT_REMOTE.descriptors.filter(entry => entry.mode === 'stream')
    assert.deepEqual(streams.map(entry => entry.method), ['follow'])
    assert.deepEqual(streams[0].cancellation, { parameter: 'signal' })
  })

  it('parses a full TurnTrace through the trace result codec', () => {
    const parsed = resultSchema('trace').parse(turnTraceFixture)
    assert.equal(parsed.attempts[0].invalidated, true)
    assert.equal(parsed.attempts[1].additions[0].tokens, -500)
  })

  it('parses the follow frame union', () => {
    const schema = resultSchema('follow')
    const snapshot: TokenTraceFrame = { kind: 'snapshot', summary: SessionRollupViewFixture(), activeTurn: null }
    assert.equal(schema.parse(snapshot).kind, 'snapshot')
    const turn: TokenTraceFrame = { kind: 'turn', trace: turnTraceFixture as TurnTrace }
    assert.equal(schema.parse(turn).kind, 'turn')
    const attempt: TokenTraceFrame = {
      kind: 'attempt',
      sessionId: 'session-1',
      attempt: turnTraceFixture.attempts[0],
    }
    assert.equal(schema.parse(attempt).kind, 'attempt')
  })

  it('parses a session rollup with engine/latestTurn', () => {
    const parsed = resultSchema('summary').parse(sessionRollupFixture) as SessionRollupView
    assert.equal(parsed.engine, 4)
    assert.equal(parsed.latestTurn, 2)
  })

  it('rejects a trace with a negative token count', () => {
    const broken = structuredClone(turnTraceFixture)
    broken.attempts[0].usage.inputTokens = -1
    assert.throws(() => resultSchema('trace').parse(broken))
  })
})

function SessionRollupViewFixture(): SessionRollupView {
  return sessionRollupFixture as SessionRollupView
}
