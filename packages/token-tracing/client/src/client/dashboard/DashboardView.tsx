/**
 * Dashboard orchestration view: header (range chips / refresh / basis legend /
 * close), the days+sessions snapshot fetch with a stale-response guard, and
 * the panel layout with the shared locate state (evidence clicks scroll to
 * and highlight their anchor). Data math is delegated to the pure modules.
 * @module @qihongmu/dsh-client-ui-token-tracing/src/client/dashboard/DashboardView
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { IconCloseOutline16, IconRefreshOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DayRollupView, SessionRollupView } from '@qihongmu/dsh-plugins-token-tracing/types'
import type { TokenTracingRemote } from '../slots.ts'
import type { Translate } from '../translate.ts'
import { mergeComponents, mergeTools, positiveTotal, toolRows } from './aggregate.ts'
import { ComponentPanel } from './ComponentPanel.tsx'
import { DailyBars } from './DailyBars.tsx'
import { dayWindow, splitDays, splitSessions } from './range.ts'
import { SessionList } from './SessionList.tsx'
import { deriveSuggestions, type SuggestionEvidence } from './suggest.ts'
import { SuggestionsPanel } from './SuggestionsPanel.tsx'
import { SummaryStrip } from './SummaryStrip.tsx'
import { TopToolsTable } from './TopToolsTable.tsx'
import css from './Dashboard.module.css'

const RANGES: readonly number[] = [7, 14, 30, 90]
/** sessions() has no fetch-all semantics; 10k covers realistic scale. */
const SESSIONS_LIMIT = 10_000

interface DashboardViewProps {
  remote: TokenTracingRemote
  openSession: (sessionId: string) => void
  t: Translate
  onClose: () => void
}

interface DashboardData {
  days: DayRollupView[]
  sessions: SessionRollupView[]
  /** Fetch timestamp — pins the period split against clock drift mid-view. */
  fetchedAt: number
}

