/** Shared formatting helpers for the scheduled-tasks UI. */

import type { ScheduledTaskRule } from '@deepseek-ai/dsh-plugins-scheduled-task/types'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ScheduledTaskKey } from './locales.ts'

/** The namespace-bound translate seat shared by the panel's views. */
export type ScheduledTaskTranslate = TranslateNS<'scheduled-tasks'>

/** Format a wire ISO timestamp in the browser's default zone. */
export function localizedDate(value: string | undefined): string {
  if (value === undefined) return ''
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

/** Humanize a whole-second duration through the duration dictionary keys. */
export function humanizeDuration(t: ScheduledTaskTranslate, seconds: number): string {
  if (seconds % 86_400 === 0) return t('duration.days', { count: seconds / 86_400 })
  if (seconds % 3_600 === 0) return t('duration.hours', { count: seconds / 3_600 })
  if (seconds % 60 === 0) return t('duration.minutes', { count: seconds / 60 })
  return t('duration.seconds', { count: seconds })
}

/** Localize one schedule rule into a one-line summary (list rows, previews). */
export function ruleSummary(rule: ScheduledTaskRule, t: ScheduledTaskTranslate): string {
  switch (rule.kind) {
    case 'every':
      return t('row.schedule.every', { duration: humanizeDuration(t, rule.everySeconds) })
    case 'after':
      return t('row.schedule.after', { duration: humanizeDuration(t, rule.afterSeconds) })
    case 'at':
      return t('row.schedule.at', { time: localizedDate(rule.scheduledAt) })
    case 'hourly':
      return t('row.schedule.hourly', { minute: String(rule.minute).padStart(2, '0') })
    case 'daily':
      return t('row.schedule.daily', { time: rule.time })
    case 'weekly':
      return t('row.schedule.weekly', {
        weekdays: rule.weekdays.map(day => t(`schedule.wd.${day}` as ScheduledTaskKey)).join('、'),
        time: rule.time,
      })
    case 'monthly':
      return t('row.schedule.monthly', { day: String(rule.dayOfMonth), time: rule.time })
  }
}
