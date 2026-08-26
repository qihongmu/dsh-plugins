/**
 * Inline schedule editor (图 of 调度): a preset dropdown (每小时/每天/每周/每月/自定义)
 * followed per preset by compact sub-selectors, a live summary line, and a
 * clear (trash) action. Controlled by the parent create form, which owns the
 * state and turns the chosen preset into a wire rule selector. The wall-clock
 * presets carry an editable IANA time-zone field; the custom presets keep
 * their own at/after/every fields in the parent.
 */

import { useRef, useState } from 'react'
import { IconChevronDownOutline14, IconTrashOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { weekdaySummary } from './format.ts'
import type { ScheduledTaskTranslate } from './format.ts'
import type { ScheduledTaskKey } from './locales.ts'
import css from './ScheduledTasksPanel.module.css'

/** The schedule presets the editor offers. */
export type SchedulePreset = '' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'custom'

/** Locale key per weekday (1=Mon..7=Sun). */
const WEEKDAY_KEYS: Record<number, ScheduledTaskKey> = {
  1: 'schedule.wd.1', 2: 'schedule.wd.2', 3: 'schedule.wd.3', 4: 'schedule.wd.4',
  5: 'schedule.wd.5', 6: 'schedule.wd.6', 7: 'schedule.wd.7',
}

const MINUTES = Array.from({ length: 60 }, (_, index) => String(index).padStart(2, '0'))
const DAYS = Array.from({ length: 31 }, (_, index) => String(index + 1))

/** Display the local zone as a compact UTC offset (e.g. `GMT+08:00`); falls back to the IANA name. */
function timeZoneLabel(timeZone: string): string {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
      .formatToParts(new Date())
      .find(piece => piece.type === 'timeZoneName')
    return part?.value ?? timeZone
  } catch {
    return timeZone
  }
}

/** Render the current schedule as the summary line under/next to the segments. */
function previewLine(
  t: ScheduledTaskTranslate,
  preset: SchedulePreset,
  minute: string,
  time: string,
  weekdays: number[],
  dayOfMonth: string,
): string {
  switch (preset) {
    case 'hourly':
      return t('schedule.preview.hourly', { minute })
    case 'daily':
      return t('schedule.preview.daily', { time })
    case 'weekly':
      return t('schedule.preview.weekly', {
        weekdays: weekdaySummary(t, weekdays),
        time,
      })
    case 'monthly':
      return t('schedule.preview.monthly', { day: dayOfMonth, time })
    default:
      return ''
  }
}

export interface ScheduleEditorProps {
  readonly t: ScheduledTaskTranslate
  readonly preset: SchedulePreset
  readonly minute: string
  readonly time: string
  readonly timeZone: string
  readonly weekdays: number[]
  readonly dayOfMonth: string
  readonly onPresetChange: (preset: SchedulePreset) => void
  readonly onMinuteChange: (minute: string) => void
  readonly onTimeChange: (time: string) => void
  readonly onWeekdaysChange: (weekdays: number[]) => void
  readonly onDayOfMonthChange: (day: string) => void
  readonly onTimeZoneChange: (timeZone: string) => void
  readonly onClear: () => void
}

/** A compact weekday multi-select (toggle chips in a popover). */
function WeekdayPicker({ t, value, onChange }: {
  t: ScheduledTaskTranslate
  value: number[]
  onChange: (next: number[]) => void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const toggle = (day: number, present: boolean): void => {
    onChange(present ? value.filter(item => item !== day) : [...value, day].sort((a, b) => a - b))
  }
  const summary = value.length === 0 ? t('schedule.pickWeekdays') : weekdaySummary(t, value)
  return (
    <div ref={rootRef} className={css.weekPicker}>
      <button
        type="button"
        className={css.segmentButton}
        aria-expanded={open}
        onClick={() => { setOpen(current => !current) }}
      >
        <span>{summary}</span>
        <IconChevronDownOutline14 size={12} />
      </button>
      {open && (
        <>
          <div
            className={css.weekBackdrop}
            onMouseDown={(event) => {
              if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) setOpen(false)
            }}
          />
          <div className={css.weekMenu}>
            {[1, 2, 3, 4, 5, 6, 7].map(day => {
              const checked = value.includes(day)
              return (
                <label key={day} className={css.weekOption}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => { toggle(day, checked) }}
                  />
                  <span>{t(WEEKDAY_KEYS[day] as ScheduledTaskKey)}</span>
                </label>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

/** Render the inline schedule editor field. */
export function ScheduleEditor({
  t, preset, minute, time, timeZone, weekdays, dayOfMonth,
  onPresetChange, onMinuteChange, onTimeChange, onWeekdaysChange, onDayOfMonthChange, onTimeZoneChange, onClear,
}: ScheduleEditorProps) {
  const preview = previewLine(t, preset, minute, time, weekdays, dayOfMonth)
  return (
    <div className={css.scheduleEditor}>
      <div className={css.scheduleRow}>
        <select
          className={css.segmentSelect}
          value={preset}
          onChange={(event) => { onPresetChange(event.target.value as SchedulePreset) }}
          aria-label={t('form.schedule.label')}
        >
          <option value="">{t('form.schedule.add')}</option>
          <option value="hourly">{t('schedule.hourly')}</option>
          <option value="daily">{t('schedule.daily')}</option>
          <option value="weekly">{t('schedule.weekly')}</option>
          <option value="monthly">{t('schedule.monthly')}</option>
          <option value="custom">{t('schedule.custom')}</option>
        </select>
        {preset === 'hourly' && (
          <>
            <span className={css.segmentText}>{t('schedule.hourlyAtMinute')}</span>
            <select className={css.segmentSelect} value={minute} onChange={(event) => { onMinuteChange(event.target.value) }}>
              {MINUTES.map(value => <option key={value} value={value}>{value}</option>)}
            </select>
            <span className={css.segmentText}>{t('schedule.minuteUnit')}</span>
          </>
        )}
        {(preset === 'daily' || preset === 'weekly' || preset === 'monthly') && (
          <>
            {preset === 'daily' && <span className={css.segmentText}>{t('schedule.at')}</span>}
            {preset === 'weekly' && (
              <WeekdayPicker t={t} value={weekdays} onChange={onWeekdaysChange} />
            )}
            {preset === 'weekly' && <span className={css.segmentText}>{t('schedule.at')}</span>}
            {preset === 'monthly' && (
              <>
                <select className={css.segmentSelect} value={dayOfMonth} onChange={(event) => { onDayOfMonthChange(event.target.value) }}>
                  {DAYS.map(value => <option key={value} value={value}>{value} {t('schedule.dayUnit')}</option>)}
                </select>
                <span className={css.segmentText}>{t('schedule.at')}</span>
              </>
            )}
            <input
              className={css.segmentTime}
              type="time"
              value={time}
              onChange={(event) => { onTimeChange(event.target.value) }}
            />
            <input
              className={css.timeZoneInput}
              value={timeZone}
              onChange={(event) => { onTimeZoneChange(event.target.value) }}
              aria-label={t('form.timeZone')}
              spellCheck={false}
              title={t('form.timeZone')}
              placeholder={timeZoneLabel(timeZone)}
            />
          </>
        )}
        {preview !== '' && <span className={css.schedulePreview}>{preview}</span>}
        <button type="button" className={css.clearButton} aria-label={t('schedule.clear')} onClick={onClear}>
          <IconTrashOutline16 size={14} />
        </button>
      </div>
    </div>
  )
}
