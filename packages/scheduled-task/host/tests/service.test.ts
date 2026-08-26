/**
 * Unit tests for ScheduledTaskService behavior that does not need a live
 * cordis Context: error mapping, read/mutation semantics, admission backoff,
 * fire persistence, and resume/create discrimination. The service instance is
 * assembled with Object.create so no plugin runtime is required; every
 * injected dependency is a hand-rolled fake.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ScheduledTaskError, buildRule } from '../src/domain.ts'
import { admissionBackoffMs, ScheduledTaskService } from '../src/index.ts'
import type { ScheduledTaskRecord } from '../src/spec.ts'
import type { ScheduledTaskId } from '../src/types.ts'

/* ------------------------------------------------------------------ fakes */

interface FakeTable {
  rows: Map<ScheduledTaskId, ScheduledTaskRecord>
  puts: number[]
}

function makeTable(rows: Array<[ScheduledTaskId, ScheduledTaskRecord]> = []): Kv & FakeTable {
  const map = new Map<ScheduledTaskId, ScheduledTaskRecord>(rows)
  const puts: ScheduledTaskId[] = []
  const table = {
    rows: map,
    puts,
    get: (id: ScheduledTaskId) => map.get(id),
    entries: () => [...map.entries()],
    delete: async (id: ScheduledTaskId) => map.delete(id),
    put: async (id: ScheduledTaskId, record: ScheduledTaskRecord) => {
      map.set(id, record)
      puts.push(id)
    },
  }
  return table as unknown as Kv & FakeTable
}
type Kv = {
  get(id: ScheduledTaskId): ScheduledTaskRecord | undefined
  entries(): Array<[ScheduledTaskId, ScheduledTaskRecord]>
  delete(id: ScheduledTaskId): Promise<boolean>
  put(id: ScheduledTaskId, record: ScheduledTaskRecord): Promise<void>
}

function makeService(table: ReturnType<typeof makeTable>, overrides: {
  agents?: Record<string, (options: never) => unknown>
  logger?: { warnings: string[] }
} = {}) {
  const warnings: string[] = []
  const svc = Object.create(ScheduledTaskService.prototype) as Record<string, unknown> & ScheduledTaskService
  svc['table'] = table
  svc['handles'] = new Map()
  svc['failures'] = new Map()
  svc['appliedTitles'] = new Map()
  svc['attachedSessions'] = new Set()
  svc['stopping'] = false
  svc.ctx = {
    logger: { warn: (message: string) => warnings.push(message) },
    sessions: { flush: async () => {} },
    sessionTitle: { rename: () => {} },
    workspaceRegistry: { get: () => undefined },
    agents: {
      resume: async () => { throw new Error('session "x" not found') },
      create: async ({ sessionId }: { sessionId: string }) => ({
        agent: {
          session: { id: sessionId, header: { cwd: '/opt/demo-workspace' }, append: () => {} },
          followup: () => {},
        },
        dispose: async () => {},
      }),
      ...overrides.agents,
    },
  }
  return { svc: svc as unknown as ScheduledTaskService, raw: svc, warnings }
}

const NOW = Date.parse('2026-03-06T04:12:33Z')

function taskRecord(overrides: Partial<ScheduledTaskRecord> = {}): ScheduledTaskRecord {
  return {
    id: '9e1c2a44-0000-4000-8000-1f2f3f4f5f6f' as ScheduledTaskId,
    title: '每日总结',
    prompt: '总结工作区状态',
    rule: buildRule({ daily: { time: '09:00', time_zone: 'Asia/Shanghai' } }, NOW)!,
    status: 'active',
    sessionId: 'session-x',
    createdAt: '2026-03-05T00:00:00.000Z',
    confirmBeforeChange: false,
    ...overrides,
  } as ScheduledTaskRecord
}

/* ------------------------------------------------------------------ tests */

describe('admissionBackoffMs', () => {
  it('doubles from 30s and caps at 5min', () => {
    assert.equal(admissionBackoffMs(1), 30_000)
    assert.equal(admissionBackoffMs(2), 60_000)
    assert.equal(admissionBackoffMs(3), 120_000)
    assert.equal(admissionBackoffMs(4), 240_000)
    assert.equal(admissionBackoffMs(5), 300_000)
    assert.equal(admissionBackoffMs(50), 300_000)
  })
})

