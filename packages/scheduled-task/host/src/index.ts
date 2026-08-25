/**
 * External global scheduled-task capability: durable registry, scheduler,
 * delivery, and Remote surface. Reuses only shipped dsh API — no repo edits.
 * @module @deepseek-ai/dsh-plugins-scheduled-task
 */

import { createHash, randomUUID } from 'node:crypto'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionTitleService } from '@deepseek-ai/dsh-session-title'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  advanceRule,
  buildRule,
  renderTaskFraming,
  ScheduledTaskError,
  ScheduledTaskId,
  scheduledTaskView,
  validatePrompt,
  validateTitle,
} from './domain.ts'
import { scheduledTaskDomainSpec } from './spec.ts'
import type { ScheduledTaskRecord } from './spec.ts'
import type {
  ScheduledTaskCarryFields,
  ScheduledTaskCreateInput,
  ScheduledTaskDeleteResult,
  ScheduledTaskId as ScheduledTaskIdType,
  ScheduledTaskMutationResult,
  ScheduledTaskSettableStatus,
  ScheduledTaskUpdateInput,
  ScheduledTaskView,
} from './types.ts'

export {
  ScheduledTaskError,
  ScheduledTaskId,
  advanceRule,
  buildRule,
  renderTaskFraming,
  scheduledTaskView,
  validatePrompt,
  validateTitle,
} from './domain.ts'
export { scheduledTaskDomainSpec, scheduledTaskRecord } from './spec.ts'
export type * from './types.ts'

/** Largest delay Node timers represent without clamping. */
const MAX_TIMER_DELAY_MS = 2_147_483_647

