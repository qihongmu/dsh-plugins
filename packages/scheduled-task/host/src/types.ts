/**
 * Wire-facing global scheduled-task value types (client-safe; no DSH repo edits).
 * @module @deepseek-ai/dsh-plugins-scheduled-task
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Stable task identity that is unique and never reused. */
export type ScheduledTaskId = Branded<'ScheduledTaskId'>

/** Lifecycle a task can occupy; `completed` is terminal and set only after a one-shot fires. */
export type ScheduledTaskStatus = 'active' | 'paused' | 'completed'

/** Selector statuses the browser may set directly; `completed` is scheduler-derived. */
export type ScheduledTaskSettableStatus = 'active' | 'paused'

/** One-shot delayed rule: fire once `afterSeconds` after creation. */
export interface AfterScheduledTaskRule {
  kind: 'after'
  afterSeconds: number
  scheduledAt: string
}

/** One-shot absolute rule: fire at one exact instant. */
export interface AtScheduledTaskRule {
  kind: 'at'
  scheduledAt: string
}

/** Fixed-rate rule: fire every `everySeconds`, creation-anchored. */
export interface EveryScheduledTaskRule {
  kind: 'every'
  everySeconds: number
  scheduledAt: string
}

/**
 * Recurring wall-clock rules: each carries its next absolute `scheduledAt` (the
 * earliest un-fired occurrence past its anchor) plus the params needed to
 * advance to the following occurrence in the local time zone.
 */

/** Hourly rule: fire at `minute` (0-59) past each hour, in the process zone. */
export interface HourlyScheduledTaskRule {
  kind: 'hourly'
  minute: number
  scheduledAt: string
}

/** Daily rule: fire each day at `time` (HH:mm) in `time_zone`. */
export interface DailyScheduledTaskRule {
  kind: 'daily'
  time: string
  time_zone: string
  scheduledAt: string
}

/** Weekly rule: fire on each selected weekday (1=Mon..7=Sun) at `time` in `time_zone`. */
export interface WeeklyScheduledTaskRule {
  kind: 'weekly'
  weekdays: number[]
  time: string
  time_zone: string
  scheduledAt: string
}

/** Monthly rule: fire on `dayOfMonth` (1-31) at `time` in `time_zone`; months without the day are skipped. */
export interface MonthlyScheduledTaskRule {
  kind: 'monthly'
  dayOfMonth: number
  time: string
  time_zone: string
  scheduledAt: string
}

/** The scheduled-task rule union. */
export type ScheduledTaskRule =
  | AfterScheduledTaskRule
  | AtScheduledTaskRule
  | EveryScheduledTaskRule
  | HourlyScheduledTaskRule
  | DailyScheduledTaskRule
  | WeeklyScheduledTaskRule
  | MonthlyScheduledTaskRule

/** Structured local-calendar absolute input accepted by `at`. */
export interface ScheduledTaskAtInput {
  date: string
  time: string
  time_zone: string
}

/** Hourly selector: fire each hour at `minute` (0-59) past the hour. */
export interface ScheduledTaskHourlyInput {
  minute: number
}

/** Daily selector: fire each day at `time` (HH:mm) in `time_zone`. */
export interface ScheduledTaskDailyInput {
  time: string
  time_zone: string
}

/** Weekly selector: fire on each weekday (1=Mon..7=Sun) at `time` in `time_zone`. */
export interface ScheduledTaskWeeklyInput {
  weekdays: number[]
  time: string
  time_zone: string
}

/** Monthly selector: fire on `dayOfMonth` (1-31) at `time` in `time_zone`. */
export interface ScheduledTaskMonthlyInput {
  dayOfMonth: number
  time: string
  time_zone: string
}

/** Provider/model pair a scheduled task runs with (applied as the agent's options at fire time). */
export interface ScheduledTaskModel {
  provider: string
  model: string
}

/** Common create/update carry fields (not part of the schedule selector). */
export interface ScheduledTaskCarryFields {
  /** The task instruction (the Prompt executed at fire time). */
  prompt?: string
  /** Optional project workspace id the task runs in (drives the run directory). */
  workspaceId?: string
  /** Canonical project path used as the run session `cwd`. */
  cwd?: string
  /** Provider/model the task runs with; absent keeps the deployment default. */
  model?: ScheduledTaskModel
  /** Whether to ask the user before the run makes changes (approval policy `ask`). */
  confirmBeforeChange?: boolean
}

/** One schedule selector, exactly one of which is required on create. */
export interface ScheduledTaskScheduleSelectorFields {
  after_seconds?: number
  at?: ScheduledTaskAtInput
  every_seconds?: number
  hourly?: ScheduledTaskHourlyInput
  daily?: ScheduledTaskDailyInput
  weekly?: ScheduledTaskWeeklyInput
  monthly?: ScheduledTaskMonthlyInput
}

/** Create input: a non-empty title, a non-empty prompt, and exactly one schedule selector. */
export interface ScheduledTaskCreateInput extends ScheduledTaskCarryFields, ScheduledTaskScheduleSelectorFields {
  title: string
  prompt: string
}

/** Update input: any supplied field replaces the stored one; an absent selector keeps the current rule. */
export interface ScheduledTaskUpdateInput extends ScheduledTaskCarryFields, ScheduledTaskScheduleSelectorFields {
  title?: string
}

/** Timing state derived from the durable rule and wall clock. */
/** Coarse display phase derived from status + wall clock. */
export type ScheduledTaskState = 'scheduled' | 'overdue' | 'completed'

/** Complete client-facing view of one task. */
export interface ScheduledTaskView {
  id: ScheduledTaskId
  title: string
  prompt: string
  rule: ScheduledTaskRule
  status: ScheduledTaskStatus
  sessionId: SessionId
  createdAt: string
  workspaceId?: string
  cwd?: string
  model?: ScheduledTaskModel
  confirmBeforeChange: boolean
  lastRunAt?: string
  nextRunAt?: string
  state: ScheduledTaskState
  unread: boolean
  /** Failure of the most recent run-admission attempt, if it did not succeed. */
  lastError?: ScheduledTaskRunError
}

/** One failed run admission (session creation/queueing), kept for surfacing. */
export interface ScheduledTaskRunError {
  /** ISO-8601 instant of the failure. */
  at: string
  /** Rendered failure message (process-side diagnostics wording). */
  message: string
}

/** Closed v1 management error codes. */
export type ScheduledTaskErrorCode =
  | 'invalid_title'
  | 'invalid_prompt'
  | 'invalid_selector'
  | 'invalid_rule'
  | 'invalid_time_zone'
  | 'not_future'
  | 'time_out_of_range'
  | 'frequency_too_high'
  | 'task_not_found'
  | 'internal_error'

/** Successful or failed create/update/status mutation. */
export type ScheduledTaskMutationResult =
  | { ok: true; task: ScheduledTaskView }
  | { ok: false; code: ScheduledTaskErrorCode; message: string }

/** Successful or failed delete. */
export type ScheduledTaskDeleteResult =
  | { ok: true; deleted: boolean }
  | { ok: false; code: ScheduledTaskErrorCode; message: string }