describe('asMutationError', () => {
  const { svc } = makeService(makeTable())
  const asMutationError = (svc as unknown as { asMutationError(e: unknown): unknown }).asMutationError.bind(svc)

  it('maps ScheduledTaskError to its closed code', () => {
    const result = asMutationError(new ScheduledTaskError('invalid_title', 'nope')) as { code: string }
    assert.equal(result.code, 'invalid_title')
  })

  it('collapses foreign errors to internal_error without leaking details', () => {
    const result = asMutationError(new Error('secret path /Users/x')) as { code: string; message: string }
    assert.equal(result.code, 'internal_error')
    assert.ok(!result.message.includes('secret'))
  })
})

describe('markRead', () => {
  it('writes lastReadAt only for run tasks and is idempotent-safe on unknown ids', async () => {
    const ran = taskRecord({ lastRunAt: new Date(NOW).toISOString() })
    const fresh = taskRecord({ id: 'aaaaaaaa-0000-4000-8000-000000000001' as ScheduledTaskId })
    const table = makeTable([[ran.id, ran], [fresh.id, fresh]])
    const { svc } = makeService(table)

    await svc.markRead(ran.id)
    await svc.markRead(fresh.id)
    await svc.markRead('unknown-id' as ScheduledTaskId)

    assert.equal(table.rows.get(ran.id)?.lastReadAt !== undefined, true)
    assert.equal(table.rows.get(fresh.id)?.lastReadAt, undefined)
  })
})

describe('setStatus', () => {
  it('rejects completed tasks and persists pause/resume', async () => {
    const done = taskRecord({
      id: 'bbbbbbbb-0000-4000-8000-000000000002' as ScheduledTaskId,
      status: 'completed',
    })
    const live = taskRecord({ id: 'cccccccc-0000-4000-8000-000000000003' as ScheduledTaskId })
    const table = makeTable([[done.id, done], [live.id, live]])
    const { svc } = makeService(table)

    const rejected = await svc.setStatus(done.id, 'paused')
    assert.equal(rejected.ok, false)

    const paused = await svc.setStatus(live.id, 'paused')
    assert.equal(paused.ok && paused.task.status === 'paused', true)
    assert.equal(table.rows.get(live.id)?.status, 'paused')
  })

  it('returns task_not_found for unknown ids', async () => {
    const { svc } = makeService(makeTable())
    const result = await svc.setStatus('ghost' as ScheduledTaskId, 'paused')
    assert.deepEqual(result, { ok: false, code: 'task_not_found', message: "no scheduled task 'ghost'." })
  })
})

describe('delete', () => {
  it('reports deleted:false for unknown ids and disposes retained handles', async () => {
    const record = taskRecord()
    const table = makeTable([[record.id, record]])
    const { svc, raw } = makeService(table)
    let disposed = 0
    ;(raw['handles'] as Map<ScheduledTaskId, { dispose(): Promise<void> }>).set(
      record.id, { dispose: async () => { disposed += 1 } },
    )

    const missing = await svc.delete('ghost' as ScheduledTaskId)
    assert.deepEqual(missing, { ok: true, deleted: false })

    const removed = await svc.delete(record.id)
    assert.deepEqual(removed, { ok: true, deleted: true })
    assert.equal(disposed, 1)
    assert.equal((raw['failures'] as Map<unknown, unknown>).has(record.id), false)
  })
})

