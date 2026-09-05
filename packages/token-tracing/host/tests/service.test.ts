/**
 * Unit tests for TokenTracingService behavior that does not need a live
 * cordis Context: rollup read-modify-write on completed turns, live fold
 * ingestion, and lag-detecting backfill. The service instance is assembled
 * with Object.create so no plugin runtime is required; every injected
 * dependency is a hand-rolled fake.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { TokenTracingService } from '../src/index.ts'
import type { SessionRollupRecord } from '../src/spec.ts'
import type { SessionRollupView } from '../src/types.ts'

/* ---------------------------------------------------------------- builder */

const BASE = Date.parse('2026-09-01T08:00:00.000Z')

type AnyEvent = {
  type: string
  seq: number
  time: number
  data: Record<string, unknown>
  surfaceOp?: 'append'
}

let seqCounter = 0
function ev(type: string, data: Record<string, unknown>): AnyEvent {
  seqCounter += 1
  return { type, seq: seqCounter, time: BASE + seqCounter * 1000, data, surfaceOp: undefined }
}

interface FakeTable {
  rows: Map<string, SessionRollupRecord>
  puts: string[]
  get(key: string): SessionRollupRecord | undefined
  entries(): Array<[string, SessionRollupRecord]>
  put(key: string, value: SessionRollupRecord): Promise<void>
}

function makeTable(rows: Array<[string, SessionRollupRecord]> = []): FakeTable {
  const map = new Map(rows)
  const puts: string[] = []
  const tableInstance: FakeTable = {
    rows: map,
    puts,
    get: key => map.get(key),
    entries: () => [...map.entries()],
    put: async (key, value) => {
      map.set(key, value)
      puts.push(key)
    },
  }
  return tableInstance
}

function turnEvents(turn: number, promptTotal: number, outputTokens: number): AnyEvent[] {
  return [
    ev('turn/start', { turn }),
    ev('user/message', { id: `m${turn}`, role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }),
    ev('assistant/message', {
      turn,
      step: 0,
      message: { id: `a${turn}`, role: 'assistant', content: [{ type: 'text', text: 'ok' }], source: { kind: 'model', provider: 'p', model: 'm' } },
      usage: { inputTokens: promptTotal, outputTokens, totalTokens: promptTotal + outputTokens },
    }),
    ev('turn/end', { turn, reason: { kind: 'completed' } }),
  ]
}

function makeService(tableInstance: FakeTable, query: {
  listSessions?: () => Promise<Array<{ header: { id: string; createdAt: number } }>>
  readSession?: (id: string) => Promise<{ session: { id: string; createdAt: number }; events: AnyEvent[] }>
} = {}) {
  const svc = Object.create(TokenTracingService.prototype) as Record<string, unknown> & TokenTracingService
  svc['table'] = tableInstance
  svc['folders'] = new Map()
  svc['followers'] = new Map()
  svc['traceCache'] = new Map()
  svc['lastAttemptFrameAt'] = new Map()
  svc['backfillPromise'] = undefined
  svc.ctx = {
    logger: { warn: (message: string) => warnings.push(message) },
    sessionQuery: {
      listSessions: query.listSessions ?? (async () => []),
      readSession: query.readSession ?? (async (id: string) => ({ session: { id, createdAt: BASE }, events: [] })),
    },
  }
  return { svc: svc as unknown as TokenTracingService, raw: svc }
}
const warnings: string[] = []

function asSession(id: string): { id: string } {
  return { id } as { id: string }
}

/* ------------------------------------------------------------------ tests */

describe('applyTurn', () => {
  it('merges one completed turn into the durable rollup', async () => {
    const local = makeTable()
    const { raw } = makeService(local)
    const folder = (raw['makeFolder'] as (sessionId: string) => { ingest: (event: unknown) => void })('session-a')
    for (const event of turnEvents(1, 100, 10)) folder.ingest(event)
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(local.puts.length, 1)
    const stored = local.get('session-a')
    assert.ok(stored !== undefined)
    assert.equal(stored.turns, 1)
    assert.equal(stored.totals.totalTokens, 110)
  })

  it('assigns the turn to its UTC day bucket', async () => {
    const local = makeTable()
    const { raw } = makeService(local)
    const folder = (raw['makeFolder'] as (sessionId: string) => { ingest: (event: unknown) => void })('session-day')
    for (const event of turnEvents(1, 50, 5)) folder.ingest(event)
    await new Promise(resolve => setTimeout(resolve, 0))
    const stored = local.get('session-day')
    assert.ok(stored !== undefined)
    const days = Object.keys(stored.byDay)
    assert.equal(days.length, 1)
    assert.match(days[0], /^\d{4}-\d{2}-\d{2}$/)
    assert.equal(stored.byDay[days[0]].turns, 1)
  })
})

