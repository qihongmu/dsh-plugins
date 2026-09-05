/**
 * Dashboard session list: one row per session active in the current period
 * (range-scoped numbers come from each session's own byDay slice), expandable
 * to a per-day mini bar chart plus the single-session suggestion variant,
 * with a deep link that opens the session in the conversation view. A day
 * selected in DailyBars filters the list to sessions active that day.
 * @module @qihongmu/dsh-client-ui-token-tracing/src/client/dashboard/SessionList
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { SessionRollupView } from '@qihongmu/dsh-plugins-token-tracing/types'
import type { TokenTracingRemote } from '../slots.ts'
import { sessionRangeStats, shortId } from './aggregate.ts'
import { cacheHitRatio, formatRatio, formatTokens } from '../format.ts'
import { batchTurnNumbers, scanTurns, type LongResultFinding } from './scan.ts'
import { LONG_RESULT_TOKENS, SCAN_BATCH_TURNS } from './suggest.ts'
import { utcDay } from './range.ts'
import { deriveSessionSuggestions, type SuggestionEvidence } from './suggest.ts'
import { SuggestionRow } from './SuggestionsPanel.tsx'
import { labelForKey } from './labels.ts'
import type { Translate } from '../translate.ts'
import css from './Dashboard.module.css'

/** Render cap per PRD §5.3-7 — everything stays in memory, DOM truncates. */
const SESSION_PAGE = 50

interface SessionListProps {
  sessions: readonly SessionRollupView[]
  /** First day of the current period (range scoping for session stats). */
  startDay: string
  selectedDay: string | null
  expandedSession: string | null
  onExpand: (sessionId: string | null) => void
  openSession: (sessionId: string) => void
  onClose: () => void
  /** Live Remote namespace — powers the FR-13 oversized-result scan. */
  remote: TokenTracingRemote
  locate: SuggestionEvidence | null
  t: Translate
}

/** Lifecycle of one oversized-result scan (FR-13, run on explicit action). */
interface ScanState {
  sessionId: string
  phase: 'running' | 'done' | 'failed'
  done: number
  total: number
  findings: LongResultFinding[]
  message: string | null
}

/** Per-day total mini bars from the session's range-scoped byDay slice. */
function MiniBars({ session, startDay }: { session: SessionRollupView; startDay: string }): ReactNode {
  const days = Object.entries(session.byDay)
    .filter(([day]) => day >= startDay)
    .sort(([left], [right]) => left.localeCompare(right))
  if (days.length === 0) return null
  const max = Math.max(...days.map(([, contribution]) => contribution.totals.totalTokens), 0)
  if (max <= 0) return null
  return (
    <div className={css.miniBars}>
      {days.map(([day, contribution]) => (
        <span key={day} className={css.tipAnchor}>
          <span
            className={css.miniBar}
            style={{ height: `${Math.max(4, (contribution.totals.totalTokens / max) * 40)}px` }}
          />
          <span className={css.tip}>
            <span className={css.tooltipHead}>{day}</span>
            <span className={css.tooltipLine}>{formatTokens(contribution.totals.totalTokens)}</span>
          </span>
        </span>
      ))}
    </div>
  )
}