describe('fireOne success path', () => {
  it('queues the framing message, advances the rule, clears lastError, flushes', async () => {
    const due = taskRecord({
      rule: buildRule({ daily: { time: '04:00', time_zone: 'UTC' } }, NOW)!,
      lastError: { at: new Date(NOW - 1).toISOString(), message: 'old failure' },
    })
    // Make the stored target due at NOW.
    due.rule = { ...due.rule, scheduledAt: new Date(NOW - 1).toISOString() }
    const table = makeTable([[due.id, due]])
    const followups: string[] = []
    let flushed = 0
    const { svc, raw } = makeService(table, {
      agents: {
        resume: async () => { throw new Error('session not found') },
        create: async ({ sessionId }: { sessionId: string }) => ({
          agent: {
            session: { id: sessionId, header: { cwd: '/opt/demo-workspace' }, append: () => {} },
            followup: (message: { content: Array<{ text: string }> }) => { followups.push(message.content[0].text) },
          },
          dispose: async () => {},
        }),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as never)
    svc.ctx.sessions.flush = async () => { flushed += 1 }

    await (svc as unknown as { fireOne(id: ScheduledTaskId, r: ScheduledTaskRecord, now: number): Promise<void> })
      .fireOne(due.id, due, NOW)

    assert.equal(followups.length, 1)
    assert.ok(followups[0].includes('[SCHEDULED TASK]'))
    assert.ok(followups[0].includes(JSON.stringify(due.prompt)))

    const stored = table.rows.get(due.id)!
    assert.equal(stored.lastRunAt, new Date(NOW).toISOString())
    assert.equal(stored.lastError, undefined)
    assert.equal(Date.parse(stored.rule.scheduledAt) > NOW, true, 'daily rule advanced past NOW')
    assert.equal((raw['failures'] as Map<unknown, unknown>).size, 0)
    assert.equal(flushed, 1)
  })
})

describe('fireOne failure path', () => {
  it('persists lastError and backs off without advancing the rule', async () => {
    const due = taskRecord({ rule: buildRule({ hourly: { minute: 30 } }, NOW)! })
    const table = makeTable([[due.id, due]])
    let createCalls = 0
    const { svc, warnings } = makeService(table, {
      agents: {
        resume: async () => { throw new Error('session not found') },
        create: async () => {
          createCalls += 1
          throw new Error('provider "openrouter" has no configured model')
        },
      },
    } as never)

    await (svc as unknown as { fireOne(id: ScheduledTaskId, r: ScheduledTaskRecord, now: number): Promise<void> })
      .fireOne(due.id, due, NOW)
    await (svc as unknown as { fireOne(id: ScheduledTaskId, r: ScheduledTaskRecord, now: number): Promise<void> })
      .fireOne(due.id, due, NOW + 31_000)

    const stored = table.rows.get(due.id)!
    assert.match(stored.lastError?.message ?? '', /openrouter/)
    assert.equal(stored.rule.scheduledAt, due.rule.scheduledAt, 'rule untouched on failure')
    assert.equal(stored.lastRunAt, undefined)

    const failures = svc as unknown as { failures: Map<ScheduledTaskId, { count: number; retryAfter: number }> }
    const state = failures.failures.get(due.id)!
    assert.equal(state.count, 2)
    assert.equal(state.retryAfter, NOW + 31_000 + admissionBackoffMs(2))
    assert.equal(createCalls, 2)
    assert.equal(warnings.length >= 2, true)
  })

  it('rethrows non-missing resume failures instead of re-creating the session', async () => {
    const due = taskRecord()
    const table = makeTable([[due.id, due]])
    let createCalls = 0
    const { svc } = makeService(table, {
      agents: {
        resume: async () => { throw new Error('session store corrupted') },
        create: async () => {
          createCalls += 1
          throw new Error('unreachable')
        },
      },
    } as never)

    await (svc as unknown as { fireOne(id: ScheduledTaskId, r: ScheduledTaskRecord, now: number): Promise<void> })
      .fireOne(due.id, due, NOW)

    assert.equal(createCalls, 0, 'create must not run for unrelated resume failures')
    assert.match((table.rows.get(due.id)!.lastError?.message ?? ''), /corrupted/)
  })

  it('falls back to create only when resume reports the session missing', async () => {
    const due = taskRecord({ cwd: '/opt/demo-workspace' })
    const table = makeTable([[due.id, due]])
    const createdWith: Array<{ sessionId: string; meta: { cwd: string } }> = []
    const { svc } = makeService(table, {
      agents: {
        resume: async () => { throw new Error(`session "${'task-x-abcd'}" does not exist`) },
        create: async (options: { sessionId: string; meta: { cwd: string } }) => {
          createdWith.push(options)
          return {
            agent: {
              session: { id: options.sessionId, header: { cwd: options.meta.cwd }, append: () => {} },
              followup: () => {},
            },
            dispose: async () => {},
          }
        },
      },
    } as never)

    await (svc as unknown as { fireOne(id: ScheduledTaskId, r: ScheduledTaskRecord, now: number): Promise<void> })
      .fireOne(due.id, due, NOW)

    assert.equal(createdWith.length, 1)
    assert.ok(createdWith[0].sessionId.startsWith(`task-${String(due.id)}-`))
    assert.equal(createdWith[0].meta.cwd, '/opt/demo-workspace')
    assert.equal(table.rows.get(due.id)!.sessionId, createdWith[0].sessionId, 'derived session id persisted')
  })
})