describe('live fold degradation', () => {
  it('keeps exact totals for a session whose folder starts cold', async () => {
    const local = makeTable()
    const { svc, raw } = makeService(local)
    const ingest = (raw['ingest'] as (session: { id: string }, event: unknown) => void).bind(svc)
    for (const event of turnEvents(1, 70, 7)) ingest(asSession('session-live'), event)
    await new Promise(resolve => setTimeout(resolve, 0))
    const stored = local.get('session-live')
    assert.ok(stored !== undefined)
    assert.equal(stored.turns, 1)
    assert.equal(stored.totals.totalTokens, 77)
  })
})

describe('runBackfill', () => {
  it('recomputes only lagging sessions and installs their folders', async () => {
    const local = makeTable([
      ['session-fresh', {
        sessionId: 'session-fresh',
        sessionCreatedAt: BASE,
        engine: 4,
        lastSeq: 4,
        turns: 1,
        incompleteTurns: 0,
        totals: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        byComponent: {},
        byTool: {},
        byDay: {},
        firstAt: BASE,
        lastAt: BASE,
      } satisfies SessionRollupRecord],
    ])
    const laggingEvents = turnEvents(1, 200, 20)
    const { svc, raw } = makeService(local, {
      listSessions: async () => [
        { header: { id: 'session-fresh', createdAt: BASE } },
        { header: { id: 'session-lag', createdAt: BASE } },
      ],
      readSession: async (id: string) => ({
        session: { id, createdAt: BASE },
        events: id === 'session-lag' ? laggingEvents : [],
      }),
    })
    const processed = await (raw['runBackfill'] as () => Promise<number>).call(svc)
    assert.equal(processed, 1)
    const stored = local.get('session-lag')
    assert.ok(stored !== undefined)
    assert.equal(stored.turns, 1)
    assert.equal(stored.totals.totalTokens, 220)
    assert.equal(stored.lastSeq, laggingEvents[laggingEvents.length - 1].seq)
    assert.equal(stored.engine, 4)
    assert.equal(stored.latestTurn, 1)
    // The replayed folder is installed so live events continue with full state.
    assert.ok((raw['folders'] as Map<string, unknown>).has('session-lag'))
    assert.ok(!(raw['folders'] as Map<string, unknown>).has('session-fresh'))
  })

  it('recomputes a stale-engine row even when its lastSeq is up to date', async () => {
    const local = makeTable([
      ['session-old', {
        sessionId: 'session-old',
        sessionCreatedAt: BASE,
        engine: 3, // produced by the previous engine version
        lastSeq: 4, // up to date seq-wise
        turns: 1,
        incompleteTurns: 0,
        totals: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        byComponent: {},
        byTool: {},
        byDay: {},
        firstAt: BASE,
        lastAt: BASE,
      } satisfies SessionRollupRecord],
    ])
    const events = turnEvents(1, 100, 10)
    const { svc, raw } = makeService(local, {
      listSessions: async () => [{ header: { id: 'session-old', createdAt: BASE } }],
      readSession: async (id: string) => ({ session: { id, createdAt: BASE }, events }),
    })
    const processed = await (raw['runBackfill'] as () => Promise<number>).call(svc)
    assert.equal(processed, 1)
    const stored = local.get('session-old')
    assert.ok(stored !== undefined)
    assert.equal(stored.engine, 4)
    assert.equal(stored.totals.totalTokens, 110)
  })
})

