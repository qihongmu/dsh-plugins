/**
 * Sidebar footer entry for the M3 token dashboard: the trigger (wide row /
 * rail icon, scheduled-task badge pattern) plus the full-page surface it
 * opens — a fixed inset-0 section at the drawer's proven z-layer, covering
 * sidebar + conversation + details. Esc and the header close button dismiss
 * it; closing unmounts the data tree (reopening resets to the default range).
 * @module @qihongmu/dsh-client-ui-token-tracing/src/client/dashboard/DashboardEntry
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { IconDataOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { TokenDashboardFace } from '../slots.ts'
import { DashboardView } from './DashboardView.tsx'
import css from './Dashboard.module.css'

/** Full entry props composed by the sidebar footer-action slot. */
export type TokenDashboardEntryProps =
  PropsRuntime<'sidebar.footer.action'>
  & InjectFace<TokenDashboardFace>
  & PropsLocale<'token-tracing'>

export function TokenDashboardEntry({ wide, remote, openSession, t }: TokenDashboardEntryProps): ReactNode {
  const [open, setOpen] = useState(false)

  // Esc dismisses the full-page surface while it is open.
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [open])

  return (
    <div className={wide ? css.layer : `${css.layer} ${css.rail}`}>
      {open
        ? (
            <section className={css.page} aria-label={t('dashboard.title')}>
              <DashboardView
                remote={remote}
                openSession={openSession}
                t={t}
                onClose={() => { setOpen(false) }}
              />
            </section>
          )
        : null}
      <div className={css.footerButtons}>
        <button
          type="button"
          className={css.badge}
          data-active={open || undefined}
          aria-label={t('dashboard.title')}
          aria-expanded={open}
          onClick={() => { setOpen(current => !current) }}
        >
          <IconDataOutline16 />
          {wide && <span className={css.badgeLabel}>{t('dashboard.title')}</span>}
        </button>
      </div>
    </div>
  )
}
