/**
 * The external scheduled-task domain declaration: record schema and the
 * `defineDomain` spec the service opens (mirrors the storage-domain pattern).
 * @module @deepseek-ai/dsh-plugins-scheduled-task/src/spec
 */

import { z } from 'zod'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { ScheduledTaskId } from './types.ts'

/** Task id schema at the durable boundary; branding has no runtime representation. */
const scheduledTaskId = z.string().transform(value => value as ScheduledTaskId)

/** Session id schema; branding has no runtime representation. */
const sessionId = z.string().transform(SessionId)

const afterRule = z.object({
  kind: z.literal('after'),
  afterSeconds: z.number().int().positive(),
  scheduledAt: z.string(),
})
const atRule = z.object({
  kind: z.literal('at'),
  scheduledAt: z.string(),
})
const everyRule = z.object({
  kind: z.literal('every'),
  everySeconds: z.number().int().min(300),
  scheduledAt: z.string(),
})
const hourlyRule = z.object({
  kind: z.literal('hourly'),
  minute: z.number().int().min(0).max(59),
  scheduledAt: z.string(),
})
const dailyRule = z.object({
  kind: z.literal('daily'),
  time: z.string(),
  time_zone: z.string(),
  scheduledAt: z.string(),
})
const weeklyRule = z.object({
  kind: z.literal('weekly'),
  weekdays: z.array(z.number().int().min(1).max(7)).min(1),
  time: z.string(),
  time_zone: z.string(),
  scheduledAt: z.string(),
})
const monthlyRule = z.object({
  kind: z.literal('monthly'),
  dayOfMonth: z.number().int().min(1).max(31),
  time: z.string(),
  time_zone: z.string(),
  scheduledAt: z.string(),
})
const rule = z.discriminatedUnion('kind', [
  afterRule, atRule, everyRule, hourlyRule, dailyRule, weeklyRule, monthlyRule,
])

/** Provider/model pair stored on a task. */
const model = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
})

/**
 * Durable shape of one task record. `title`/`prompt` are non-empty after
 * trimming; `rule` carries the schedule and next target; timestamps are ISO-8601.
 */
export const scheduledTaskRecord = z.object({
  id: scheduledTaskId,
  title: z.string().min(1),
  prompt: z.string().min(1),
  rule,
  status: z.enum(['active', 'paused', 'completed']),
  sessionId,
  createdAt: z.string(),
  workspaceId: z.string().optional(),
  cwd: z.string().optional(),
  model: model.optional(),
  confirmBeforeChange: z.boolean(),
  lastRunAt: z.string().optional(),
  lastReadAt: z.string().optional(),
  /** Failure of the most recent run-admission attempt, if it did not succeed. */
  lastError: z.object({
    at: z.string(),
    message: z.string().min(1),
  }).optional(),
})

/** One stored task record, inferred from {@link scheduledTaskRecord}. */
export type ScheduledTaskRecord = z.infer<typeof scheduledTaskRecord>

/** The scheduled-task domain spec: one `tasks` table keyed by task id. */
export const scheduledTaskDomainSpec = defineDomain({
  name: 'scheduled_task',
  version: 1,
  tables: { tasks: domainTable<ScheduledTaskId, ScheduledTaskRecord>(scheduledTaskRecord) },
})