export function SessionList({
  sessions, startDay, selectedDay, expandedSession, onExpand, openSession, onClose, remote, locate, t,
}: SessionListProps): ReactNode {
  const filtered = useMemo(
    () => selectedDay === null ? sessions : sessions.filter(session => session.byDay[selectedDay] !== undefined),
    [sessions, selectedDay],
  )
  const locatedId = locate?.kind === 'session' ? locate.key : null
  // Truncated render (PRD §5.3-7): the fetch keeps up to 10k rollups, the DOM
  // shows the first page until the user asks for the rest.
  const [showAll, setShowAll] = useState(false)
  const visible = showAll ? filtered : filtered.slice(0, SESSION_PAGE)

  // FR-13 scan: one live run at a time, invalidated by a monotonically
  // increasing token on collapse / session switch / unmount. Unary
  // traceBatch calls cannot be cancelled — stale answers are discarded.
  const [scan, setScan] = useState<ScanState | null>(null)
  const scanRun = useRef(0)
  useEffect(() => {
    scanRun.current += 1
    setScan(null)
    return () => { scanRun.current += 1 }
  }, [expandedSession])

  const startScan = (session: SessionRollupView): void => {
    const run = scanRun.current + 1
    scanRun.current = run
    // `turns` is a COUNT; the highest actual turn number is `latestTurn`
    // (zero-attempt turns are dropped by the fold).
    const latest = session.latestTurn ?? session.turns
    const batches = batchTurnNumbers(latest, SCAN_BATCH_TURNS)
    setScan({ sessionId: session.sessionId, phase: 'running', done: 0, total: latest, findings: [], message: null })
    void (async () => {
      const findings: LongResultFinding[] = []
      let done = 0
      for (const batch of batches) {
        try {
          const answered = await remote.traceBatch(session.sessionId, batch)
          if (scanRun.current !== run) return
          if (!answered.ok) {
            setScan({
              sessionId: session.sessionId, phase: 'failed', done, total: latest,
              findings: [...findings], message: `${answered.error.code}: ${answered.error.message}`,
            })
            return
          }
          findings.push(...scanTurns(answered.value))
          findings.sort((left, right) =>
            right.tokens - left.tokens || left.turn - right.turn || left.tool.localeCompare(right.tool))
          done = batch[batch.length - 1] ?? done
          setScan({ sessionId: session.sessionId, phase: 'running', done, total: latest, findings: [...findings], message: null })
        } catch (caught: unknown) {
          if (scanRun.current !== run) return
          setScan({
            sessionId: session.sessionId, phase: 'failed', done, total: latest,
            findings: [...findings], message: caught instanceof Error ? caught.message : String(caught),
          })
          return
        }
      }
      if (scanRun.current !== run) return
      setScan({ sessionId: session.sessionId, phase: 'done', done, total: latest, findings, message: null })
    })()
  }

  return (
    <section className={css.section} data-section="sessions">
      <div className={css.sectionTitle}>{t('dashboard.session.title')}</div>
      {filtered.length === 0
        ? <div className={css.muted}>{t('dashboard.session.none')}</div>
        : (
            <>
              <div className={css.sessionList}>
                {visible.map(session => {
                  const stats = sessionRangeStats(session, startDay)
                  const expanded = expandedSession === session.sessionId
                  const located = locatedId === session.sessionId
                  const shares = Object.entries(stats.byComponent).filter(([, tokens]) => tokens > 0)
                    .sort((left, right) => right[1] - left[1])
                  const topKey = shares[0]?.[0]
                  const suggestions = expanded ? deriveSessionSuggestions(session) : []
                  return (
                    <div key={session.sessionId} className={css.sessionBlock}>
                      <button
                        type="button"
                        className={expanded || located ? `${css.sessionRow} ${css.sessionRowOpen}` : css.sessionRow}
                        data-locate={located ? `session:${session.sessionId}` : undefined}
                        aria-expanded={expanded}
                        onClick={() => { onExpand(expanded ? null : session.sessionId) }}
                      >
                        <span className={css.sessionId}>{shortId(session.sessionId)}</span>
                        <span className={css.sessionMeta}>
                          {utcDay(session.firstAt)}
                          {' ~ '}
                          {utcDay(session.lastAt)}
                        </span>
                        <span className={css.sessionStat}>{t('summary.turns')} {stats.turns}</span>
                        <span className={css.sessionStat}>{t('summary.totalTokens')} {formatTokens(stats.totals.totalTokens)}</span>
                        <span className={css.sessionStat}>{t('summary.cacheHit')} {formatRatio(cacheHitRatio(stats.totals))}</span>
                        {topKey !== undefined
                          ? (
                              <span className={css.sessionStat}>
                                {t('dashboard.session.top')} {labelForKey(topKey, t)}
                              </span>
                            )
                          : null}
                      </button>
                      {expanded
                        ? (
                            <div className={css.sessionDetail}>
                              <MiniBars session={session} startDay={startDay} />
                              {/* Silence must be legible: when the engine finds
                                  no pathology, say so — an expanded session with
                                  only buttons reads as "no verdict". */}
                              {suggestions.length === 0
                                ? <div className={css.muted}>{t('dashboard.session.healthy')}</div>
                                : suggestions.map(suggestion => (
                                    <SuggestionRow key={suggestion.ruleId} suggestion={suggestion} t={t} />
                                  ))}
                            {/* FR-13: explicit on-demand scan — traceBatch replays
                                the session log per batch, so this never runs
                                automatically on expand. */}
                            {scan === null || scan.sessionId !== session.sessionId
                              ? (
                                  <button
                                    type="button"
                                    className={css.openButton}
                                    onClick={() => { startScan(session) }}
                                  >
                                    {t('dashboard.scan.action')}
                                  </button>
                                )
                              : (
                                  <div className={css.scanBox}>
                                    <div className={css.scanHead}>
                                      {scan.phase === 'running'
                                        ? <span className={css.muted}>{t('dashboard.scan.running', { done: scan.done, total: scan.total })}</span>
                                        : <span className={css.scanTitle}>{t('dashboard.scan.head', { threshold: LONG_RESULT_TOKENS })}</span>}
                                      {scan.phase !== 'running'
                                        ? (
                                            <button
                                              type="button"
                                              className={css.openButton}
                                              onClick={() => { startScan(session) }}
                                            >
                                              {t('dashboard.refresh')}
                                            </button>
                                          )
                                        : null}
                                    </div>
                                    {scan.phase === 'failed'
                                      ? <div className={css.errorText}>{t('dashboard.scan.failed', { message: scan.message ?? '' })}</div>
                                      : null}
                                    {scan.phase !== 'running' && scan.findings.length > 0
                                      ? (
                                          <div className={css.scanList}>
                                            {scan.findings.map(finding => (
                                              <div key={`${finding.turn}:${finding.tool}`} className={css.scanRow}>
                                                <span className={css.sessionId}>#{finding.turn}</span>
                                                <span className={css.sessionMeta}>s{finding.step}</span>
                                                <span className={css.scanTool}>{finding.tool}</span>
                                                <span className={css.scanTokens}>{formatTokens(finding.tokens)}</span>
                                              </div>
                                            ))}
                                          </div>
                                        )
                                      : null}
                                    {scan.phase === 'done' && scan.findings.length === 0
                                      ? <div className={css.muted}>{t('dashboard.scan.none', { threshold: LONG_RESULT_TOKENS })}</div>
                                      : null}
                                  </div>
                                )}
                            <button
                              type="button"
                              className={css.openButton}
                              onClick={() => {
                                openSession(session.sessionId)
                                onClose()
                              }}
                            >
                              {t('dashboard.session.open')} →
                            </button>
                          </div>
                        )
                      : null}
                  </div>
                )
              })}
              </div>
              {!showAll && filtered.length > SESSION_PAGE
                ? (
                    <button type="button" className={css.openButton} onClick={() => { setShowAll(true) }}>
                      {t('dashboard.session.more', { count: filtered.length })}
                    </button>
                  )
                : null}
            </>
          )}
    </section>
  )
}