describe('trace/traceBatch replay cache', () => {
  function twoTurnSession() {
    return [...turnEvents(1, 100, 10), ...turnEvents(2, 200, 20)]
  }

  it('traceBatch replays the log ONCE and populates the cache for trace()', async () => {
    const local = makeTable()
    let reads = 0
    const { svc, raw } = makeService(local, {
      listSessions: async () => [],
      readSession: async (id: string) => {
        reads += 1
        return { session: { id, createdAt: BASE }, events: twoTurnSession() }
      },
    })
    const batch = await (raw['traceBatch'] as (s: string, t: number[]) => Promise<unknown[]>).call(svc, 's-batch', [2, 1])
    assert.equal(batch.length, 2)
    assert.equal(reads, 1)
    // trace(1) is now served from the cache without another replay.
    const single = await (raw['trace'] as (s: string, t: number) => Promise<unknown>).call(svc, 's-batch', 1)
    assert.ok(single !== null)
    assert.equal(reads, 1)
  })

  it('evicts the LRU trace cache beyond capacity', async () => {
    const local = makeTable()
    const manyTurns: AnyEvent[] = []
    for (let turn = 1; turn <= 33; turn += 1) manyTurns.push(...turnEvents(turn, 10, 1))
    const { svc, raw } = makeService(local, {
      listSessions: async () => [],
      readSession: async (id: string) => ({ session: { id, createdAt: BASE }, events: manyTurns }),
    })
    const all = await (raw['traceBatch'] as (s: string, t: number[]) => Promise<unknown[]>)
      .call(svc, 's-evict', Array.from({ length: 33 }, (_, i) => i + 1))
    assert.equal(all.length, 33)
    assert.equal((raw['traceCache'] as Map<string, unknown>).size, 32)
  })
})

describe('follow stream', () => {
  it('emits the snapshot first, then dispatched frames, and cleans up on abort', async () => {
    const local = makeTable()
    const { svc, raw } = makeService(local)
    const controller = new AbortController()
    const iterator = (raw['follow'] as (s: string, signal: AbortSignal) => AsyncGenerator<unknown>)
      .call(svc, 's-follow', controller.signal)
    const first = await iterator.next()
    assert.equal((first.value as { kind: string }).kind, 'snapshot')
    const frames: Array<{ kind: string }> = []
    const consuming = (async () => {
      for await (const frame of iterator) frames.push(frame as { kind: string })
    })()
    const completed = {
      sessionId: 's-follow',
      turn: 1,
      status: 'complete',
      startedAt: BASE,
      endedAt: BASE + 1000,
      attempts: [],
      totals: null,
      cacheEvents: [],
    }
    ;(raw['dispatchTurn'] as (s: string, t: unknown) => void).call(svc, 's-follow', completed)
    ;(raw['dispatchTurn'] as (s: string, t: unknown) => void).call(svc, 's-follow', completed)
    // Let the generator yield the queued frames before aborting.
    await new Promise(resolve => setTimeout(resolve, 10))
    controller.abort()
    await consuming
    assert.equal(frames.filter(frame => frame.kind === 'turn').length, 2)
    assert.equal((raw['followers'] as Map<string, Set<unknown>>).get('s-follow')?.size ?? 0, 0)
  })
})

describe('rollup views', () => {
  it('sessions() sorts newest activity first and respects the limit', () => {
    const local = makeTable([
      ['old', {
        sessionId: 'old', sessionCreatedAt: BASE, lastSeq: 1, turns: 1, incompleteTurns: 0,
        totals: { inputTokens: 0, outputTokens: 0, totalTokens: 5 },
        byComponent: {}, byTool: {}, byDay: {}, firstAt: BASE, lastAt: BASE,
      }],
      ['new', {
        sessionId: 'new', sessionCreatedAt: BASE, lastSeq: 2, turns: 1, incompleteTurns: 0,
        totals: { inputTokens: 0, outputTokens: 0, totalTokens: 7 },
        byComponent: {}, byTool: {}, byDay: {}, firstAt: BASE, lastAt: BASE + 1000,
      }],
    ])
    const { svc } = makeService(local)
    const rows = (svc as unknown as { sessions(query?: { limit?: number }): SessionRollupView[] })
      .sessions({ limit: 1 })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].sessionId, 'new')
  })
})
