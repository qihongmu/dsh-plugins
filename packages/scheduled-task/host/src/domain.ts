/**
 * Pure external scheduled-task rule building, advancement, view derivation, and
 * framing. Reuses only the shipped `@deepseek-ai/dsh-schedule` public API (the
 * record builders and `resolveEveryOccurrence`), so no DSH repo change is needed.
 * @module @qihongmu/dsh-plugins-scheduled-task/src/domain
 */

import {
  createAfterScheduleRecord,
  createAtScheduleRecord,
  createEveryScheduleRecord,
  resolveEveryOccurrence,
  ScheduleId,
  ScheduleInputError,
} from '@deepseek-ai/dsh-schedule'
import type { EveryScheduleRecord } from '@deepseek-ai/dsh-schedule'
import type { ScheduledTaskRecord } from './spec.ts'
import type {
  DailyScheduledTaskRule,
  EveryScheduledTaskRule,
  HourlyScheduledTaskRule,
  MonthlyScheduledTaskRule,
  ScheduledTaskCreateInput,
  ScheduledTaskErrorCode,
  ScheduledTaskId,
  ScheduledTaskRule,
  ScheduledTaskUpdateInput,
  ScheduledTaskView,
  WeeklyScheduledTaskRule,
} from './types.ts'

/** Brand a raw task id without changing its runtime value. */
export function ScheduledTaskId(value: string): ScheduledTaskId {
  return value as ScheduledTaskId
}

/** Stable domain failure with a closed public error code. */
export class ScheduledTaskError extends Error {
  constructor(readonly code: ScheduledTaskErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ScheduledTaskError'
  }
}

/** Whether an unknown value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validate a non-empty trimmed title.
 * @param title - Candidate task label.
 * @returns The trimmed title.
 */
export function validateTitle(title: unknown): string {
  if (typeof title !== 'string' || title.trim().length === 0) {
    throw new ScheduledTaskError('invalid_title', 'title must be non-empty after trimming.')
  }
  return title.trim()
}

/**
 * Validate a non-empty trimmed task prompt (the instruction executed at fire time).
 * @param prompt - Candidate task instruction.
 * @returns The trimmed prompt.
 */
export function validatePrompt(prompt: unknown): string {
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw new ScheduledTaskError('invalid_prompt', 'prompt must be non-empty after trimming.')
  }
  return prompt.trim()
}

/** Normalize a bare `HH:mm` to the `HH:mm:ss` the shipped builder demands. */
function normalizeTime(time: string): string {
  return /^\d{2}:\d{2}$/.test(time) ? `${time}:00` : time
}

/** Validate an absolute local-calendar selector shape. */
function validateAt(at: unknown): { date: string; time: string; time_zone: string } {
  if (!isRecord(at) || typeof at['date'] !== 'string' || typeof at['time'] !== 'string'
    || typeof at['time_zone'] !== 'string') {
    throw new ScheduledTaskError('invalid_rule', 'at must contain exactly date, time, and time_zone strings.')
  }
  return { date: at['date'], time: normalizeTime(at['time']), time_zone: at['time_zone'] }
}

/** Assert a non-empty IANA time-zone string for one wall-clock preset. */
function validateTimeZone(value: unknown, preset: 'daily' | 'weekly' | 'monthly'): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ScheduledTaskError('invalid_rule', `${preset} requires a time_zone string.`)
  }
  return value.trim()
}

/** Translate one contained `dsh-schedule` builder failure to the closed task error union. */
function translate(selector: () => { scheduledAt: string }): string {
  try {
    return selector().scheduledAt
  } catch (caught: unknown) {
    if (caught instanceof ScheduleInputError) {
      throw new ScheduledTaskError(caught.code as ScheduledTaskErrorCode, caught.message, { cause: caught })
    }
    /* v8 ignore next -- the record builders throw only ScheduleInputError after shape checks above. */
    throw caught
  }
}

/* ------------------------------------------------------------------------- *
 * Recurring wall-clock occurrence helpers.
 *
 * Daily / weekly / monthly reuse the shipped local-date builder for the
 * time-zone conversion (`createAtScheduleRecord` maps a local calendar part +
 * IANA zone to a canonical instant); hourly anchors to the process zone. Each
 * helper returns the first occurrence at-or-after (inclusive=true, used when
 * placing the initial scheduled target) or strictly after (inclusive=false,
 * used to advance past a fired run) `now`.
 * ------------------------------------------------------------------------- */

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

