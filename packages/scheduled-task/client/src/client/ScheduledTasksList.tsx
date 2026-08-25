/**
 * 已安排的任务 list view (the drawer body): search box, status filter tabs, and
 * the task rows with hover-revealed actions over the Remote.
 */

import { useState } from 'react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import {
  IconCloseOutline16, IconEditOutline16, IconPauseOutline16,
  IconPlayOutline16, IconPlusOutline16, IconSearchOutline16, IconTrashOutline16,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  ScheduledTaskSettableStatus, ScheduledTaskView,
} from '@deepseek-ai/dsh-plugins-scheduled-task/types'
import type { ScheduledTaskKey } from './locales.ts'
import { localizedDate, ruleSummary } from './format.ts'
import type { ScheduledTaskTranslate } from './format.ts'
import css from './ScheduledTasksPanel.module.css'

/** The status axis behind the filter tabs; completed tasks surface under 全部 only. */
type StatusFilter = 'all' | 'active' | 'paused'

const FILTER_LABELS = {
  all: 'filter.all',
  active: 'filter.active',
  paused: 'filter.paused',
} as const satisfies Record<StatusFilter, ScheduledTaskKey>

const STATUS_LABELS = {
  active: 'row.status.active',
  paused: 'row.status.paused',
  completed: 'row.status.completed',
} as const satisfies Record<ScheduledTaskView['status'], ScheduledTaskKey>

export interface ScheduledTasksListProps {
  readonly t: ScheduledTaskTranslate
  readonly tasks: readonly ScheduledTaskView[]
  readonly busy: boolean
  readonly onCreate: () => void
  readonly onClose: () => void
  readonly onEdit: (task: ScheduledTaskView) => void
  readonly onSetStatus: (task: ScheduledTaskView, status: ScheduledTaskSettableStatus) => void
  readonly onDelete: (task: ScheduledTaskView) => void
  readonly onMarkRead: (task: ScheduledTaskView) => void
}

/** Row action wrapper: a tooltip over a compact icon button. */
function RowAction({ label, children, ...props }: {
  label: string
  children: ReactNode
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <Tooltip label={label} side="bottom" delayMs={500}>
      <button type="button" className={css.actionButton} aria-label={label} {...props}>
        {children}
      </button>
    </Tooltip>
  )
}

/** Render the scheduled-tasks list view. */
export function ScheduledTasksList({
  t, tasks, busy, onCreate, onClose, onEdit, onSetStatus, onDelete, onMarkRead,
}: ScheduledTasksListProps) {
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<StatusFilter>('all')

  const query = search.trim().toLowerCase()
  const filtered = tasks.filter(task => {
    if (filter === 'active' && task.status !== 'active') return false
    if (filter === 'paused' && task.status !== 'paused') return false
    if (query !== '' && !task.title.toLowerCase().includes(query)) return false
    return true
  })

  return (
    <>
      <header className={css.head}>
        <h2 className={css.title}>{t('panel.title')}</h2>
        <div className={css.headActions}>
          <button type="button" className={css.primaryButton} onClick={onCreate}>
            <IconPlusOutline16 size={14} />
            <span>{t('action.create')}</span>
          </button>
          <Tooltip label={t('drawer.close')} side="bottom" delayMs={500}>
            <button type="button" className={css.closeButton} aria-label={t('drawer.close')} onClick={onClose}>
              <IconCloseOutline16 size={16} />
            </button>
          </Tooltip>
        </div>
      </header>
      <p className={css.subtitle}>{t('panel.subtitle')}</p>
      <div className={css.toolbar}>
        <label className={css.searchBox}>
          <IconSearchOutline16 size={14} />
          <input
            className={css.searchInput}
            value={search}
            onChange={(event) => { setSearch(event.target.value) }}
            placeholder={t('search.placeholder')}
          />
        </label>
      </div>
      <nav className={css.tabs} aria-label={t('panel.title')}>
        {(Object.keys(FILTER_LABELS) as StatusFilter[]).map(item => (
          <button
            key={item}
            type="button"
            className={css.tab}
            data-active={filter === item || undefined}
            onClick={() => { setFilter(item) }}
          >
            {t(FILTER_LABELS[item])}
          </button>
        ))}
      </nav>
      <div className={css.body}>
        {filtered.length === 0 && (
          <p className={css.note}>{t('panel.empty')}</p>
        )}
        {filtered.length > 0 && (
          <ul className={css.rows}>
            {filtered.map(task => (
              <li key={task.id} className={css.row}>
                <span
                  className={css.statusDot}
                  data-status={task.status}
                  role="img"
                  aria-label={t(STATUS_LABELS[task.status])}
                />
                <div
                  className={css.rowMain}
                  data-unread={task.unread || undefined}
                  role={task.unread ? 'button' : undefined}
                  tabIndex={task.unread ? 0 : undefined}
                  aria-label={task.unread ? t('action.markRead') : undefined}
                  onClick={() => { if (task.unread && !busy) onMarkRead(task) }}
                  onKeyDown={(event) => {
                    if (task.unread && !busy && (event.key === 'Enter' || event.key === ' ')) {
                      event.preventDefault()
                      onMarkRead(task)
                    }
                  }}
                >
                  <div className={css.rowHead}>
                    {task.unread && <span className={css.unreadDot} />}
                    <span className={css.rowTitle}>{task.title}</span>
                  </div>
                  <div className={css.rowMeta}>
                    <span className={css.rowSchedule}>{ruleSummary(task.rule, t)}</span>
                    {task.nextRunAt !== undefined && task.status !== 'completed' && (
                      <span className={css.rowNext}>{t('row.next', { time: localizedDate(task.nextRunAt) })}</span>
                    )}
                    {task.state === 'overdue' && <span className={css.rowOverdue}>{t('row.state.overdue')}</span>}
                    {task.lastError !== undefined && (
                      <span className={css.rowLastError} title={`${task.lastError.at} — ${task.lastError.message}`}>
                        {t('row.lastError')}
                      </span>
                    )}
                    <span className={css.rowStatus} data-state={task.state}>{t(STATUS_LABELS[task.status])}</span>
                  </div>
                </div>
                <div className={css.rowActions}>
                  {task.status === 'active' && (
                    <RowAction label={t('action.pause')} disabled={busy} onClick={() => { onSetStatus(task, 'paused') }}>
                      <IconPauseOutline16 size={14} />
                    </RowAction>
                  )}
                  {task.status === 'paused' && (
                    <RowAction label={t('action.resume')} disabled={busy} onClick={() => { onSetStatus(task, 'active') }}>
                      <IconPlayOutline16 size={14} />
                    </RowAction>
                  )}
                  <RowAction label={t('action.edit')} disabled={busy} onClick={() => { onEdit(task) }}>
                    <IconEditOutline16 size={14} />
                  </RowAction>
                  <RowAction label={t('action.delete')} disabled={busy} onClick={() => { onDelete(task) }}>
                    <IconTrashOutline16 size={14} />
                  </RowAction>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  )
}