/** Render an unknown value for process-local diagnostics only. */
function renderThrown(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/**
 * Deterministic run-session identity for one task+project pair. Deriving the id
 * from the cwd makes a project edit migrate the task to a FRESH conversation in
 * the new workspace (workspace listings index sessions by their header's
 * canonical cwd), while toggling back to an earlier project re-attaches that
 * project's existing history.
 */
function runSessionIdOf(taskId: string, cwd: string): SessionId {
  const digest = createHash('sha256').update(cwd).digest('hex').slice(0, 8)
  return SessionId(`task-${taskId}-${digest}`)
}

/** Whether a table entry is a task currently due for admission. */
function isDue(record: ScheduledTaskRecord, now: number): boolean {
  return record.status === 'active' && Date.parse(record.rule.scheduledAt) <= now
}

/** Merge optional carry fields (prompt/project/model/confirmation) onto a record. */
function applyCarry(target: ScheduledTaskRecord, carry: ScheduledTaskCarryFields): ScheduledTaskRecord {
  if (carry.prompt !== undefined) target.prompt = validatePrompt(carry.prompt)
  if (carry.confirmBeforeChange !== undefined) target.confirmBeforeChange = carry.confirmBeforeChange
  if (carry.workspaceId !== undefined) target.workspaceId = carry.workspaceId
  if (carry.cwd !== undefined) target.cwd = carry.cwd
  if (carry.model !== undefined) target.model = carry.model
  return target
}

/**
 * Global scheduled-task capability. The `tasks` storage-domain table is the
 * only durable task authority; the in-memory table is its live projection, and
 * the single timer is a disposable projection of the earliest due target. Each
 * task's run Session is created lazily on first fire and kept live while the
 * process runs.
 */
export class ScheduledTaskService extends TypertRemoteService {
  /** Services required before tasks can be listed, mutated, or fired. */
  static inject = ['storageDomain', 'agents', 'sessions', 'sessionTitle', 'workspaceRegistry']

  private table?: KvTable<ScheduledTaskIdType, ScheduledTaskRecord>
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly handles = new Map<ScheduledTaskIdType, AgentHandle>()
  /** Last task title pinned onto each run session (avoids re-rename spam). */
  private readonly appliedTitles = new Map<SessionId, string>()
  /** Run sessions already attached to their bound workspace (avoids re-attach churn). */
  private readonly attachedSessions = new Set<string>()
  /** Consecutive admission failures per task, backing off the next retry. */
  private readonly failures = new Map<ScheduledTaskIdType, { count: number; retryAfter: number }>()
  private stopping = false

  constructor(ctx: Context) {
    super(ctx, 'scheduledTasks')
  }

  /** Open the domain, arm the first timer, and register teardown. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(scheduledTaskDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'scheduled-task.domainClose')
    this.table = domain.table('tasks')
    this.ctx.effect(() => () => { void this.teardown() }, 'scheduled-task.teardown')
    this.rearm()
  }

  /**
   * List every task, earliest target first, with wall-clock-derived view fields.
   * @returns The complete client-facing task list.
   */
  @Remote
  list(): ScheduledTaskView[] {
    const now = Date.now()
    return [...this.requireTable().entries()]
      .map(([, record]) => scheduledTaskView(record, now))
      .sort((left, right) =>
        Date.parse(left.rule.scheduledAt) - Date.parse(right.rule.scheduledAt)
        || String(left.id).localeCompare(String(right.id)))
  }

  /**
   * Create one task from a non-empty title and exactly one schedule selector.
   * @param input - Task instruction and schedule selector.
   * @returns The created task view or a stable error.
   */
  @Remote
  async create(input: ScheduledTaskCreateInput): Promise<ScheduledTaskMutationResult> {
    try {
      const title = validateTitle(input.title)
      const prompt = validatePrompt(input.prompt)
      const rule = buildRule(input, Date.now())
      if (rule === undefined) {
        return { ok: false, code: 'invalid_selector', message: 'scheduled tasks accept exactly one of after_seconds, at, or every_seconds.' }
      }
      const id = ScheduledTaskId(randomUUID())
      const record = applyCarry({
        id,
        title,
        prompt,
        rule,
        status: 'active',
        sessionId: SessionId(`task-${id}`),
        createdAt: new Date().toISOString(),
        confirmBeforeChange: false,
      }, input)
      await this.requireTable().put(id, record)
      this.rearm()
      return { ok: true, task: scheduledTaskView(record, Date.now()) }
    } catch (error: unknown) {
      return this.asMutationError(error)
    }
  }

  /**
   * Edit a task's title and/or schedule; absent fields keep their stored value.
   * @param id - Task to edit.
   * @param input - Replacement title and/or schedule selector.
   * @returns The updated task view or a stable error.
   */
  @Remote
  async update(id: ScheduledTaskIdType, input: ScheduledTaskUpdateInput): Promise<ScheduledTaskMutationResult> {
    try {
      const record = this.requireTable().get(id)
      if (record === undefined) return this.notFound(id)
      const title = input.title === undefined ? record.title : validateTitle(input.title)
      const rule = buildRule(input, Date.now()) ?? record.rule
      const next = applyCarry({ ...record, title, rule }, input)
      await this.requireTable().put(id, next)
      this.rearm()
      return { ok: true, task: scheduledTaskView(next, Date.now()) }
    } catch (error: unknown) {
      return this.asMutationError(error)
    }
  }

  /**
   * Pause or resume an active/paused task; completed tasks reject.
   * @param id - Task to change.
   * @param status - Target lifecycle status (`active` or `paused`).
   * @returns The updated task view or a stable error.
   */
  @Remote
  async setStatus(id: ScheduledTaskIdType, status: ScheduledTaskSettableStatus): Promise<ScheduledTaskMutationResult> {
    try {
      const record = this.requireTable().get(id)
      if (record === undefined) return this.notFound(id)
      if (record.status === 'completed') {
        return { ok: false, code: 'invalid_rule', message: 'a completed task cannot change status.' }
      }
      const next: ScheduledTaskRecord = { ...record, status }
      await this.requireTable().put(id, next)
      this.rearm()
      return { ok: true, task: scheduledTaskView(next, Date.now()) }
    } catch (error: unknown) {
      return this.asMutationError(error)
    }
  }

  /**
   * Delete one task and dispose its live run Agent, if any.
   * @param id - Task to delete.
   * @returns Whether a task was deleted, or a stable error.
   */
  @Remote
  async delete(id: ScheduledTaskIdType): Promise<ScheduledTaskDeleteResult> {
    try {
      const deleted = await this.requireTable().delete(id)
      if (deleted) {
        const handle = this.handles.get(id)
        if (handle !== undefined) {
          this.handles.delete(id)
          await handle.dispose()
        }
        this.failures.delete(id)
        this.rearm()
      }
      return { ok: true, deleted }
    } catch {
      return { ok: false, code: 'internal_error', message: 'The scheduled task delete failed.' }
    }
  }

  /**
   * Mark one task read; unknown ids are an idempotent no-op.
   * @param id - Task to mark read.
   * @returns `null` after the durable read mark, when one was written.
   */
  @Remote
  async markRead(id: ScheduledTaskIdType): Promise<null> {
    const record = this.requireTable().get(id)
    if (record !== undefined && record.lastRunAt !== undefined) {
      await this.requireTable().put(id, { ...record, lastReadAt: new Date().toISOString() })
    }
    return null
  }

  private notFound(id: ScheduledTaskIdType): ScheduledTaskMutationResult {
    return { ok: false, code: 'task_not_found', message: `no scheduled task '${id}'.` }
  }

  private asMutationError(error: unknown): ScheduledTaskMutationResult {
    if (error instanceof ScheduledTaskError) return { ok: false, code: error.code, message: error.message }
    return { ok: false, code: 'internal_error', message: 'The scheduled task operation failed.' }
  }

  private requireTable(): KvTable<ScheduledTaskIdType, ScheduledTaskRecord> {
    if (this.table === undefined) throw new Error('scheduled task service is not started yet')
    return this.table
  }

  /** Cancel and re-derive the single timer from the earliest due active task. */
  private rearm(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (this.stopping) return
    const table = this.table
    if (table === undefined) return
    const now = Date.now()
    let earliest: number | undefined
    for (const [, record] of table.entries()) {
      if (record.status !== 'active') continue
      const target = Date.parse(record.rule.scheduledAt)
      if (Number.isFinite(target) && (earliest === undefined || target < earliest)) earliest = target
    }
    if (earliest === undefined) return
    const delay = Math.min(Math.max(earliest - now, 0), MAX_TIMER_DELAY_MS)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.fireDue(Date.now())
    }, delay)
  }

  /** Fire every currently due active task, then re-arm. */
  private async fireDue(now: number): Promise<void> {
    if (this.stopping) return
    const due = [...this.requireTable().entries()].filter(([id, record]) => {
      if (!isDue(record, now)) return false
      // Tasks in failure backoff wait for their retry window even while the
      // stored schedule instant is still in the past.
      return (this.failures.get(id)?.retryAfter ?? 0) <= now
    })
    // Fire independently: one hanging admission must not delay the others.
    await Promise.allSettled(due.map(([id, record]) => this.fireOne(id, record, now)))
    this.rearm()
  }

  /** Queue one task run, advance its durable record, and flush its Session. */
  private async fireOne(id: ScheduledTaskIdType, record: ScheduledTaskRecord, now: number): Promise<void> {
    try {
      const { agent, sessionId } = await this.ensureAgent(record)
      // Pin the conversation title to the task title (re-pins only on change,
      // and retroactively fixes sessions created before this pinning existed).
      this.pinSessionTitle(sessionId, record, agent)
      // List the conversation under the bound workspace project (membership is
      // an explicit per-workspace session list, not derived from cwd).
      await this.attachRunSession(record, sessionId)
      // Apply the stored confirm-before-change policy before the run's first step.
      setApprovalPolicy(agent.session, record.confirmBeforeChange ? 'ask' : 'never')
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: renderTaskFraming(record) }],
        source: { kind: 'plugin', plugin: 'scheduled-task' },
      }))
      const runAt = new Date(now).toISOString()
      const advanced = advanceRule(record.rule, now)
      const next: ScheduledTaskRecord = {
        ...record,
        sessionId,
        rule: advanced ?? record.rule,
        status: advanced === undefined ? 'completed' : record.status,
        lastRunAt: runAt,
        lastError: undefined,
      }
      this.failures.delete(id)
      await this.requireTable().put(id, next)
      await this.ctx.sessions.flush(agent.session)
    } catch (error: unknown) {
      const message = renderThrown(error)
      this.ctx.logger.warn(`scheduled-task: could not fire task "${id}": ${message}`)
      // Record the failure on the task and back off the retry (30s doubling to
      // 5min) so a persistently failing admission does not hot-loop while its
      // schedule instant stays in the past. In-memory only; a restart retries
      // immediately.
      const previous = this.failures.get(id)?.count ?? 0
      const count = previous + 1
      const retryAfter = now + Math.min(30_000 * 2 ** (count - 1), 300_000)
      this.failures.set(id, { count, retryAfter })
      try {
        await this.requireTable().put(id, {
          ...record,
          lastError: { at: new Date(now).toISOString(), message },
        })
      } catch (persistError: unknown) {
        this.ctx.logger.warn(`scheduled-task: could not persist failure of task "${id}": ${renderThrown(persistError)}`)
      }
    }
  }

  /**
   * Attach the run session to the task's bound workspace so the conversation
   * lists under that project instead of "ungrouped" (workspace membership is
   * an explicit durable session list; the entity validates the session header's
   * canonical cwd against the workspace path and attach is idempotent).
   */
  private async attachRunSession(record: ScheduledTaskRecord, sessionId: SessionId): Promise<void> {
    if (record.workspaceId === undefined) return
    const key = `${record.workspaceId}:${sessionId}`
    if (this.attachedSessions.has(key)) return
    const workspace = this.ctx.workspaceRegistry.get(WorkspaceId(record.workspaceId))
    if (workspace === undefined) {
      this.ctx.logger.warn(`scheduled-task: workspace "${record.workspaceId}" not found for task "${record.id}"`)
      return
    }
    try {
      await workspace.attachSession(sessionId)
      this.attachedSessions.add(key)
    } catch (error: unknown) {
      this.ctx.logger.warn(`scheduled-task: could not attach session "${sessionId}" to workspace: ${renderThrown(error)}`)
    }
  }

  /**
   * Pin the session's conversation title to the task title via the
   * session-title service (a `user`-source rename pins against automatic
   * regeneration). Keyed per SESSION so a migrated run session is titled too;
   * re-pins only when the stored title changed since the last applied pin.
   */
  private pinSessionTitle(sessionId: SessionId, record: ScheduledTaskRecord, agent: Agent): void {
    if (this.appliedTitles.get(sessionId) === record.title) return
    const titles: SessionTitleService = this.ctx.sessionTitle
    try {
      titles.rename(agent.session, record.title)
      this.appliedTitles.set(sessionId, record.title)
    } catch (error: unknown) {
      this.ctx.logger.warn(`scheduled-task: could not title session "${sessionId}": ${renderThrown(error)}`)
    }
  }

  /**
   * Resolve the live run Agent for a task's CURRENT project. The durable
   * session identity is derived from the task id + cwd (`runSessionIdOf`), so
   * an edited project transparently starts a fresh conversation inside the new
   * workspace while returning to an earlier project resumes that project's
   * existing history. Returns the possibly-new sessionId for persistence.
   */
  private async ensureAgent(record: ScheduledTaskRecord): Promise<{ agent: Agent; sessionId: SessionId }> {
    const desiredCwd = record.cwd ?? process.cwd()
    const targetId = runSessionIdOf(record.id, desiredCwd)
    const agentOptions = record.model === undefined
      ? undefined
      : { provider: record.model.provider, model: record.model.model }

    // A retained run handle is reused only when it still matches the target.
    const retained = this.handles.get(record.id)
    if (retained !== undefined) {
      if (retained.agent.session.id === targetId && retained.agent.session.header.cwd === desiredCwd) {
        return { agent: retained.agent, sessionId: targetId }
      }
      this.handles.delete(record.id)
      await retained.dispose()
    }

    let handle: AgentHandle
    try {
      handle = await this.ctx.agents.resume({
        resumeSessionId: targetId,
        ...agentOptions === undefined ? {} : { agentOptions },
      })
    } catch {
      // Not persisted yet (first run for this task+project pair): create it in-project.
      handle = await this.ctx.agents.create({
        sessionId: targetId,
        meta: { cwd: desiredCwd },
        ...agentOptions === undefined ? {} : { agentOptions },
      })
    }
    this.handles.set(record.id, handle)
    return { agent: handle.agent, sessionId: targetId }
  }

  /** Cancel the timer and dispose every retained run Agent. */
  private async teardown(): Promise<void> {
    this.stopping = true
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    const handles = [...this.handles.values()]
    this.handles.clear()
    await Promise.allSettled(handles.map(handle => handle.dispose()))
  }
}

export default ScheduledTaskService