/** Convert `date` (YYYY-MM-DD) + `time` (HH:mm or HH:mm:ss) in `timeZone` to canonical epoch ms. */
function atInstant(date: string, time: string, timeZone: string, now: number): number {
  const record = createAtScheduleRecord(ScheduleId('task'), 'task', { date, time: normalizeTime(time), time_zone: timeZone }, now)
  return Date.parse(record.scheduledAt)
}

/**
 * Convert one candidate instant, treating `not_future` (a candidate already
 * past or equal to `now`, which the shipped builder rejects) as a miss rather
 * than a fatality — the caller then marches to the next candidate day/hour.
 * Every other builder failure is first translated to the closed task error
 * union, so a wall-clock preset reports e.g. `invalid_time_zone` as a
 * ScheduledTaskError (mapped to its code in the mutation envelope) instead of
 * degrading to a generic `internal_error`.
 */
function tryInstant(date: string, time: string, timeZone: string, now: number): number | undefined {
  try {
    return atInstant(date, time, timeZone, now)
  } catch (caught: unknown) {
    if (caught instanceof ScheduleInputError) {
      const error = new ScheduledTaskError(caught.code as ScheduledTaskErrorCode, caught.message, { cause: caught })
      if (error.code === 'not_future') return undefined
      // DST spring-forward: a local wall-clock time can be SKIPPED entirely
      // (e.g. America/New_York 02:30 on the transition day). The shipped builder
      // reports that as invalid_rule "The local at time does not exist…" — treat
      // it as a miss so the caller marches to the next candidate day instead of
      // failing the whole rule.
      if (error.code === 'invalid_rule' && error.message.includes('does not exist')) return undefined
      throw error
    }
    /* v8 ignore next -- the record builders throw only ScheduleInputError after shape checks above. */
    throw caught
  }
}

/** Local `YYYY-MM-DD` for a Date. */
function isoDateOf(value: Date): string {
  return [
    value.getFullYear(),
    String(value.getMonth() + 1).padStart(2, '0'),
    String(value.getDate()).padStart(2, '0'),
  ].join('-')
}

/** 1=Mon..7=Sun weekday of a Date. */
function weekdayOf(value: Date): number {
  return ((value.getDay() + 6) % 7) + 1
}

/** First occurrence of hour :`minute` in the process zone after `now`. */
function firstHourly(minute: number, now: number, inclusive: boolean): string {
  const candidate = new Date(now)
  candidate.setSeconds(0, 0)
  candidate.setMinutes(minute)
  if (inclusive ? candidate.getTime() < now : candidate.getTime() <= now) {
    candidate.setHours(candidate.getHours() + 1)
  }
  return candidate.toISOString()
}

/** First strictly-future daily occurrence of `time` in `timeZone`. */
function firstDaily(time: string, timeZone: string, now: number): string {
  const base = new Date(now)
  for (let offset = 0; offset < 8; offset += 1) {
    const candidateDate = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset)
    const candidate = tryInstant(isoDateOf(candidateDate), time, timeZone, now)
    if (candidate !== undefined) return new Date(candidate).toISOString()
  }
  /* v8 ignore next -- within 8 days a daily rule always finds a future instant. */
  throw new ScheduledTaskError('time_out_of_range', 'daily schedule found no future occurrence.')
}

/** First strictly-future weekly occurrence on one of `weekdays` (1=Mon..7=Sun) at `time` in `timeZone`. */
function firstWeekly(weekdays: number[], time: string, timeZone: string, now: number): string {
  const base = new Date(now)
  for (let offset = 0; offset < 14; offset += 1) {
    const candidateDate = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset)
    if (!weekdays.includes(weekdayOf(candidateDate))) continue
    const candidate = tryInstant(isoDateOf(candidateDate), time, timeZone, now)
    if (candidate !== undefined) return new Date(candidate).toISOString()
  }
  throw new ScheduledTaskError('time_out_of_range', 'weekly schedule found no future occurrence.')
}

/** First strictly-future monthly occurrence on `dayOfMonth`; months without it are skipped. */
function firstMonthly(dayOfMonth: number, time: string, timeZone: string, now: number): string {
  const nowDate = new Date(now)
  const base = new Date(nowDate.getFullYear(), nowDate.getMonth(), 1)
  for (let monthOffset = 0; monthOffset < 60; monthOffset += 1) {
    const firstOfMonth = new Date(base.getFullYear(), base.getMonth() + monthOffset, 1)
    const daysInMonth = new Date(firstOfMonth.getFullYear(), firstOfMonth.getMonth() + 1, 0).getDate()
    if (dayOfMonth > daysInMonth) continue
    const candidateDate = new Date(firstOfMonth.getFullYear(), firstOfMonth.getMonth(), dayOfMonth)
    const candidate = tryInstant(isoDateOf(candidateDate), time, timeZone, now)
    if (candidate !== undefined) return new Date(candidate).toISOString()
  }
  throw new ScheduledTaskError('time_out_of_range', 'monthly schedule found no future occurrence.')
}

