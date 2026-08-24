/**
 * Global scheduled-task panel shell (external plugin): the sidebar footer
 * trigger opens a right-docked drawer hosting two views — the 已安排的任务
 * history list (search/filter/create) and the 新建定时任务 form — over the
 * Remote's list/create/update/setStatus/delete/markRead surface.
 */

import { useEffect, useState } from 'react'
import { IconRefreshOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {
  ScheduledTaskCreateInput, ScheduledTaskSettableStatus, ScheduledTaskView,
} from '@deepseek-ai/dsh-plugins-scheduled-task/types'
import { ScheduledTaskCreate } from './ScheduledTaskCreate.tsx'
import { ScheduledTasksList } from './ScheduledTasksList.tsx'
import type { ScheduledTasksPanelFace } from './slots.ts'
import css from './ScheduledTasksPanel.module.css'

/** Full panel props composed by the sidebar footer-action slot. */
export type ScheduledTasksPanelProps =
  PropsRuntime<'sidebar.footer.action'> & InjectFace<ScheduledTasksPanelFace> & PropsLocale<'scheduled-tasks'>

/** Unwrap one Typert envelope; a falsey `ok` keeps the inner error message. */
function unwrap<T>(
  answered: { ok: true; value: T } | { ok: false; error: { code: string; message: string } },
): { ok: true; value: T } | { ok: false; message: string } {
  if (!answered.ok) return { ok: false, message: `${answered.error.code}: ${answered.error.message}` }
  return { ok: true, value: answered.value }
}

/** Render the scheduled-tasks trigger and its right-side drawer. */
export function ScheduledTasksPanel({ wide, remote, listProjects, listModels, t }: ScheduledTasksPanelProps) {
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<'list' | 'create'>('list')
  const [tasks, setTasks] = useState<readonly ScheduledTaskView[]>([])
  const [read, setRead] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [editingId, setEditingId] = useState<ScheduledTaskView['id'] | null>(null)

  const unread = tasks.filter(task => task.unread).length

  const refresh = async (): Promise<void> => {
    const next = unwrap(await remote.list())
    if (!next.ok) {
      setRead(true)
      setError(next.message)
      setTasks([])
      return
    }
    setRead(true)
    setError(null)
    setTasks(next.value)
  }

  useEffect(() => {
    if (open) void refresh()
  }, [open])

  // Esc closes the drawer from either view.
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [open])

  const openList = (): void => {
    setEditingId(null)
    setView('list')
  }

  const runMutation = async (action: () => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await action()
    } finally {
      setBusy(false)
      void refresh()
    }
  }

  const setStatus = (task: ScheduledTaskView, status: ScheduledTaskSettableStatus): void => {
    void runMutation(async () => {
      const next = unwrap(await remote.setStatus(task.id, status))
      if (!next.ok) throw new Error(next.message)
      if (!next.value.ok) throw new Error(`${next.value.code}: ${next.value.message}`)
    })
  }

  const removeTask = (task: ScheduledTaskView): void => {
    void runMutation(async () => {
      const next = unwrap(await remote.delete(task.id))
      if (!next.ok) throw new Error(next.message)
      if (!next.value.ok) throw new Error(`${next.value.code}: ${next.value.message}`)
    })
  }

  const markRead = (task: ScheduledTaskView): void => {
    void runMutation(async () => {
      const next = unwrap(await remote.markRead(task.id))
      if (!next.ok) throw new Error(next.message)
    })
  }

  /** Create or update from the create view; errors surface inside the form. */
  const submit = async (
    input: ScheduledTaskCreateInput,
  ): Promise<{ ok: true } | { ok: false; message: string }> => {
    const answered = editingId === null
      ? await remote.create(input)
      : await remote.update(editingId, input)
    const envelope = unwrap(answered)
    if (!envelope.ok) return { ok: false, message: envelope.message }
    if (!envelope.value.ok) return { ok: false, message: `${envelope.value.code}: ${envelope.value.message}` }
    openList()
    void refresh()
    return { ok: true }
  }

  const editing = editingId === null ? undefined : tasks.find(task => task.id === editingId)

  return (
    <div className={wide ? css.layer : `${css.layer} ${css.rail}`}>
      {open && (
        <>
          <div className={css.backdrop} onClick={() => { setOpen(false) }} />
          <section className={css.drawer} aria-label={t('panel.title')}>
            {view === 'list' ? (
              <ScheduledTasksList
                t={t}
                tasks={tasks}
                busy={busy}
                onCreate={() => { setEditingId(null); setView('create') }}
                onClose={() => { setOpen(false) }}
                onEdit={(task) => { setEditingId(task.id); setView('create') }}
                onSetStatus={setStatus}
                onDelete={removeTask}
                onMarkRead={markRead}
              />
            ) : (
              <ScheduledTaskCreate
                key={editingId ?? 'new'}
                t={t}
                busy={busy}
                task={editing}
                listProjects={listProjects}
                listModels={listModels}
                onCancel={openList}
                onSubmit={submit}
              />
            )}
            {error !== null && (
              <p className={`${css.readError} ${css.drawerError}`} role="alert">
                {t('panel.readFailed', { message: error })}
              </p>
            )}
            {!read && <p className={`${css.note} ${css.drawerError}`}>{t('panel.loading')}</p>}
          </section>
        </>
      )}
      <div className={css.footerButtons}>
        <button
          type="button"
          className={css.badge}
          data-active={open || undefined}
          aria-label={t('trigger.aria')}
          aria-expanded={open}
          onClick={() => { setOpen(current => !current) }}
        >
          <IconRefreshOutline16 />
          {wide && <span className={css.badgeLabel}>{t('trigger.label')}</span>}
          {unread > 0 && <span className={css.badgeCount}>{unread}</span>}
        </button>
      </div>
    </div>
  )
}
