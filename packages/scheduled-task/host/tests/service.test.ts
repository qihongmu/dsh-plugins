/**
 * Unit tests for ScheduledTaskService behavior that does not need a live
 * cordis Context: error mapping, read/mutation semantics, admission backoff,
 * fire persistence, and resume/create discrimination. The service instance is
 * assembled with Object.create so no plugin runtime is required; every
 * injected dependency is a hand-rolled fake.
 */

import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'
import { ScheduledTaskError, buildRule } from '../src/domain.ts'
import { admissionBackoffMs, nextDelayMs, ScheduledTaskService } from '../src/index.ts'
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
  agentPresets?: {
    resolve: (id?: string) => Promise<{ id: string }>
    mount: (agentCtx: unknown, id: string) => Promise<void>
  }
  agentDefaultModel?: { currentSelection: () => { provider: string; model: string } }
} = {}) {
  const warnings: string[] = []
  const svc = Object.create(ScheduledTaskService.prototype) as Record<string, unknown> & ScheduledTaskService
  svc['table'] = table
  svc['handles'] = new Map()
  svc['compositions'] = new Map()
  svc['firing'] = new Set()
  svc['failures'] = new Map()
  svc['appliedTitles'] = new Map()
  svc['attachedSessions'] = new Set()
  svc['stopping'] = false
  svc.ctx = {
    logger: { warn: (message: string) => warnings.push(message) },
    sessions: { flush: async () => {} },
    sessionTitle: { rename: () => {} },
    workspaceRegistry: { get: () => undefined },
    get: (name: string) => (name === 'agentPresets'
      ? overrides.agentPresets
      : name === 'agentDefaultModel' ? overrides.agentDefaultModel : undefined),
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

describe('fireOne preset composition', () => {
  const fire = (svc: ScheduledTaskService, due: ScheduledTaskRecord) =>
    (svc as unknown as { fireOne(id: ScheduledTaskId, r: ScheduledTaskRecord, now: number): Promise<void> })
      .fireOne(due.id, due, NOW)

  const dueTask = () => {
    const due = taskRecord({
      cwd: '/opt/demo-workspace',
      rule: buildRule({ daily: { time: '04:00', time_zone: 'UTC' } }, NOW)!,
    })
    due.rule = { ...due.rule, scheduledAt: new Date(NOW - 1).toISOString() }
    return due
  }

  const demoPresets = (mounts: Array<[unknown, string]> = [], id: { value: string } = { value: 'demo-preset' }) => ({
    resolve: async () => ({ id: id.value }),
    mount: async (agentCtx: unknown, presetId: string) => { mounts.push([agentCtx, presetId]) },
  })
  const demoDefaults = (selection: { provider: string; model: string } = { provider: 'demo', model: 'demo-model' }) => ({
    currentSelection: () => selection,
  })
  /** A setup target stub: installModelSelection registers listeners via `.on`. */
  const setupCtx = () => ({ on: () => () => {} })
  const handleFor = (sessionId: string, cwd = '/opt/demo-workspace') => ({
    agent: {
      session: { id: sessionId, header: { cwd }, append: () => {} },
      followup: () => {},
    },
    dispose: async () => {},
  })

  it('composes the run agent with the default preset and default model selection on create', async () => {
    const due = dueTask()
    const table = makeTable([[due.id, due]])
    const mounts: Array<[unknown, string]> = []
    const created: Array<Record<string, unknown>> = []
    const { svc } = makeService(table, {
      agentPresets: demoPresets(mounts),
      agentDefaultModel: demoDefaults(),
      agents: {
        resume: async () => { throw new Error('session not found') },
        create: async (options: never) => {
          created.push(options as Record<string, unknown>)
          return handleFor((options as { sessionId: string }).sessionId)
        },
      },
    } as never)

    // First fire: no persisted session yet → create carries the composition.
    await fire(svc, due)
    assert.equal(created.length, 1)
    assert.equal((created[0]!.meta as { agentPreset?: string }).agentPreset, 'demo-preset')
    assert.deepEqual(created[0]!.agentOptions, { provider: 'demo', model: 'demo-model' })
    assert.equal(typeof created[0]!.setup, 'function')
    const agentCtx = setupCtx()
    await (created[0]!.setup as (ctx: unknown) => Promise<void>)(agentCtx)
    assert.deepEqual(mounts, [[agentCtx, 'demo-preset']])

    // Second fire reuses the retained handle — no further create/resume.
    await fire(svc, due)
    assert.equal(created.length, 1)
  })

  it('prefers the task stored model over the deployment default', async () => {
    const due = dueTask()
    due.model = { provider: 'custom', model: 'custom-model' }
    const table = makeTable([[due.id, due]])
    const created: Array<Record<string, unknown>> = []
    const { svc } = makeService(table, {
      agentDefaultModel: demoDefaults(),
      agents: {
        resume: async () => { throw new Error('session not found') },
        create: async (options: never) => {
          created.push(options as Record<string, unknown>)
          return handleFor((options as { sessionId: string }).sessionId)
        },
      },
    } as never)

    await fire(svc, due)

    assert.deepEqual(created[0]!.agentOptions, { provider: 'custom', model: 'custom-model' })
  })

  it('passes the preset setup on the resume path for already-persisted sessions', async () => {
    const due = dueTask()
    const table = makeTable([[due.id, due]])
    const resumed: Array<Record<string, unknown>> = []
    const { svc } = makeService(table, {
      agentPresets: demoPresets(),
      agentDefaultModel: demoDefaults(),
      agents: {
        resume: async (options: never) => {
          resumed.push(options as Record<string, unknown>)
          return handleFor((options as { resumeSessionId: string }).resumeSessionId)
        },
        create: async () => { throw new Error('unreachable') },
      },
    } as never)

    await fire(svc, due)

    assert.equal(resumed.length, 1)
    assert.equal(typeof resumed[0]!.setup, 'function')
    assert.deepEqual(resumed[0]!.agentOptions, { provider: 'demo', model: 'demo-model' })
    assert.equal((table.rows.get(due.id)!.lastError), undefined)
  })

  it('fires without setup when the deployment has neither preset roster nor model defaults', async () => {
    const due = dueTask()
    const table = makeTable([[due.id, due]])
    const created: Array<Record<string, unknown>> = []
    const { svc } = makeService(table, {
      agents: {
        resume: async () => { throw new Error('session not found') },
        create: async (options: never) => {
          created.push(options as Record<string, unknown>)
          return handleFor((options as { sessionId: string }).sessionId)
        },
      },
    } as never)

    await fire(svc, due)

    assert.equal(created.length, 1)
    assert.equal(created[0]!.setup, undefined)
    assert.equal(created[0]!.agentOptions, undefined)
    assert.equal((created[0]!.meta as { agentPreset?: string }).agentPreset, undefined)
    assert.equal(table.rows.get(due.id)!.lastRunAt, new Date(NOW).toISOString())
  })

  it('applies task model edits to the retained run agent in place', async () => {
    const due = dueTask()
    const table = makeTable([[due.id, due]])
    const created: Array<Record<string, unknown>> = []
    const { svc, raw } = makeService(table, {
      agentDefaultModel: demoDefaults(),
      agents: {
        resume: async () => { throw new Error('session not found') },
        create: async (options: never) => {
          created.push(options as Record<string, unknown>)
          return handleFor((options as { sessionId: string }).sessionId)
        },
      },
    } as never)

    await fire(svc, due)
    assert.equal(created.length, 1)

    // Edit the task model; the next fire must reach the LIVE agent without
    // recomposing — the installed selection ref is updated in place.
    due.model = { provider: 'custom', model: 'edited-model' }
    await fire(svc, due)

    assert.equal(created.length, 1, 'retained handle reused, no re-create')
    const carried = (raw['compositions'] as Map<ScheduledTaskId, {
      selectionRef: { current: { provider: string; model: string } | undefined }
    }>).get(due.id)
    assert.deepEqual(carried?.selectionRef.current, { provider: 'custom', model: 'edited-model' })
  })

  it('recomposes through dispose + resume when the default preset changes', async () => {
    const due = dueTask()
    const table = makeTable([[due.id, due]])
    const presetId = { value: 'demo-preset' }
    const mounts: Array<[unknown, string]> = []
    let disposed = 0
    let resumed = 0
    let resumeFailures = 1
    const created: Array<Record<string, unknown>> = []
    const { svc, raw } = makeService(table, {
      agentPresets: demoPresets(mounts, presetId),
      agentDefaultModel: demoDefaults(),
      agents: {
        resume: async (options: never) => {
          if (resumeFailures > 0) {
            resumeFailures -= 1
            throw new Error('session not found')
          }
          resumed += 1
          await (options as { setup?: (ctx: unknown) => Promise<void> }).setup?.(setupCtx())
          return handleFor((options as { resumeSessionId: string }).resumeSessionId)
        },
        create: async (options: never) => {
          created.push(options as Record<string, unknown>)
          await (options as { setup?: (ctx: unknown) => Promise<void> }).setup?.(setupCtx())
          return {
            agent: {
              session: { id: (options as { sessionId: string }).sessionId, header: { cwd: '/opt/demo-workspace' }, append: () => {} },
              followup: () => {},
            },
            dispose: async () => { disposed += 1 },
          }
        },
      },
    } as never)

    // First fire creates with the demo preset mounted.
    await fire(svc, due)
    assert.equal(created.length, 1)
    assert.equal(mounts.length, 1)

    // Change the default preset; the next fire must drop the stale handle and
    // resume the session with the new preset mounted.
    presetId.value = 'other-preset'
    await fire(svc, due)

    assert.equal(disposed, 1, 'stale handle disposed')
    assert.equal(resumed, 1, 'session resumed under the new preset')
    assert.equal(created.length, 1, 'no second create')
    assert.equal(mounts.length, 2)
    assert.equal(mounts[1]![1], 'other-preset')
    const carried = (raw['compositions'] as Map<ScheduledTaskId, { presetId?: string }>).get(due.id)
    assert.equal(carried?.presetId, 'other-preset')
  })

  it('ignores a re-entrant admission while the same task fire is in flight', async () => {
    const due = dueTask()
    const table = makeTable([[due.id, due]])
    let createCalls = 0
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const { svc } = makeService(table, {
      agentDefaultModel: demoDefaults(),
      agents: {
        resume: async () => { throw new Error('session not found') },
        create: async (options: never) => {
          createCalls += 1
          await gate
          return handleFor((options as { sessionId: string }).sessionId)
        },
      },
    } as never)

    // First admission stalls inside composition; a second one (as a rearm
    // during the window would trigger) must not start a second fire.
    const first = fire(svc, due)
    const second = fire(svc, due)
    release()
    await Promise.all([first, second])

    assert.equal(createCalls, 1, 'only one live agent composed for the session')
    const carried = (svc as unknown as { firing: Set<ScheduledTaskId> }).firing
    assert.equal(carried.has(due.id), false, 'guard released after the fire settles')
  })

  it('surfaces a broken preset roster as a task error instead of a silent tool-less run', async () => {
    const due = dueTask()
    const table = makeTable([[due.id, due]])
    const { svc, warnings } = makeService(table, {
      agentPresets: {
        resolve: async () => { throw new Error('agent-presets: preset "default" not found') },
        mount: async () => {},
      },
    } as never)

    await fire(svc, due)

    assert.match(table.rows.get(due.id)!.lastError?.message ?? '', /not found/)
    assert.equal(table.rows.get(due.id)!.lastRunAt, undefined)
    assert.equal(warnings.length >= 1, true)
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

/* ------------------------------------------------------------ scheduling */

/** A task record whose rule carries an explicit scheduled instant. */
function recordAt(overrides: Partial<ScheduledTaskRecord> = {}): ScheduledTaskRecord {
  return taskRecord(overrides)
}

/** One-shot/admission fake handle mirroring the harness's default create. */
function fakeHandle(options: { sessionId: string; meta?: { cwd?: string } }) {
  return {
    agent: {
      session: {
        id: options.sessionId,
        header: { cwd: options.meta?.cwd ?? '/opt/demo-workspace' },
        append: () => {},
      },
      followup: () => {},
    },
    dispose: async () => {},
  }
}

function dueRecord(overrides: Partial<ScheduledTaskRecord> = {}): ScheduledTaskRecord {
  const record = taskRecord(overrides)
  record.rule = { ...record.rule, scheduledAt: new Date(NOW - 1).toISOString() }
  return record
}

/** Clear a real timer the service armed, so the test process can exit. */
function disarm(raw: Record<string, unknown>): void {
  const timer = raw['timer']
  if (timer !== undefined && timer !== 999) clearTimeout(timer as ReturnType<typeof setTimeout>)
}

describe('nextDelayMs', () => {
  const at = (iso: string) => ({ ...taskRecord().rule, scheduledAt: iso })

  it('chooses the earliest active target', () => {
    const records: Array<[ScheduledTaskId, ScheduledTaskRecord]> = [
      ['1' as ScheduledTaskId, taskRecord({ id: '1' as ScheduledTaskId, rule: at('2026-03-06T10:00:00.000Z') })],
      ['2' as ScheduledTaskId, taskRecord({ id: '2' as ScheduledTaskId, rule: at('2026-03-06T08:00:00.000Z') })],
    ]
    assert.equal(nextDelayMs(records, NOW), Date.parse('2026-03-06T08:00:00.000Z') - NOW)
  })

  it('fires overdue targets immediately with delay 0', () => {
    const records: Array<[ScheduledTaskId, ScheduledTaskRecord]> = [
      ['1' as ScheduledTaskId, taskRecord({ rule: at('2026-03-01T00:00:00.000Z') })],
    ]
    assert.equal(nextDelayMs(records, NOW), 0)
  })

  it('clamps far targets to the maximum timer delay', () => {
    const far = new Date(NOW + 2 ** 32).toISOString()
    const records: Array<[ScheduledTaskId, ScheduledTaskRecord]> = [
      ['1' as ScheduledTaskId, taskRecord({ rule: at(far) })],
    ]
    assert.equal(nextDelayMs(records, NOW), 2_147_483_647)
  })

  it('skips paused, completed, and non-finite targets', () => {
    const records: Array<[ScheduledTaskId, ScheduledTaskRecord]> = [
      ['p' as ScheduledTaskId, taskRecord({ id: 'p' as ScheduledTaskId, status: 'paused', rule: at('2020-01-01T00:00:00.000Z') })],
      ['c' as ScheduledTaskId, taskRecord({ id: 'c' as ScheduledTaskId, status: 'completed', rule: at('2020-01-01T00:00:00.000Z') })],
      ['b' as ScheduledTaskId, taskRecord({ id: 'b' as ScheduledTaskId, rule: at('not-a-date') })],
      ['a' as ScheduledTaskId, taskRecord({ id: 'a' as ScheduledTaskId, rule: at('2026-03-06T12:00:00.000Z') })],
    ]
    assert.equal(nextDelayMs(records, NOW), Date.parse('2026-03-06T12:00:00.000Z') - NOW)
  })

  it('returns undefined when no active target is finite', () => {
    const records: Array<[ScheduledTaskId, ScheduledTaskRecord]> = [
      ['p' as ScheduledTaskId, taskRecord({ id: 'p' as ScheduledTaskId, status: 'paused' })],
      ['b' as ScheduledTaskId, taskRecord({ id: 'b' as ScheduledTaskId, rule: at('garbage') })],
    ]
    assert.equal(nextDelayMs(records, NOW), undefined)
  })
})

describe('rearm', () => {
  it('arms a timer for a due active task and un-arms with none', () => {
    const due = dueRecord()
    const table = makeTable([[due.id, due]])
    const { svc, raw } = makeService(table)
    const rearm = (svc as unknown as { rearm(): void }).rearm.bind(svc)
    rearm()
    assert.ok((raw['timer'] as unknown) !== undefined, 'timer armed for a due active task')
    table.rows.get(due.id)!.status = 'paused'
    rearm()
    assert.equal(raw['timer'], undefined, 'no timer when nothing is active')
    disarm(raw)
  })

  it('clears a previous timer before re-arming', () => {
    const due = dueRecord()
    const { svc, raw } = makeService(makeTable([[due.id, due]]))
    const rearm = (svc as unknown as { rearm(): void }).rearm.bind(svc)
    raw['timer'] = 12345
    const original = globalThis.clearTimeout
    const spy = mock.method(globalThis, 'clearTimeout', (id: unknown) => original(id))
    try {
      rearm()
      assert.equal(spy.mock.calls.length, 1, 'stale timer cleared before re-arming')
      assert.notEqual(raw['timer'], 12345)
    } finally {
      spy.mock.restore()
      disarm(raw)
    }
  })

  it('fires a due task through the armed timer', async () => {
    const due = dueRecord()
    const table = makeTable([[due.id, due]])
    const { svc } = makeService(table)
    const rearm = (svc as unknown as { rearm(): void }).rearm.bind(svc)
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
      rearm()
      mock.timers.tick(0)
      await new Promise(resolve => setImmediate(resolve))
      await new Promise(resolve => setImmediate(resolve))
      assert.ok(table.rows.get(due.id)!.lastRunAt !== undefined, 'armed timer fired the due task')
    } finally {
      mock.timers.reset()
    }
  })
})

describe('fireDue', () => {
  const fireDue = (svc: ScheduledTaskService, now: number): Promise<void> =>
    (svc as unknown as { fireDue(now: number): Promise<void> }).fireDue(now)

  it('fires only due active tasks outside their backoff window, then re-arms', async () => {
    const due = dueRecord()
    const pausedPast = taskRecord({
      id: 'bbbbbbbb-0000-4000-8000-000000000002' as ScheduledTaskId,
      status: 'paused',
      rule: { ...taskRecord().rule, scheduledAt: new Date(NOW - 1_000).toISOString() },
    })
    const backingOff = dueRecord({ id: 'cccccccc-0000-4000-8000-000000000003' as ScheduledTaskId })
    const future = taskRecord({
      id: 'dddddddd-0000-4000-8000-000000000004' as ScheduledTaskId,
      rule: { ...taskRecord().rule, scheduledAt: new Date(NOW + 60_000).toISOString() },
    })
    const table = makeTable([[due.id, due], [pausedPast.id, pausedPast], [backingOff.id, backingOff], [future.id, future]])
    const created: string[] = []
    const { svc, raw } = makeService(table, {
      agents: {
        resume: async () => { throw new Error('session not found') },
        create: async (options: { sessionId: string; meta: { cwd: string } }) => {
          created.push(options.sessionId)
          return fakeHandle(options)
        },
      },
    } as never)
    ;(raw['failures'] as Map<ScheduledTaskId, { count: number; retryAfter: number }>)
      .set(backingOff.id, { count: 2, retryAfter: NOW + 60_000 })

    await fireDue(svc, NOW)

    assert.equal(created.length, 1, 'only the due task is admitted')
    assert.ok(created[0].startsWith(`task-${String(due.id)}-`))
    assert.ok(Date.parse(table.rows.get(due.id)!.rule.scheduledAt) > NOW, 'due rule advanced')
    assert.equal(table.rows.get(pausedPast.id)!.lastRunAt, undefined)
    assert.equal(table.rows.get(backingOff.id)!.lastRunAt, undefined, 'backoff window respected')
    assert.equal(table.rows.get(future.id)!.lastRunAt, undefined)
    assert.ok((raw['timer'] as unknown) !== undefined, 're-armed after firing')
    disarm(raw)
  })

  it('fires a task whose backoff window has elapsed', async () => {
    const due = dueRecord()
    const table = makeTable([[due.id, due]])
    const { svc, raw } = makeService(table)
    ;(raw['failures'] as Map<ScheduledTaskId, { count: number; retryAfter: number }>)
      .set(due.id, { count: 1, retryAfter: NOW - 1 })

    await fireDue(svc, NOW)

    assert.ok(table.rows.get(due.id)!.lastRunAt !== undefined, 'retry allowed after the window')
    disarm(raw)
  })

  it('runs admissions concurrently; a hanging one does not block others', async () => {
    const a = dueRecord({ id: 'aaaaaaaa-0000-4000-8000-000000000001' as ScheduledTaskId })
    const b = dueRecord({ id: 'bbbbbbbb-0000-4000-8000-000000000002' as ScheduledTaskId })
    const table = makeTable([[a.id, a], [b.id, b]])
    const started: string[] = []
    const { svc } = makeService(table, {
      agents: {
        resume: async () => { throw new Error('session not found') },
        create: async (options: { sessionId: string; meta: { cwd: string } }) => {
          started.push(options.sessionId)
          if (options.sessionId.includes(String(a.id))) return new Promise(() => {}) as never
          return fakeHandle(options)
        },
      },
    } as never)

    const outcome = await Promise.race([
      fireDue(svc, NOW).then(() => 'settled'),
      new Promise(resolve => setTimeout(() => resolve('timeout'), 150)),
    ])
    assert.equal(outcome, 'timeout', 'fireDue stays pending while one admission hangs')
    assert.equal(started.length, 2, 'both admissions start despite one hanging')
  })
})

/* -------------------------------------------------------------- mutations */

describe('create', () => {
  it('persists a valid task with carry fields and arms the timer', async () => {
    const table = makeTable()
    const { svc, raw } = makeService(table)
    const result = await svc.create({
      title: '  每日总结  ',
      prompt: '  总结工作区  ',
      daily: { time: '09:00', time_zone: 'Asia/Shanghai' },
      workspaceId: 'ws-1',
      cwd: '/opt/ws-1',
      model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      confirmBeforeChange: true,
    })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.task.title, '每日总结', 'title trimmed')
    assert.equal(result.task.prompt, '总结工作区', 'prompt trimmed')
    assert.equal(result.task.workspaceId, 'ws-1')
    assert.equal(result.task.cwd, '/opt/ws-1')
    assert.equal(result.task.model?.provider, 'deepseek-official')
    assert.equal(result.task.confirmBeforeChange, true)
    assert.equal(result.task.status, 'active')
    assert.ok(result.task.sessionId.startsWith('task-'))
    assert.equal(table.puts.length, 1)
    assert.ok((raw['timer'] as unknown) !== undefined, 'timer armed for the new active rule')
    disarm(raw)
  })

  it('maps an absent selector to invalid_selector', async () => {
    const { svc } = makeService(makeTable())
    const result = await svc.create({ title: 't', prompt: 'p' })
    assert.deepEqual(result, {
      ok: false,
      code: 'invalid_selector',
      message: 'scheduled tasks accept exactly one of after_seconds, at, or every_seconds.',
    })
  })

  it('maps a bad wall-clock time zone to invalid_time_zone, not internal_error', async () => {
    const { svc } = makeService(makeTable())
    const result = await svc.create({ title: 't', prompt: 'p', daily: { time: '09:00', time_zone: 'Mars/Olympus' } })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.code, 'invalid_time_zone')
  })

  it('maps invalid title and prompt to their closed codes', async () => {
    const { svc } = makeService(makeTable())
    const badTitle = await svc.create({ title: '  ', prompt: 'p' })
    assert.equal(badTitle.ok, false)
    if (!badTitle.ok) assert.equal(badTitle.code, 'invalid_title')
    const badPrompt = await svc.create({ title: 't', prompt: '' })
    assert.equal(badPrompt.ok, false)
    if (!badPrompt.ok) assert.equal(badPrompt.code, 'invalid_prompt')
  })
})

describe('update', () => {
  it('keeps the stored rule when no selector is supplied', async () => {
    const record = taskRecord()
    const table = makeTable([[record.id, record]])
    const { svc, raw } = makeService(table)
    const result = await svc.update(record.id, { title: 'renamed' })
    assert.equal(result.ok, true)
    assert.equal(table.rows.get(record.id)!.title, 'renamed')
    assert.equal(table.rows.get(record.id)!.rule.kind, record.rule.kind)
    disarm(raw)
  })

  it('replaces the rule when a selector is supplied', async () => {
    const record = taskRecord()
    const table = makeTable([[record.id, record]])
    const { svc, raw } = makeService(table)
    const result = await svc.update(record.id, {
      weekly: { weekdays: [1, 3], time: '08:30', time_zone: 'Asia/Shanghai' },
    })
    assert.equal(result.ok, true)
    assert.equal(table.rows.get(record.id)!.rule.kind, 'weekly')
    disarm(raw)
  })

  it('returns task_not_found for unknown ids and maps bad titles', async () => {
    const { svc } = makeService(makeTable())
    const missing = await svc.update('ghost' as ScheduledTaskId, { title: 'x' })
    assert.deepEqual(missing, { ok: false, code: 'task_not_found', message: "no scheduled task 'ghost'." })

    const record = taskRecord()
    const table = makeTable([[record.id, record]])
    const { svc: svc2 } = makeService(table)
    const bad = await svc2.update(record.id, { title: ' ' })
    assert.equal(bad.ok, false)
    if (!bad.ok) assert.equal(bad.code, 'invalid_title')
  })
})

describe('list', () => {
  it('sorts by scheduledAt then by id', () => {
    const mk = (id: string, scheduledAt: string): ScheduledTaskRecord =>
      taskRecord({ id: id as ScheduledTaskId, rule: { ...taskRecord().rule, scheduledAt } })
    const later = mk('11111111-0000-4000-8000-000000000001', '2026-03-07T00:00:00.000Z')
    const early = mk('22222222-0000-4000-8000-000000000002', '2026-03-06T00:00:00.000Z')
    const tieA = mk('33333333-0000-4000-8000-000000000003', '2026-03-05T00:00:00.000Z')
    const tieB = mk('44444444-0000-4000-8000-000000000004', '2026-03-05T00:00:00.000Z')
    const table = makeTable([[later.id, later], [early.id, early], [tieA.id, tieA], [tieB.id, tieB]])
    const { svc } = makeService(table)
    assert.deepEqual(svc.list().map(task => task.id), [tieA.id, tieB.id, early.id, later.id])
  })
})

describe('fireOne terminal branch', () => {
  it('completes a one-shot task after it fires', async () => {
    const once = taskRecord({ rule: buildRule({ after_seconds: 60 }, NOW)! })
    once.rule = { ...once.rule, scheduledAt: new Date(NOW - 1).toISOString() }
    const table = makeTable([[once.id, once]])
    const { svc, raw } = makeService(table)
    await (svc as unknown as { fireOne(id: ScheduledTaskId, r: ScheduledTaskRecord, now: number): Promise<void> })
      .fireOne(once.id, once, NOW)
    const stored = table.rows.get(once.id)!
    assert.equal(stored.status, 'completed')
    assert.equal(stored.lastRunAt, new Date(NOW).toISOString())
    assert.equal(stored.rule.scheduledAt, once.rule.scheduledAt, 'terminal rule kept')
    assert.equal((raw['failures'] as Map<unknown, unknown>).size, 0)
  })
})

describe('run-session identity', () => {
  it('is stable per task+cwd pair and distinct across cwds', async () => {
    const record = taskRecord({ cwd: '/opt/a' })
    const table = makeTable([[record.id, record]])
    const created: Array<{ sessionId: string; meta: { cwd: string } }> = []
    const { svc } = makeService(table, {
      agents: {
        resume: async () => { throw new Error('session not found') },
        create: async (options: { sessionId: string; meta: { cwd: string } }) => {
          created.push(options)
          return fakeHandle(options)
        },
      },
    } as never)
    const fireOne = (svc as unknown as { fireOne(id: ScheduledTaskId, r: ScheduledTaskRecord, now: number): Promise<void> })
      .fireOne.bind(svc)

    await fireOne(record.id, record, NOW)
    const first = created[0]!
    assert.ok(first.sessionId.startsWith(`task-${String(record.id)}-`))

    // Same cwd again: the retained handle matches, no new session is created.
    await fireOne(record.id, table.rows.get(record.id)!, NOW + 1_000)
    assert.equal(created.length, 1, 'same task+cwd reuses the retained handle')

    // Different cwd: a fresh session id is derived.
    await fireOne(record.id, { ...table.rows.get(record.id)!, cwd: '/opt/b' }, NOW + 2_000)
    assert.equal(created.length, 2)
    assert.ok(created[1]!.sessionId.startsWith(`task-${String(record.id)}-`))
    assert.notEqual(created[1]!.sessionId, first.sessionId)
  })
})

describe('teardown', () => {
  it('stops the timer and disposes retained run agents', async () => {
    const { svc, raw } = makeService(makeTable())
    let disposed = 0
    ;(raw['handles'] as Map<ScheduledTaskId, { dispose(): Promise<void> }>)
      .set('h1' as ScheduledTaskId, { dispose: async () => { disposed += 1 } })
    raw['timer'] = 999

    await (svc as unknown as { teardown(): Promise<void> }).teardown()

    assert.equal(disposed, 1)
    assert.equal((raw['handles'] as Map<unknown, unknown>).size, 0)
    assert.equal(raw['timer'], undefined)
    assert.equal(raw['stopping'], true)
  })
})
