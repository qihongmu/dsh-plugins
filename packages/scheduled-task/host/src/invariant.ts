/**
 * Package-owned invariant companion for the external scheduled-task plugin.
 * @module @deepseek-ai/dsh-plugins-scheduled-task/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'
import type { ScheduledTaskRecord } from './spec.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-plugins-scheduled-task'

/** Cordis invariant-companion plugin name. */
export const name = 'scheduled-task-invariant'
/** Service required before reserving this package's invariant ownership. */
export const inject = ['invariants']

/**
 * Owned relationship: a task enters `completed` only after its run recorded
 * `lastRunAt`. The service sets both in one durable put, so a completed record
 * without a run timestamp proves a write path bypassed the scheduler.
 */
const install: InvariantInstaller = Object.assign(
  (ctx: Context, fail: (message: string) => never) => {
    ctx.on('domain/changed', (change: DomainChanged) => {
      if (change.domain !== 'scheduled_task' || change.table !== 'tasks' || change.operation !== 'put') return
      const record = change.value as ScheduledTaskRecord
      if (record.status === 'completed' && record.lastRunAt === undefined) {
        fail(`scheduled task '${String(record.id)}' entered completed without lastRunAt`)
      }
    })
  },
  { inject: [] },
)

/**
 * Register the package-owned invariant companion.
 * @param ctx - Cordis context carrying the invariant registry.
 * @returns Exact registration disposer after child setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
