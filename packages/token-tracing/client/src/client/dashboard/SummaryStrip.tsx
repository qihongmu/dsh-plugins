/**
 * Dashboard summary strip: exact bucket totals over the current period, each
 * with a period-over-period Δ badge. Totals are provider-exact (exact badge);
 * Δ badges color by whether the move is good for cost (tokens up = bad,
 * cache hit up = good). Δ badges carry an instant anchored hover tip (native
 * title needs a ~1s dwell) naming the comparison and the previous value.
 * @module @qihongmu/dsh-client-ui-token-tracing/src/client/dashboard/SummaryStrip
 */

import type { ReactNode } from 'react'
import type { DayRollupView, SessionRollupView } from '@qihongmu/dsh-plugins-token-tracing/types'
import { deltaRatio, sumDayBuckets } from './aggregate.ts'
import { cacheHitRatio, formatOptional, formatRatio, formatTokens } from '../format.ts'
import type { Translate } from '../translate.ts'
import css from './Dashboard.module.css'

interface SummaryStripProps {
  currentDays: readonly DayRollupView[]
  previousDays: readonly DayRollupView[]
  currentSessions: readonly SessionRollupView[]
  previousSessions: readonly SessionRollupView[]
  t: Translate
}

/** Δ badge: signed % vs the previous period; neutral dot when flat/no base. */
function Delta({ current, previous, goodWhenUp, format, t }: {
  current: number
  previous: number
  goodWhenUp: boolean
  /** Renders the previous period's value in the hover tip. */
  format: (value: number) => string
  t: Translate
}): ReactNode {
  const ratio = deltaRatio(current, previous)
  return (
    <span className={css.tipAnchor}>
      {ratio === undefined || Math.abs(ratio) < 0.005
        ? <span className={css.deltaFlat}>·</span>
        : (
            <span className={ratio > 0 === goodWhenUp ? css.deltaGood : css.deltaBad}>
              {ratio > 0 ? '↑' : '↓'}
              {' '}
              {Math.round(Math.abs(ratio) * 100)}%
            </span>
          )}
      <span className={css.tip}>
        <span className={css.tooltipHead}>{t('dashboard.prevPeriod')}</span>
        <span className={css.tooltipLine}>
          {t('dashboard.prevPeriod.previous', { value: previous > 0 ? format(previous) : '—' })}
        </span>
      </span>
    </span>
  )
}

export function SummaryStrip({ currentDays, previousDays, currentSessions, previousSessions, t }: SummaryStripProps): ReactNode {
  const totals = sumDayBuckets(currentDays)
  const previousTotals = sumDayBuckets(previousDays)
  const turns = currentDays.reduce((acc, row) => acc + row.turns, 0)
  const previousTurns = previousDays.reduce((acc, row) => acc + row.turns, 0)
  const hit = cacheHitRatio(totals)
  const previousHit = cacheHitRatio(previousTotals)
  return (
    <div className={css.statsGrid}>
      <div className={css.stat}>
        <span className={css.statValue}>
          {formatTokens(totals.totalTokens)}
          <Delta current={totals.totalTokens} previous={previousTotals.totalTokens} goodWhenUp={false} format={formatTokens} t={t} />
        </span>
        <span className={css.statLabel}>{t('summary.totalTokens')}</span>
      </div>
      <div className={css.stat}>
        <span className={css.statValue}>
          {formatTokens(totals.inputTokens)}
          <Delta current={totals.inputTokens} previous={previousTotals.inputTokens} goodWhenUp={false} format={formatTokens} t={t} />
        </span>
        <span className={css.statLabel}>{t('summary.inputTokens')}</span>
      </div>
      <div className={css.stat}>
        <span className={css.statValue}>
          {formatTokens(totals.outputTokens)}
          <Delta current={totals.outputTokens} previous={previousTotals.outputTokens} goodWhenUp={false} format={formatTokens} t={t} />
        </span>
        <span className={css.statLabel}>{t('summary.outputTokens')}</span>
      </div>
      {totals.reasoningTokens !== undefined
        ? (
            <div className={css.stat}>
              <span className={css.statValue}>
                {formatOptional(totals.reasoningTokens)}
                <Delta
                  current={totals.reasoningTokens}
                  previous={previousTotals.reasoningTokens ?? 0}
                  goodWhenUp={false}
                  format={formatTokens}
                  t={t}
                />
              </span>
              <span className={css.statLabel}>{t('summary.reasoningTokens')}</span>
            </div>
          )
        : null}
      <div className={css.stat}>
        <span className={css.statValue}>
          {formatRatio(hit)}
          <Delta current={hit ?? 0} previous={previousHit ?? 0} goodWhenUp={true} format={formatRatio} t={t} />
        </span>
        <span className={css.statLabel}>{t('summary.cacheHit')}</span>
      </div>
      <div className={css.stat}>
        <span className={css.statValue}>
          {String(currentSessions.length)}
          <Delta current={currentSessions.length} previous={previousSessions.length} goodWhenUp={false} format={String} t={t} />
        </span>
        <span className={css.statLabel}>{t('dashboard.summary.sessions')}</span>
      </div>
      <div className={css.stat}>
        <span className={css.statValue}>
          {String(turns)}
          <Delta current={turns} previous={previousTurns} goodWhenUp={false} format={String} t={t} />
        </span>
        <span className={css.statLabel}>{t('summary.turns')}</span>
      </div>
    </div>
  )
}