export function DashboardView({ remote, openSession, t, onClose }: DashboardViewProps): ReactNode {
  const [rangeDays, setRangeDays] = useState(7)
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [selectedDay, setSelectedDay] = useState<string | null>(null)
  const [locate, setLocate] = useState<SuggestionEvidence | null>(null)
  const [expandedSession, setExpandedSession] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  // Snapshot fetch: open / range switch / refresh. Unary calls cannot be
  // cancelled — a monotonically increasing capture id discards stale answers.
  useEffect(() => {
    let stale = false
    setLoading(true)
    setError(null)
    void (async () => {
      try {
        const sinceDays = rangeDays * 2
        const [daysAnswered, sessionsAnswered] = await Promise.all([
          remote.days({ sinceDays, limit: sinceDays + 2 }),
          remote.sessions({ sinceDays, limit: SESSIONS_LIMIT }),
        ])
        if (stale) return
        if (!daysAnswered.ok) throw new Error(`${daysAnswered.error.code}: ${daysAnswered.error.message}`)
        if (!sessionsAnswered.ok) throw new Error(`${sessionsAnswered.error.code}: ${sessionsAnswered.error.message}`)
        setData({ days: daysAnswered.value, sessions: sessionsAnswered.value, fetchedAt: Date.now() })
      } catch (caught: unknown) {
        if (stale) return
        setData(null)
        setError(caught instanceof Error ? caught.message : String(caught))
      } finally {
        if (!stale) setLoading(false)
      }
    })()
    return () => { stale = true }
  }, [remote, rangeDays, refreshKey])

  // A range switch invalidates the drill-down state.
  useEffect(() => {
    setSelectedDay(null)
    setLocate(null)
    setExpandedSession(null)
  }, [rangeDays])

  // Evidence clicks scroll their anchor into view; the highlight persists
  // until the next locate (kept simple — no highlight timers).
  useEffect(() => {
    if (locate === null || scrollRef.current === null) return
    const anchor = scrollRef.current.querySelector(`[data-locate="${locate.kind}:${CSS.escape(locate.key)}"]`)
    anchor?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [locate])

  const now = data?.fetchedAt ?? 0
  const split = useMemo(
    () => data === null ? null : splitDays(data.days, rangeDays, now),
    [data, rangeDays, now],
  )
  const sessionSplit = useMemo(
    () => data === null ? null : splitSessions(data.sessions, rangeDays, now),
    [data, rangeDays, now],
  )
  const suggestions = useMemo(
    () => split === null || sessionSplit === null
      ? []
      : deriveSuggestions({ days: split.current, previousDays: split.previous, sessions: sessionSplit.current }),
    [split, sessionSplit],
  )
  const dayKeys = useMemo(() => dayWindow(rangeDays, now), [rangeDays, now])
  const startDay = split?.current[0]?.day ?? ''
  // Computed once: the tool table's share denominator and the composition
  // panel consume the same merge.
  const components = useMemo(() => split === null ? {} : mergeComponents(split.current), [split])
  const componentsTotal = useMemo(() => positiveTotal(components), [components])
  const toolTable = useMemo(() => {
    if (split === null) return []
    return toolRows({
      tools: mergeTools(split.current),
      componentsTotal,
      previousTools: mergeTools(split.previous),
      sessions: sessionSplit?.current ?? [],
      startDay,
    })
  }, [split, sessionSplit, startDay, componentsTotal])

  const handleLocate = (evidence: SuggestionEvidence): void => {
    setLocate(evidence)
    // Day evidence also drives the session-list filter (PRD §5.3-6).
    if (evidence.kind === 'day') setSelectedDay(evidence.key)
  }

  const refresh = (): void => { setRefreshKey(key => key + 1) }

  // Day-filter feedback lives next to the chart (the session list itself can
  // be a viewport away); "view" scrolls it into view on demand.
  const daySessionCount = useMemo(
    () => selectedDay === null || sessionSplit === null
      ? 0
      : sessionSplit.current.filter(session => session.byDay[selectedDay] !== undefined).length,
    [selectedDay, sessionSplit],
  )
  const scrollToSessions = (): void => {
    scrollRef.current?.querySelector('[data-section="sessions"]')
      ?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }

  return (
    <div className={css.view}>
      <header className={css.header}>
        <h2 className={css.title}>{t('dashboard.title')}</h2>
        <div className={css.chips}>
          {RANGES.map(days => (
            <button
              key={days}
              type="button"
              className={rangeDays === days ? `${css.chip} ${css.chipActive}` : css.chip}
              onClick={() => { setRangeDays(days) }}
            >
              {t('dashboard.range', { days })}
            </button>
          ))}
        </div>
        <div className={css.legend}>
          <span className={css.tipAnchor}>
            <span className={css.badgeExact}>{t('dashboard.legend.exact')}</span>
            <span className={css.badgeEstimated}>{t('dashboard.legend.estimated')}</span>
            <span className={`${css.tip} ${css.tipRight} ${css.tipWide}`}>
              <span className={css.tooltipHead}>{t('help.basisTitle')}</span>
              <span className={css.tooltipLine}>{t('help.basis')}</span>
            </span>
          </span>
        </div>
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('dashboard.refresh')}
          title={t('dashboard.refresh')}
          onClick={refresh}
        >
          <IconRefreshOutline16 />
        </button>
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('dashboard.close')}
          title={t('dashboard.close')}
          onClick={onClose}
        >
          <IconCloseOutline16 />
        </button>
      </header>
      {error !== null
        ? (
            <div className={css.stateBox} role="alert">
              <span className={css.errorText}>{t('dashboard.error', { message: error })}</span>
              <button type="button" className={css.retryButton} onClick={refresh}>{t('dashboard.retry')}</button>
            </div>
          )
        : loading || split === null || sessionSplit === null
          ? <div className={css.stateBox}><span className={css.muted}>{t('dashboard.loading')}</span></div>
          : split.current.length === 0
            ? (
                <div className={css.stateBox}>
                  <div className={css.emptyTitle}>{t('dashboard.empty.title')}</div>
                  <div className={css.muted}>{t('dashboard.empty.hint')}</div>
                </div>
              )
            : (
                <div className={css.scroll} ref={scrollRef}>
                  <SummaryStrip
                    currentDays={split.current}
                    previousDays={split.previous}
                    currentSessions={sessionSplit.current}
                    previousSessions={sessionSplit.previous}
                    t={t}
                  />
                  <section className={css.section}>
                    <div className={css.sectionTitleRow}>
                      <span className={css.sectionTitle}>{t('dashboard.daily.title')}</span>
                      <span className={css.sectionNote}>{t('dashboard.daily.utc')}</span>
                    </div>
                    <DailyBars
                      dayKeys={dayKeys}
                      rows={split.current}
                      selectedDay={selectedDay}
                      onSelectDay={day => { setSelectedDay(previous => previous === day ? null : day) }}
                      locate={locate}
                      t={t}
                    />
                    {selectedDay !== null
                      ? (
                          <div className={css.filterRow}>
                            <span className={css.filterNote}>
                              {t('dashboard.daily.filter', { day: selectedDay, count: daySessionCount })}
                            </span>
                            <button type="button" className={css.filterButton} onClick={scrollToSessions}>
                              {t('dashboard.daily.filterView')}
                            </button>
                            <button type="button" className={css.filterButton} onClick={() => { setSelectedDay(null) }}>
                              {t('dashboard.daily.filterClear')}
                            </button>
                          </div>
                        )
                      : null}
                  </section>
                  <div className={css.columns}>
                    <ComponentPanel
                      components={components}
                      dayKeys={dayKeys}
                      rows={split.current}
                      locate={locate}
                      t={t}
                    />
                    <TopToolsTable rows={toolTable} locate={locate} t={t} />
                  </div>
                  <SuggestionsPanel suggestions={suggestions} onLocate={handleLocate} t={t} />
                  <SessionList
                    sessions={sessionSplit.current}
                    startDay={startDay}
                    selectedDay={selectedDay}
                    expandedSession={expandedSession}
                    onExpand={setExpandedSession}
                    openSession={openSession}
                    onClose={onClose}
                    remote={remote}
                    locate={locate}
                    t={t}
                  />
                </div>
              )}
    </div>
  )
}
