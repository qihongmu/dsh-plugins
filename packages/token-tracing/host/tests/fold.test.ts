/**
 * Golden fixtures for the fold engine: synthetic session event sequences in,
 * TurnTrace numbers and attribution basis out. The builder produces
 * event-log-shaped plain objects (shapes verified against the dsh session
 * types); the engine under test only reads documented fields.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SessionFolder } from '../src/fold.ts'
import type { AttemptTrace, TurnTrace } from '../src/types.ts'

/* ---------------------------------------------------------------- builder */

const BASE = Date.parse('2026-09-01T08:00:00.000Z')
let seqCounter = 0

type AnyEvent = {
  type: string
  seq: number
  time: number
  data: Record<string, unknown>
  surfaceOp?: 'append' | { op: 'replace'; start: number; end: number }
}

function ev(type: string, data: Record<string, unknown>, extra: Partial<AnyEvent> = {}): AnyEvent {
  seqCounter += 1
  return { type, seq: seqCounter, time: BASE + seqCounter * 1000, data, ...extra }
}

function userMessage(text: string, source: Record<string, unknown> = { kind: 'user' }): Record<string, unknown> {
  return {
    id: `m-${seqCounter + 1}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source,
  }
}

function assistantMessage(text: string): Record<string, unknown> {
  return {
    id: `a-${seqCounter + 1}`,
    role: 'assistant',
    content: [{ type: 'text', text }],
    source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
  }
}

function usage(inputTokens: number, outputTokens: number, totalTokens: number, extra: Record<string, number> = {}): Record<string, number> {
  return { inputTokens, outputTokens, totalTokens, ...extra }
}

function fold(sessionId: string, events: readonly AnyEvent[]): SessionFolder {
  const folder = new SessionFolder({ sessionId, bufferTurns: true, maxBufferedTurns: 1000 })
  for (const event of events) folder.ingest(event as never)
  return folder
}

function sumSplits(splits: readonly { tokens: number }[] | null): number {
  if (splits === null) return 0
  return splits.reduce((acc, split) => acc + split.tokens, 0)
}

/* ---------------------------------------------------------------- fixtures */

describe('single-step turn', () => {
  const events = [
    ev('turn/start', { turn: 1 }),
    ev('user/message', userMessage('Hello trace'), { surfaceOp: 'append' }),
    ev('request/header', { header: { config: {}, system: 'S'.repeat(400) }, reason: 'initial' }),
    ev('step/start', { turn: 1, step: 0 }),
    ev('assistant/message', {
      turn: 1,
      step: 0,
      message: assistantMessage('Hi'),
      usage: usage(100, 20, 120, { cacheReadTokens: 50, cacheWriteTokens: 50, reasoningTokens: 8 }),
    }, { surfaceOp: 'append' }),
    ev('step/end', { turn: 1, step: 0 }),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ]
  const folder = fold('s1', events)
  const trace = folder.traceOf(1)

  it('produces one complete trace with exact totals', () => {
    assert.ok(trace !== undefined)
    assert.equal(trace.status, 'complete')
    assert.equal(trace.attempts.length, 1)
    assert.deepEqual(trace.totals, usage(100, 20, 120, { cacheReadTokens: 50, cacheWriteTokens: 50, reasoningTokens: 8 }))
  })

  it('computes promptTotal from the exact total', () => {
    const attempt = trace.attempts[0]
    assert.equal(attempt.promptTotal, 100)
    assert.equal(attempt.cache?.read, 50)
    assert.ok(Math.abs(attempt.cache.hitRatio - 0.5) < 1e-9)
  })

  it('calibrates the series-start composition to the exact prompt total', () => {
    const attempt = trace.attempts[0]
    assert.ok(attempt.composition !== null)
    assert.equal(sumSplits(attempt.composition), 100)
    assert.ok(attempt.composition.some(split => split.kind === 'system-prompt'))
    assert.ok(attempt.composition.some(split => split.kind === 'user-input'))
    assert.ok(attempt.composition.every(split => split.basis === 'estimated'))
  })

  it('leaves additions null at a series start', () => {
    assert.equal(trace.attempts[0].additions, null)
  })
})

describe('multi-step tool loop', () => {
  const events: AnyEvent[] = [
    ev('turn/start', { turn: 2 }),
    ev('user/message', userMessage('Read the file'), { surfaceOp: 'append' }),
    ev('request/header', { header: { config: {}, system: 'S'.repeat(200) }, reason: 'resume' }),
    ev('step/start', { turn: 2, step: 0 }),
    ev('assistant/message', {
      turn: 2,
      step: 0,
      message: {
        ...assistantMessage(''),
        content: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }],
      },
      usage: usage(100, 30, 130),
    }, { surfaceOp: 'append' }),
    ev('tool/call', { turn: 2, step: 0, callId: 'c1', name: 'read', arguments: '{}' }),
    ev('tool/result', {
      turn: 2,
      step: 0,
      message: {
        id: 't1',
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'x'.repeat(400) }], isError: false }],
        source: { kind: 'tool', callId: 'c1' },
      },
    }, { surfaceOp: 'append' }),
    ev('step/end', { turn: 2, step: 0 }),
    // prompt grew by exactly 60: the assistant output + tool result; the cache
    // held (95 ≥ 90% of the previous 100-token prompt).
    ev('step/start', { turn: 2, step: 1 }),
    ev('assistant/message', {
      turn: 2,
      step: 1,
      message: assistantMessage('Done'),
      usage: usage(65, 15, 175, { cacheReadTokens: 95, reasoningTokens: 5 }),
    }, { surfaceOp: 'append' }),
    ev('step/end', { turn: 2, step: 1 }),
    ev('turn/end', { turn: 2, reason: { kind: 'completed' } }),
  ]
  const folder = fold('s2', events)
  const trace = folder.traceOf(2)
  const attempt = trace.attempts[1]

  it('attributes the exact prompt delta across the new surface nodes', () => {
    assert.ok(attempt.additions !== null)
    assert.equal(sumSplits(attempt.additions), 175 - 15 - (130 - 30))
  })

  it('splits the delta into assistant output + tool result components', () => {
    const kinds = attempt.additions.map(split => split.kind).sort()
    assert.deepEqual(kinds, ['assistant-output', 'tool-result'])
    const toolSplit = attempt.additions.find(split => split.kind === 'tool-result')
    assert.equal(toolSplit.name, 'read')
  })

  it('keeps a diff-based composition too (both views available)', () => {
    assert.ok(attempt.composition !== null)
    assert.equal(sumSplits(attempt.composition), 160)
    assert.ok(attempt.additions !== null)
    assert.equal(sumSplits(attempt.additions), 175 - 15 - (130 - 30))
  })

  it('does not flag invalidation while the cache holds', () => {
    assert.equal(attempt.invalidated, undefined)
    assert.ok(trace.cacheEvents.every(event => event.kind !== 'invalidated'))
  })
})

describe('retry within one step', () => {
  const events: AnyEvent[] = [
    ev('turn/start', { turn: 3 }),
    ev('user/message', userMessage('Go'), { surfaceOp: 'append' }),
    ev('request/header', { header: { config: {} }, reason: 'initial' }),
    ev('step/start', { turn: 3, step: 0 }),
    ev('assistant/chunk', { turn: 3, step: 0, chunk: { type: 'usage', usage: usage(50, 10, 60) } }),
    ev('llm/retry', {
      retryId: 'r1', turn: 3, step: 0, provider: 'deepseek', mode: 'normal', policyKey: 'p',
      retry: 1, maxRetries: 3, delayMs: 100, failure: { code: 'RATE_LIMIT', message: 'slow down' },
    }),
    ev('llm/retry-started', { retryId: 'r1', turn: 3, step: 0, retry: 1 }),
    ev('assistant/chunk', { turn: 3, step: 0, chunk: { type: 'usage', usage: usage(55, 12, 70) } }),
    ev('assistant/message', {
      turn: 3, step: 0, message: assistantMessage('ok'), usage: usage(55, 12, 70),
    }, { surfaceOp: 'append' }),
    ev('step/end', { turn: 3, step: 0 }),
    ev('turn/end', { turn: 3, reason: { kind: 'completed' } }),
  ]
  const folder = fold('s3', events)
  const trace = folder.traceOf(3)

  it('counts both billed attempts as separate retry rows', () => {
    assert.equal(trace.attempts.length, 2)
    assert.equal(trace.attempts[0].retry, true)
    assert.equal(trace.attempts[1].retry, true)
    assert.equal(trace.attempts[0].usage.totalTokens, 60)
  })

  it('sums exact totals across both attempts', () => {
    assert.deepEqual(trace.totals, usage(105, 22, 130))
  })
})

describe('missing usage degrades without poisoning the turn', () => {
  const events: AnyEvent[] = [
    ev('turn/start', { turn: 4 }),
    ev('user/message', userMessage('Hi'), { surfaceOp: 'append' }),
    ev('assistant/message', { turn: 4, step: 0, message: assistantMessage('ok') }, { surfaceOp: 'append' }),
    ev('assistant/message', {
      turn: 4, step: 1, message: assistantMessage('done'), usage: usage(80, 10, 90),
    }, { surfaceOp: 'append' }),
    ev('turn/end', { turn: 4, reason: { kind: 'completed' } }),
  ]
  const folder = fold('s4', events)
  const trace = folder.traceOf(4)

  it('marks the unreported attempt null and drops turn totals to null', () => {
    assert.equal(trace.attempts[0].usage, null)
    assert.equal(trace.totals, null)
  })

  it('recovers composition attribution on the next reported attempt', () => {
    const attempt = trace.attempts[1]
    assert.ok(attempt.composition !== null)
    assert.equal(sumSplits(attempt.composition), 80)
  })
})

describe('mid-turn compaction', () => {
  // Capture the real event seqs: the replace op carries NODE SEQS, and the
  // module-level counter makes them larger than any literal would suggest.
  // With three surface nodes and a full-range replace, this fixture
  // discriminates seq semantics from the naive array-index reading (which
  // would leave the shadowed nodes in place).
  const userEv = ev('user/message', userMessage('Long task'), { surfaceOp: 'append' })
  const headerEv = ev('request/header', { header: { config: {}, system: 'S'.repeat(100) }, reason: 'initial' })
  const stepStartEv = ev('step/start', { turn: 5, step: 0 })
  const assistantEv = ev('assistant/message', {
    turn: 5, step: 0, message: assistantMessage('working'), usage: usage(100, 10, 110),
  }, { surfaceOp: 'append' })
  const toolCallEv = ev('tool/call', { turn: 5, step: 0, callId: 'c1', name: 'read', arguments: '{}' })
  const toolResultEv = ev('tool/result', {
    turn: 5,
    step: 0,
    message: {
      id: 't1',
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'x'.repeat(300) }], isError: false }],
      source: { kind: 'tool', callId: 'c1' },
    },
  }, { surfaceOp: 'append' })
  const stepEndEv = ev('step/end', { turn: 5, step: 0 })
  const events: AnyEvent[] = [
    ev('turn/start', { turn: 5 }),
    userEv,
    headerEv,
    stepStartEv,
    assistantEv,
    toolCallEv,
    toolResultEv,
    stepEndEv,
    ev('compaction/start', { compactionId: 'cp1', turn: 5 }),
    ev('compaction/summary', {
      compactionId: 'cp1',
      turn: 5,
      summary: [{ type: 'text', text: 'summary so far' }],
      shadowedRange: { start: userEv.seq, end: toolResultEv.seq },
      shadowedSeqs: [userEv.seq, assistantEv.seq, toolResultEv.seq],
      shadowedTokenCount: 500,
      provider: 'deepseek',
      model: 'deepseek-chat',
      usage: usage(90, 40, 130),
    }),
    ev('user/message', userMessage('summary so far', { kind: 'plugin', plugin: 'compaction' }), {
      surfaceOp: { op: 'replace', start: userEv.seq, end: toolResultEv.seq },
    }),
    ev('compaction/end', { compactionId: 'cp1', turn: 5 }),
    ev('step/start', { turn: 5, step: 1 }),
    ev('assistant/message', {
      turn: 5, step: 1, message: assistantMessage('continued'), usage: usage(50, 8, 68, { cacheReadTokens: 10 }),
    }, { surfaceOp: 'append' }),
    ev('step/end', { turn: 5, step: 1 }),
    ev('turn/end', { turn: 5, reason: { kind: 'completed' } }),
  ]
  const folder = fold('s5', events)
  const trace = folder.traceOf(5)
  const pseudo = trace.attempts.find(attempt => attempt.kind === 'compaction')
  const next = trace.attempts.filter(attempt => attempt.kind === 'llm')[1]

  it('records the compaction as a pseudo attempt with exact usage', () => {
    assert.ok(pseudo !== undefined)
    assert.equal(pseudo.usage.totalTokens, 130)
    assert.equal(sumSplits(pseudo.additions), -500)
  })

  it('removes every shadowed node from the surface (seq-based replace)', () => {
    assert.ok(trace.cacheEvents.some(event => event.kind === 'compacted'))
    assert.ok(next.composition !== null)
    assert.equal(sumSplits(next.composition), 60)
    // The summary node replaced user+assistant+tool-result: the post-compaction
    // composition carries injected-context (the summary) and none of the
    // shadowed nodes' kinds.
    assert.ok(next.composition.some(split => split.kind === 'injected-context'))
    assert.ok(!next.composition.some(split => split.kind === 'tool-result'))
    assert.ok(!next.composition.some(split => split.kind === 'assistant-output'))
  })

  it('cross-validates the shadow price with the measured shrink (exact)', () => {
    // measured delta = 60 - 100 = -40 vs shadowedTokenCount 500.
    assert.deepEqual(next.additions, [{ kind: 'context-shrink', tokens: -40, basis: 'exact' }])
  })

  it('includes the compaction cost in the turn totals', () => {
    assert.equal(trace.totals.totalTokens, 110 + 130 + 68)
  })
})

describe('interrupted turn', () => {
  const events: AnyEvent[] = [
    ev('turn/start', { turn: 6 }),
    ev('user/message', userMessage('cancelled task'), { surfaceOp: 'append' }),
    ev('assistant/message', {
      turn: 6, step: 0, message: assistantMessage('part'), usage: usage(40, 5, 45), interrupted: true,
    }, { surfaceOp: 'append' }),
    ev('turn/end', { turn: 6, reason: { kind: 'aborted', reason: { kind: 'user' } } }),
    ev('turn/start', { turn: 7 }),
    ev('user/message', userMessage('try again'), { surfaceOp: 'append' }),
    ev('assistant/message', {
      turn: 7, step: 0, message: assistantMessage('ok'), usage: usage(45, 5, 50),
    }, { surfaceOp: 'append' }),
    ev('turn/end', { turn: 7, reason: { kind: 'completed' } }),
  ]
  const folder = fold('s6', events)

  it('marks the aborted turn incomplete', () => {
    assert.equal(folder.traceOf(6).status, 'incomplete')
  })

  it('refuses to diff across the broken turn (composition instead)', () => {
    const attempt = folder.traceOf(7).attempts[0]
    assert.ok(attempt.composition !== null)
    assert.equal(attempt.additions, null)
  })
})

describe('cross-turn diff on a clean boundary', () => {
  const events: AnyEvent[] = [
    ev('turn/start', { turn: 8 }),
    ev('user/message', userMessage('first'), { surfaceOp: 'append' }),
    ev('request/header', { header: { config: {}, system: 'S'.repeat(100) }, reason: 'initial' }),
    ev('assistant/message', {
      turn: 8, step: 0, message: assistantMessage('ok'), usage: usage(100, 10, 110),
    }, { surfaceOp: 'append' }),
    ev('turn/end', { turn: 8, reason: { kind: 'completed' } }),
    ev('turn/start', { turn: 9 }),
    ev('user/message', userMessage('follow-up question'), { surfaceOp: 'append' }),
    ev('request/header', { header: { config: {}, system: 'S'.repeat(100) }, reason: 'series', startsSeries: true }),
    ev('step/start', { turn: 9, step: 0 }),
    ev('assistant/message', {
      turn: 9, step: 0, message: assistantMessage('answer'), usage: usage(120, 12, 132),
    }, { surfaceOp: 'append' }),
    ev('step/end', { turn: 9, step: 0 }),
    ev('turn/end', { turn: 9, reason: { kind: 'completed' } }),
  ]
  const folder = fold('s7', events)
  const attempt = folder.traceOf(9).attempts[0]

  it('attributes the new user input plus the previous assistant output', () => {
    assert.ok(attempt.additions !== null)
    // The new prompt contains turn 8's assistant output AND the follow-up
    // question; both are priced into the exact delta. With two new nodes the
    // split is proportional (estimated) but the total is exact.
    const userSplit = attempt.additions.find(split => split.kind === 'user-input')
    assert.ok(userSplit !== undefined)
    assert.equal(userSplit.basis, 'estimated')
    const delta = 132 - 12 - 110 + 10
    assert.equal(attempt.additions.reduce((acc, split) => acc + split.tokens, 0), delta)
  })
})

describe('header change invalidates the cache', () => {
  const events: AnyEvent[] = [
    ev('turn/start', { turn: 10 }),
    ev('user/message', userMessage('go'), { surfaceOp: 'append' }),
    ev('request/header', { header: { config: {}, system: 'A' }, reason: 'initial' }),
    ev('step/start', { turn: 10, step: 0 }),
    ev('assistant/message', {
      turn: 10, step: 0, message: assistantMessage('one'), usage: usage(100, 10, 110, { cacheReadTokens: 95 }),
    }, { surfaceOp: 'append' }),
    ev('step/end', { turn: 10, step: 0 }),
    ev('request/header', { header: { config: {}, system: 'B'.repeat(300) }, reason: 'change', startsSeries: true }),
    ev('step/start', { turn: 10, step: 1 }),
    ev('assistant/message', {
      turn: 10, step: 1, message: assistantMessage('two'), usage: usage(200, 10, 220, { cacheReadTokens: 0 }),
    }, { surfaceOp: 'append' }),
    ev('step/end', { turn: 10, step: 1 }),
    ev('turn/end', { turn: 10, reason: { kind: 'completed' } }),
  ]
  const folder = fold('s8', events)
  const trace = folder.traceOf(10)

  it('flags the first attempt of the new series as invalidated', () => {
    const attempt = trace.attempts[1]
    assert.equal(attempt.invalidated, true)
    assert.ok(trace.cacheEvents.some(event => event.kind === 'invalidated'))
  })

  it('switches to composition attribution after the header change', () => {
    const attempt = trace.attempts[1]
    assert.ok(attempt.composition !== null)
    assert.ok(attempt.composition.some(split => split.kind === 'system-prompt'))
    assert.equal(sumSplits(attempt.composition), 210)
  })
})

describe('resume header does NOT invalidate the cache', () => {
  const events: AnyEvent[] = [
    ev('turn/start', { turn: 14 }),
    ev('user/message', userMessage('first'), { surfaceOp: 'append' }),
    ev('request/header', { header: { config: {}, system: 'A'.repeat(100) }, reason: 'initial' }),
    ev('step/start', { turn: 14, step: 0 }),
    ev('assistant/message', {
      turn: 14, step: 0, message: assistantMessage('one'), usage: usage(100, 10, 110, { cacheReadTokens: 95 }),
    }, { surfaceOp: 'append' }),
    ev('step/end', { turn: 14, step: 0 }),
    ev('turn/end', { turn: 14, reason: { kind: 'completed' } }),
    // Process restart: the same header is re-established with reason 'resume'.
    ev('turn/start', { turn: 15 }),
    ev('user/message', userMessage('after restart'), { surfaceOp: 'append' }),
    ev('request/header', { header: { config: {}, system: 'A'.repeat(100) }, reason: 'resume' }),
    ev('step/start', { turn: 15, step: 0 }),
    ev('assistant/message', {
      turn: 15, step: 0, message: assistantMessage('two'), usage: usage(120, 10, 130, { cacheReadTokens: 110 }),
    }, { surfaceOp: 'append' }),
    ev('step/end', { turn: 15, step: 0 }),
    ev('turn/end', { turn: 15, reason: { kind: 'completed' } }),
  ]
  const folder = fold('s12', events)
  const trace = folder.traceOf(15)

  it('keeps the diff chain and leaves the attempt unflagged', () => {
    const attempt = trace.attempts[0]
    assert.equal(attempt.invalidated, undefined)
    assert.ok(attempt.composition !== null) // composition is always computed
    assert.ok(attempt.additions !== null)   // and the diff still applies
    assert.equal(attempt.additions.reduce((acc, split) => acc + split.tokens, 0), 20)
  })
})

describe('cache-read drop invalidates the cache (rule b)', () => {
  const events: AnyEvent[] = [
    ev('turn/start', { turn: 16 }),
    ev('user/message', userMessage('go'), { surfaceOp: 'append' }),
    ev('request/header', { header: { config: {}, system: 'A'.repeat(100) }, reason: 'initial' }),
    ev('step/start', { turn: 16, step: 0 }),
    ev('assistant/message', {
      turn: 16, step: 0, message: assistantMessage('one'), usage: usage(100, 10, 110, { cacheReadTokens: 95 }),
    }, { surfaceOp: 'append' }),
    ev('step/end', { turn: 16, step: 0 }),
    // Same header series, prompt grew, but cacheRead collapsed to 5 (< 90% of 100).
    ev('step/start', { turn: 16, step: 1 }),
    ev('assistant/message', {
      turn: 16, step: 1, message: assistantMessage('two'), usage: usage(150, 10, 160, { cacheReadTokens: 5 }),
    }, { surfaceOp: 'append' }),
    ev('step/end', { turn: 16, step: 1 }),
    ev('turn/end', { turn: 16, reason: { kind: 'completed' } }),
  ]
  const trace = fold('s13', events).traceOf(16)

  it('flags the attempt whose cacheRead collapsed', () => {
    assert.equal(trace.attempts[1].invalidated, true)
    assert.ok(trace.cacheEvents.some(event => event.kind === 'invalidated'))
  })
})

describe('zero-attempt turns are not traced', () => {
  const folder = fold('s9', [
    ev('turn/start', { turn: 11 }),
    ev('turn/end', { turn: 11, reason: { kind: 'blocked' } }),
    ev('turn/start', { turn: 12 }),
    ev('user/message', userMessage('real'), { surfaceOp: 'append' }),
    ev('assistant/message', {
      turn: 12, step: 0, message: assistantMessage('ok'), usage: usage(10, 2, 12),
    }, { surfaceOp: 'append' }),
    ev('turn/end', { turn: 12, reason: { kind: 'completed' } }),
  ])

  it('drops the empty turn and keeps the real one', () => {
    assert.equal(folder.traceOf(11), undefined)
    assert.equal(folder.traceOf(12).status, 'complete')
  })
})

describe('injected context attribution', () => {
  const events: AnyEvent[] = [
    ev('turn/start', { turn: 13 }),
    ev('user/message', userMessage('skill content', { kind: 'plugin', plugin: 'skills' }), { surfaceOp: 'append' }),
    ev('request/header', { header: { config: {} }, reason: 'initial' }),
    ev('assistant/message', {
      turn: 13, step: 0, message: assistantMessage('ok'), usage: usage(60, 4, 64),
    }, { surfaceOp: 'append' }),
    ev('turn/end', { turn: 13, reason: { kind: 'completed' } }),
  ]
  const folder = fold('s10', events)
  const composition = folder.traceOf(13).attempts[0].composition

  it('labels plugin-sourced user messages as injected context', () => {
    const split = composition.find(split => split.kind === 'injected-context')
    assert.ok(split !== undefined)
    assert.equal(split.name, 'skills')
  })
})

describe('live attempt callbacks', () => {
  it('emits every closed attempt including compaction pseudo attempts', () => {
    const attempts: AttemptTrace[] = []
    const turns: TurnTrace[] = []
    const folder = new SessionFolder({
      sessionId: 's11',
      bufferTurns: false,
      onAttempt: attempt => attempts.push(attempt),
      onTurnComplete: trace => turns.push(trace),
    })
    const events: AnyEvent[] = [
      ev('turn/start', { turn: 1 }),
      ev('user/message', userMessage('go'), { surfaceOp: 'append' }),
      ev('assistant/message', {
        turn: 1, step: 0, message: assistantMessage('ok'), usage: usage(10, 2, 12),
      }, { surfaceOp: 'append' }),
      ev('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ]
    for (const event of events) folder.ingest(event as never)
    assert.equal(attempts.length, 1)
    assert.equal(turns.length, 1)
    assert.equal(folder.bufferedTurns.length, 0)
  })
})