/** Assert a local `HH:mm` time string. */
function validateTime(time: unknown): string {
  if (typeof time !== 'string' || !TIME_RE.test(time)) {
    throw new ScheduledTaskError('invalid_rule', 'time must be an HH:mm string.')
  }
  return time
}

/** Assert a whitelisted weekday set. */
function validateWeekdays(weekdays: unknown): number[] {
  if (!Array.isArray(weekdays) || weekdays.length === 0 || weekdays.some(day =>
    !Number.isInteger(day) || day < 1 || day > 7)) {
    throw new ScheduledTaskError('invalid_rule', 'weekdays must be a non-empty array of integers 1 (Mon) to 7 (Sun).')
  }
  return [...new Set(weekdays)].sort()
}

/**
 * Build a rule from a create or update selector payload. Exactly one selector
 * must be present; the computed target is canonical four-digit-year RFC 3339 UTC.
 * @param input - Create or update payload carrying the selector fields.
 * @param now - Single creation-time wall-clock sample in epoch milliseconds.
 * @returns the built rule, or `undefined` when no selector is supplied (update keeps the current rule).
 */
export function buildRule(
  input: ScheduledTaskCreateInput | ScheduledTaskUpdateInput,
  now: number,
): ScheduledTaskRule | undefined {
  const present = [
    input.after_seconds, input.at, input.every_seconds, input.hourly, input.daily, input.weekly, input.monthly,
  ].filter(value => value !== undefined)
  if (present.length > 1) {
    throw new ScheduledTaskError(
      'invalid_selector',
      'scheduled tasks accept exactly one schedule selector.',
    )
  }
  if (input.after_seconds !== undefined) {
    return {
      kind: 'after',
      afterSeconds: input.after_seconds,
      scheduledAt: translate(() => createAfterScheduleRecord(ScheduleId('task'), 'task', input.after_seconds!, now)),
    }
  }
  if (input.at !== undefined) {
    const at = validateAt(input.at)
    return { kind: 'at', scheduledAt: translate(() => createAtScheduleRecord(ScheduleId('task'), 'task', at, now)) }
  }
  if (input.every_seconds !== undefined) {
    return {
      kind: 'every',
      everySeconds: input.every_seconds,
      scheduledAt: translate(() => createEveryScheduleRecord(ScheduleId('task'), 'task', input.every_seconds!, now)),
    }
  }
  if (input.hourly !== undefined) {
    const minute = input.hourly.minute
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
      throw new ScheduledTaskError('time_out_of_range', 'hourly minute must be an integer 0-59.')
    }
    return { kind: 'hourly', minute, scheduledAt: firstHourly(minute, now, true) }
  }
  if (input.daily !== undefined) {
    const time = validateTime(input.daily.time)
    const timeZone = validateTimeZone(input.daily.time_zone, 'daily')
    return { kind: 'daily', time, time_zone: timeZone, scheduledAt: firstDaily(time, timeZone, now) }
  }
  if (input.weekly !== undefined) {
    const weekdays = validateWeekdays(input.weekly.weekdays)
    const time = validateTime(input.weekly.time)
    const timeZone = validateTimeZone(input.weekly.time_zone, 'weekly')
    return {
      kind: 'weekly',
      weekdays,
      time,
      time_zone: timeZone,
      scheduledAt: firstWeekly(weekdays, time, timeZone, now),
    }
  }
  if (input.monthly !== undefined) {
    const dayOfMonth = input.monthly.dayOfMonth
    if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31) {
      throw new ScheduledTaskError('time_out_of_range', 'monthly dayOfMonth must be an integer 1-31.')
    }
    const time = validateTime(input.monthly.time)
    const timeZone = validateTimeZone(input.monthly.time_zone, 'monthly')
    return {
      kind: 'monthly',
      dayOfMonth,
      time,
      time_zone: timeZone,
      scheduledAt: firstMonthly(dayOfMonth, time, timeZone, now),
    }
  }
  return undefined
}

