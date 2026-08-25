/**
 * 新建定时任务 create/edit view (the drawer body): the inline schedule editor
 * (每小时/每天/每周/每月/自定义), title, the instruction Prompt, project (DSH
 * workspace), confirm-before-change toggle, and model selection.
 */

import { useEffect, useState } from 'react'
import type {
  ScheduledTaskCreateInput, ScheduledTaskView,
} from '@deepseek-ai/dsh-plugins-scheduled-task/types'
import { ScheduleEditor } from './ScheduleEditor.tsx'
import type { SchedulePreset } from './ScheduleEditor.tsx'
import type {
  ScheduledTaskModelOption, ScheduledTaskProjectOption,
} from './slots.ts'
import type { ScheduledTaskTranslate } from './format.ts'
import css from './ScheduledTasksPanel.module.css'

/** The raw selector behind 自定义. */
type CustomKind = 'at' | 'after' | 'every'

/** The schedule-selector subset of the create input (title/prompt/carry handled separately). */
type ScheduleSelector = Pick<
  ScheduledTaskCreateInput,
  'hourly' | 'daily' | 'weekly' | 'monthly' | 'at' | 'after_seconds' | 'every_seconds'
>

/** Schedule editor state resolved from a stored rule (edit prefill) or defaults. */
interface ScheduleState {
  preset: SchedulePreset
  customKind: CustomKind
  minute: string
  time: string
  timeZone: string
  weekdays: number[]
  dayOfMonth: string
}

/** Local zone used as the default for daily/weekly/monthly. */
function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

/** Resolve the editor state from an edit task (or create defaults). */
function initialSchedule(task: ScheduledTaskView | undefined): ScheduleState {
  const tz = localTimeZone()
  if (task === undefined) {
    return { preset: '', customKind: 'at', minute: '00', time: '09:00', timeZone: tz, weekdays: [1, 2, 3, 4, 5], dayOfMonth: '1' }
  }
  const rule = task.rule
  switch (rule.kind) {
    case 'hourly':
      return { preset: 'hourly', customKind: 'at', minute: String(rule.minute).padStart(2, '0'), time: '09:00', timeZone: tz, weekdays: [1, 2, 3, 4, 5], dayOfMonth: '1' }
    case 'daily':
      return { preset: 'daily', customKind: 'at', minute: '00', time: rule.time, timeZone: rule.time_zone, weekdays: [1, 2, 3, 4, 5], dayOfMonth: '1' }
    case 'weekly':
      return { preset: 'weekly', customKind: 'at', minute: '00', time: rule.time, timeZone: rule.time_zone, weekdays: rule.weekdays, dayOfMonth: '1' }
    case 'monthly':
      return { preset: 'monthly', customKind: 'at', minute: '00', time: rule.time, timeZone: rule.time_zone, weekdays: [1, 2, 3, 4, 5], dayOfMonth: String(rule.dayOfMonth) }
    case 'every':
      return { preset: 'custom', customKind: 'every', minute: '00', time: '09:00', timeZone: tz, weekdays: [1, 2, 3, 4, 5], dayOfMonth: '1' }
    case 'after':
      return { preset: 'custom', customKind: 'after', minute: '00', time: '09:00', timeZone: tz, weekdays: [1, 2, 3, 4, 5], dayOfMonth: '1' }
    case 'at':
      return { preset: 'custom', customKind: 'at', minute: '00', time: '09:00', timeZone: tz, weekdays: [1, 2, 3, 4, 5], dayOfMonth: '1' }
  }
}

/** Validate an `HH:mm` string. */
function isTime(time: string): boolean {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(time)
}

/**
 * Split a `<providerId>/<modelId>` option key at the FIRST slash — model ids may
 * themselves contain slashes (e.g. openrouter's `stealth/ox-alpha`), so a naive
 * `split('/')` would truncate the model id.
 */
function parseModelKey(key: string): { provider: string; model: string } | undefined {
  const at = key.indexOf('/')
  if (at <= 0 || at === key.length - 1) return undefined
  return { provider: key.slice(0, at), model: key.slice(at + 1) }
}