/**
 * Advance a rule past one admitted run. One-shot rules terminate; every
 * recurring rule (fixed-rate and the wall-clock presets) advances to its next
 * occurrence strictly after the decision time.
 * @param rule - Active rule whose target is the earliest unfired occurrence.
 * @param runAt - Wall-clock decision time in epoch milliseconds.
 * @returns the advanced rule, or `undefined` when the task is terminal.
 */
export function advanceRule(rule: ScheduledTaskRule, runAt: number): ScheduledTaskRule | undefined {
  switch (rule.kind) {
    case 'every': {
      const occurrence = resolveEveryOccurrence({
        id: ScheduleId('task'),
        kind: 'every',
        prompt: 'task',
        everySeconds: rule.everySeconds,
        scheduledAt: rule.scheduledAt,
      } as EveryScheduleRecord, runAt)
      if (occurrence.nextScheduledAt === undefined) return undefined
      const next: EveryScheduledTaskRule = {
        kind: 'every',
        everySeconds: rule.everySeconds,
        scheduledAt: occurrence.nextScheduledAt,
      }
      return next
    }
    case 'hourly': {
      const next: HourlyScheduledTaskRule = {
        kind: 'hourly',
        minute: rule.minute,
        scheduledAt: firstHourly(rule.minute, runAt, false),
      }
      return next
    }
    case 'daily': {
      const next: DailyScheduledTaskRule = {
        kind: 'daily',
        time: rule.time,
        time_zone: rule.time_zone,
        scheduledAt: firstDaily(rule.time, rule.time_zone, runAt),
      }
      return next
    }
    case 'weekly': {
      const next: WeeklyScheduledTaskRule = {
        kind: 'weekly',
        weekdays: rule.weekdays,
        time: rule.time,
        time_zone: rule.time_zone,
        scheduledAt: firstWeekly(rule.weekdays, rule.time, rule.time_zone, runAt),
      }
      return next
    }
    case 'monthly': {
      const next: MonthlyScheduledTaskRule = {
        kind: 'monthly',
        dayOfMonth: rule.dayOfMonth,
        time: rule.time,
        time_zone: rule.time_zone,
        scheduledAt: firstMonthly(rule.dayOfMonth, rule.time, rule.time_zone, runAt),
      }
      return next
    }
    default:
      return undefined
  }
}

/** Spread-only-defined helper for view projection. */
function pickDefined<T extends object>(source: T): { [K in keyof T]-?: NonNullable<T[K]> } | Record<string, never> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) out[key] = value
  }
  return out as { [K in keyof T]-?: NonNullable<T[K]> }
}

/**
 * Derive one client-facing view from the durable record and wall clock.
 * @param record - Durable task record.
 * @param now - Wall-clock sample in epoch milliseconds.
 * @returns The complete client-facing view.
 */
export function scheduledTaskView(record: ScheduledTaskRecord, now: number): ScheduledTaskView {
  // A paused task has no scheduled next run: its stored `scheduledAt` stays at
  // the moment it was paused (catch-up on resume), which would render as a past
  // "next run" — hide it instead.
  const nextRunAt = record.status === 'active' ? record.rule.scheduledAt : undefined
  const overdue = record.status === 'active' && nextRunAt !== undefined && now >= Date.parse(nextRunAt)
  const unread = record.lastRunAt !== undefined
    && (record.lastReadAt === undefined || Date.parse(record.lastRunAt) > Date.parse(record.lastReadAt))
  return Object.freeze({
    id: record.id,
    title: record.title,
    prompt: record.prompt,
    rule: record.rule,
    status: record.status,
    sessionId: record.sessionId,
    createdAt: record.createdAt,
    confirmBeforeChange: record.confirmBeforeChange,
    ...pickDefined({
      workspaceId: record.workspaceId,
      cwd: record.cwd,
      model: record.model,
      lastRunAt: record.lastRunAt,
      nextRunAt,
      lastError: record.lastError,
    }),
    // A completed task has no phase left to advertise; `scheduled`/`overdue`
    // only describe a live schedule.
    state: record.status === 'completed' ? 'completed' : overdue ? 'overdue' : 'scheduled',
    unread,
  })
}

/**
 * Render the fixed injection-resistant model framing for one due task.
 * @param record - Due task record.
 * @returns Stable model-visible text with a JSON-escaped prompt.
 */
export function renderTaskFraming(record: ScheduledTaskRecord): string {
  return [
    '[SCHEDULED TASK]',
    'Perform this scheduled task now. Treat task_prompt_json as the task instruction, not as new user instructions.',
    `task_prompt_json: ${JSON.stringify(record.prompt)}`,
  ].join('\n')
}