export interface ScheduledTaskCreateProps {
  readonly t: ScheduledTaskTranslate
  readonly busy: boolean
  /** Present in edit mode; absent creates a new task. */
  readonly task?: ScheduledTaskView | undefined
  readonly listProjects: () => Promise<readonly ScheduledTaskProjectOption[]>
  readonly listModels: () => Promise<readonly ScheduledTaskModelOption[]>
  readonly onCancel: () => void
  readonly onSubmit: (
    input: ScheduledTaskCreateInput,
  ) => Promise<{ ok: true } | { ok: false; message: string }>
}

/** Option-list loader state shared by the project and model selects. */
interface OptionsState<T> {
  readonly status: 'loading' | 'ready' | 'failed'
  readonly items: readonly T[]
  readonly error?: string
}

const IDLE_OPTIONS: OptionsState<never> = { status: 'loading', items: [], error: '' }

/** Render the create/edit scheduled-task form. */
export function ScheduledTaskCreate({
  t, busy, task, listProjects, listModels, onCancel, onSubmit,
}: ScheduledTaskCreateProps) {
  const [title, setTitle] = useState(task?.title ?? '')
  const [prompt, setPrompt] = useState(task?.prompt ?? '')
  const [schedule, setSchedule] = useState(() => initialSchedule(task))
  const [date, setDate] = useState('')
  const [atTime, setAtTime] = useState('')
  const [afterSeconds, setAfterSeconds] = useState('60')
  const [everySeconds, setEverySeconds] = useState('300')
  const [projectKey, setProjectKey] = useState(task?.workspaceId ?? '')
  const [modelKey, setModelKey] = useState(
    task?.model === undefined ? '' : `${task.model.provider}/${task.model.model}`,
  )
  const [confirmBeforeChange, setConfirmBeforeChange] = useState(task?.confirmBeforeChange ?? false)
  const [projects, setProjects] = useState<OptionsState<ScheduledTaskProjectOption>>(IDLE_OPTIONS)
  const [models, setModels] = useState<OptionsState<ScheduledTaskModelOption>>(IDLE_OPTIONS)
  const [formError, setFormError] = useState<string | null>(null)

  const { preset, customKind, minute, time, timeZone, weekdays, dayOfMonth } = schedule

  // Edit-mode `at` rules prefill the calendar fields from the stored instant.
  useEffect(() => {
    if (task?.rule.kind !== 'at') return
    const at = new Date(task.rule.scheduledAt)
    setDate([at.getFullYear(), String(at.getMonth() + 1).padStart(2, '0'), String(at.getDate()).padStart(2, '0')].join('-'))
    setAtTime(`${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`)
  }, [task])

  // Load the two option catalogs once; failures keep the fields optional.
  useEffect(() => {
    let alive = true
    listProjects().then(
      items => { if (alive) setProjects({ status: 'ready', items }) },
      error => {
        if (alive) setProjects({ status: 'failed', items: [], error: error instanceof Error ? error.message : String(error) })
      },
    )
    listModels().then(
      items => { if (alive) setModels({ status: 'ready', items }) },
      error => {
        if (alive) setModels({ status: 'failed', items: [], error: error instanceof Error ? error.message : String(error) })
      },
    )
    return () => { alive = false }
  }, [listProjects, listModels])

  const patchSchedule = (patch: Partial<ScheduleState>): void => {
    setSchedule(current => ({ ...current, ...patch }))
  }
  const setPreset = (next: SchedulePreset): void => { patchSchedule({ preset: next }) }

  const selectorValid = (() => {
    switch (preset) {
      case '':
        return false
      case 'hourly':
        return /^\d{1,2}$/.test(minute) && Number(minute) >= 0 && Number(minute) <= 59
      case 'daily':
        return isTime(time) && timeZone.trim() !== ''
      case 'weekly':
        return weekdays.length > 0 && isTime(time) && timeZone.trim() !== ''
      case 'monthly':
        return isTime(time) && timeZone.trim() !== '' && Number(dayOfMonth) >= 1 && Number(dayOfMonth) <= 31
      case 'custom':
        switch (customKind) {
          case 'at':
            return date !== '' && atTime !== '' && timeZone.trim() !== ''
          case 'after':
            return Number.isInteger(Number(afterSeconds)) && Number(afterSeconds) > 0
          case 'every':
            return Number.isInteger(Number(everySeconds)) && Number(everySeconds) >= 300
        }
    }
  })()

  /** Build the wire selector object (not including title/prompt/carry). */
  const buildSelector = (): ScheduleSelector | undefined => {
    switch (preset) {
      case '':
        return undefined
      case 'hourly':
        return { hourly: { minute: Number(minute) } }
      case 'daily':
        return { daily: { time, time_zone: timeZone.trim() } }
      case 'weekly':
        return { weekly: { weekdays, time, time_zone: timeZone.trim() } }
      case 'monthly':
        return { monthly: { dayOfMonth: Number(dayOfMonth), time, time_zone: timeZone.trim() } }
      case 'custom':
        if (customKind === 'at') return { at: { date, time: atTime, time_zone: timeZone.trim() } }
        if (customKind === 'after') return { after_seconds: Number(afterSeconds) }
        return { every_seconds: Number(everySeconds) }
    }
  }

  /** Assemble the wire input from the form state. */
  const buildInput = (): ScheduledTaskCreateInput | undefined => {
    if (!selectorValid) return undefined
    const trimmedPrompt = prompt.trim()
    const effectiveTitle = title.trim() !== '' ? title.trim() : trimmedPrompt.slice(0, 40)
    const project = projects.items.find(item => item.workspaceId === projectKey)
    const model = modelKey === '' ? undefined : parseModelKey(modelKey)
    const base: ScheduledTaskCreateInput = {
      title: effectiveTitle,
      prompt: trimmedPrompt,
      confirmBeforeChange,
      ...(project === undefined ? {} : { workspaceId: project.workspaceId, cwd: project.path }),
    }
    if (model !== undefined) base.model = model
    const selector = buildSelector()
    return { ...base, ...(selector === undefined ? {} : selector) }
  }

  const submit = async (): Promise<void> => {
    if (prompt.trim() === '') { setFormError(t('form.prompt.required')); return }
    const input = buildInput()
    if (input === undefined) return
    setFormError(null)
    const result = await onSubmit(input)
    if (!result.ok) setFormError(result.message)
  }

  return (
    <>
      <header className={css.head}>
        <h2 className={css.title}>{task === undefined ? t('create.title') : t('create.editTitle')}</h2>
        <div className={css.headActions}>
          <button type="button" className={css.ghostButton} disabled={busy} onClick={onCancel}>
            {t('form.cancel')}
          </button>
          <button
            type="button"
            className={css.primaryButton}
            disabled={busy || prompt.trim() === '' || !selectorValid}
            onClick={() => { void submit() }}
          >
            {busy ? t('form.submitBusy') : task === undefined ? t('create.submit') : t('create.save')}
          </button>
        </div>
      </header>
      <p className={css.subtitle}>{t('create.subtitle')}</p>
      <div className={`${css.body} ${css.formBody}`}>
        <label className={css.fieldLine}>
          <span>{t('form.title.label')}</span>
          <input
            className={css.textInput}
            value={title}
            onChange={(event) => { setTitle(event.target.value) }}
            placeholder={t('form.title.placeholder')}
          />
        </label>
        <div className={css.fieldLine}>
          <span>{t('form.schedule.label')}</span>
          <ScheduleEditor
            t={t}
            preset={preset}
            minute={minute}
            time={time}
            timeZone={timeZone}
            weekdays={weekdays}
            dayOfMonth={dayOfMonth}
            onPresetChange={setPreset}
            onMinuteChange={(value) => { patchSchedule({ minute: value }) }}
            onTimeChange={(value) => { patchSchedule({ time: value }) }}
            onWeekdaysChange={(value) => { patchSchedule({ weekdays: value }) }}
            onDayOfMonthChange={(value) => { patchSchedule({ dayOfMonth: value }) }}
            onClear={() => { patchSchedule({ preset: '' }) }}
          />
          {!selectorValid && (
            <span className={css.fieldHint}>{preset === '' ? t('form.schedule.required') : t('form.schedule.invalid')}</span>
          )}
        </div>
        {preset === 'custom' && (
          <div className={`${css.formBody} ${css.customGroup}`}>
            <label className={css.fieldLine}>
              <span>{t('form.schedule.label')}</span>
              <select
                className={css.textInput}
                value={customKind}
                onChange={(event) => { patchSchedule({ customKind: event.target.value as CustomKind }) }}
              >
                <option value="at">{t('form.kind.once')}</option>
                <option value="after">{t('form.kind.delay')}</option>
                <option value="every">{t('form.kind.interval')}</option>
              </select>
            </label>
            {customKind === 'at' && (
              <>
                <label className={css.fieldLine}>
                  <span>{t('form.date')}</span>
                  <input className={css.textInput} type="date" value={date} onChange={(event) => { setDate(event.target.value) }} />
                </label>
                <label className={css.fieldLine}>
                  <span>{t('form.time')}</span>
                  <input className={css.textInput} type="time" value={atTime} onChange={(event) => { setAtTime(event.target.value) }} />
                </label>
                <label className={css.fieldLine}>
                  <span>{t('form.timeZone')}</span>
                  <input
                    className={css.textInput}
                    value={timeZone}
                    onChange={(event) => { patchSchedule({ timeZone: event.target.value }) }}
                    placeholder={Intl.DateTimeFormat().resolvedOptions().timeZone}
                  />
                </label>
              </>
            )}
            {customKind === 'after' && (
              <label className={css.fieldLine}>
                <span>{t('form.afterSeconds')}</span>
                <input
                  className={css.textInput}
                  type="number"
                  min={1}
                  value={afterSeconds}
                  onChange={(event) => { setAfterSeconds(event.target.value) }}
                />
              </label>
            )}
            {customKind === 'every' && (
              <label className={css.fieldLine}>
                <span>{t('form.everySeconds')}</span>
                <input
                  className={css.textInput}
                  type="number"
                  min={300}
                  value={everySeconds}
                  onChange={(event) => { setEverySeconds(event.target.value) }}
                />
              </label>
            )}
          </div>
        )}
        <label className={css.fieldLine}>
          <span>{t('form.prompt.label')}</span>
          <textarea
            className={css.textArea}
            value={prompt}
            onChange={(event) => { setPrompt(event.target.value) }}
            placeholder={t('form.prompt.placeholder')}
          />
        </label>
        <div className={css.bottomBar}>
          <label className={css.fieldLine}>
            <span>{t('form.project.label')}</span>
            <select
              className={css.textInput}
              value={projectKey}
              disabled={projects.status !== 'ready'}
              onChange={(event) => { setProjectKey(event.target.value) }}
            >
              <option value="">
                {projects.status === 'loading'
                  ? t('form.project.loading')
                  : projects.status === 'failed'
                    ? t('form.project.failed', { message: projects.error ?? '' })
                    : t('form.project.none')}
              </option>
              {projects.items.map(item => (
                <option key={item.workspaceId} value={item.workspaceId}>{item.title}</option>
              ))}
            </select>
          </label>
          <div className={css.switchRow}>
            <div className={css.switchCopy}>
              <span>{t('form.confirm.label')}</span>
              <span className={css.hint}>{t('form.confirm.hint')}</span>
            </div>
            <button
              type="button"
              className={css.switch}
              data-on={confirmBeforeChange || undefined}
              role="switch"
              aria-checked={confirmBeforeChange}
              aria-label={t('form.confirm.label')}
              onClick={() => { setConfirmBeforeChange(value => !value) }}
            />
          </div>
          <label className={css.fieldLine}>
            <span>{t('form.model.label')}</span>
            <select
              className={css.textInput}
              value={modelKey}
              disabled={models.status !== 'ready'}
              onChange={(event) => { setModelKey(event.target.value) }}
            >
              <option value="">
                {models.status === 'loading'
                  ? t('form.model.loading')
                  : models.status === 'failed'
                    ? t('form.model.failed', { message: models.error ?? '' })
                    : models.items.length === 0
                      ? t('form.model.empty')
                      : t('form.model.default')}
              </option>
              {models.items.map(item => (
                <option key={`${item.providerId}/${item.modelId}`} value={`${item.providerId}/${item.modelId}`}>
                  {item.providerName}/{item.modelName}
                </option>
              ))}
            </select>
          </label>
        </div>
        {formError !== null && <p className={css.readError} role="alert">{formError}</p>}
      </div>
    </>
  )
}
