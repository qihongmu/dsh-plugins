/**
 * Dashboard component-composition panel (two-column left): request-side
 * share rows (estimated basis) plus a system-prompt per-day sparkline —
 * the aggregate answer to PRD story 9. The sparkline is readable, not just
 * a shape: the latest non-zero day sits next to the label and hovering a
 * day shows its value (a bare polyline had no numbers to read).
 * @module @qihongmu/dsh-client-ui-token-tracing/src/client/dashboard/ComponentPanel
 */

import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { DayRollupView } from '@qihongmu/dsh-plugins-token-tracing/types'
import { COMPONENT_COLORS } from '../component-meta.ts'
import { formatTokens } from '../format.ts'
import type { Translate } from '../translate.ts'
import { componentShares, dayAvgSystemPrompt, type ShareRow } from './aggregate.ts'
import { labelForKey } from './labels.ts'
import type { SuggestionEvidence } from './suggest.ts'
import css from './Dashboard.module.css'

interface ComponentPanelProps {
  components: Record<string, number>
  /** Ascending zero-fill skeleton of the current period's day keys. */
  dayKeys: readonly string[]
  rows: readonly DayRollupView[]
  locate: SuggestionEvidence | null
  t: Translate
}

const SPARK_HEIGHT = 30

export function ComponentPanel({ components, dayKeys, rows, locate, t }: ComponentPanelProps): ReactNode {
  const [hover, setHover] = useState<number | null>(null)
  const shares = useMemo(() => componentShares(components), [components])
  const locatedKey = locate?.kind === 'component' ? locate.key : null
  const spark = useMemo(() => {
    // Per-turn averages: the raw daily component total also tracks call
    // volume, which would drown the inflation signal this line exists for.
    const byDay = new Map(rows.map(row => [row.day, dayAvgSystemPrompt(row) ?? 0]))
    const values = dayKeys.map(dayKey => byDay.get(dayKey) ?? 0)
    const max = Math.max(...values, 0)
    if (max <= 0 || dayKeys.length < 2) return null
    const points = values
      .map((value, index) => `${(index / (dayKeys.length - 1)) * 100},${SPARK_HEIGHT - (value / max) * (SPARK_HEIGHT - 2) - 1}`)
      .join(' ')
    return { points, values }
  }, [rows, dayKeys])
  const sparkCount = spark?.values.length ?? 0
  // Latest non-zero day — "today" zero-fills when nothing ran yet.
  const latest = useMemo(() => {
    const values = spark?.values ?? []
    for (let index = values.length - 1; index >= 0; index -= 1) {
      const value = values[index]
      if (value !== undefined && value > 0) return value
    }
    return 0
  }, [spark])

  return (
    <section className={css.section}>
      <div className={css.sectionTitle}>{t('dashboard.components.title')}</div>
      {shares.length === 0
        ? <div className={css.muted}>{t('dashboard.empty.title')}</div>
        : (
            <div className={css.shareList}>
              {shares.map((share: ShareRow) => {
                // Evidence names a family (e.g. `injected-context`); rows are
                // its leaves — anchor the family's first visible row.
                const located = locatedKey !== null
                  && (share.key === locatedKey || share.key.startsWith(`${locatedKey}/`))
                return (
                  <div
                    key={share.key}
                    className={located ? `${css.shareRow} ${css.rowLocated}` : css.shareRow}
                    data-locate={located ? `component:${share.key}` : undefined}
                  >
                    <span className={css.dot} style={{ background: COMPONENT_COLORS[share.key.split('/')[0] ?? ''] ?? COMPONENT_COLORS.unattributed }} />
                    <span className={css.shareLabel}>{labelForKey(share.key, t)}</span>
                    <span className={css.shareTokens}>{formatTokens(share.tokens)}</span>
                    <span className={css.badgeEstimated}>{t('dashboard.legend.estimated')}</span>
                    <span className={css.shareRatio}>{Math.round(share.ratio * 100)}%</span>
                  </div>
                )
              })}
            </div>
          )}
      {spark !== null
        ? (
            <div className={css.spark}>
              <span className={css.tipAnchor}>
                <span className={css.sparkLabel}>{t('dashboard.components.trend')}</span>
                <span className={`${css.tip} ${css.tipWide}`}>
                  <span className={css.tooltipLine}>{t('dashboard.components.trendHelp')}</span>
                </span>
              </span>
              <span className={css.sparkLatest}>{t('dashboard.components.trendLatest', { value: formatTokens(latest) })}</span>
              <div className={css.sparkTrack}>
                <svg className={css.sparkSvg} viewBox={`0 0 100 ${SPARK_HEIGHT}`} preserveAspectRatio="none" aria-hidden="true">
                  <polyline points={spark.points} className={css.sparkLine} />
                  {spark.values.map((_value, index) => (
                    <rect
                      key={index}
                      x={(index / sparkCount) * 100}
                      y={0}
                      width={100 / sparkCount}
                      height={SPARK_HEIGHT}
                      fill="transparent"
                      onPointerEnter={() => { setHover(index) }}
                      onPointerLeave={() => { setHover(previous => previous === index ? null : previous) }}
                    />
                  ))}
                </svg>
                {hover !== null
                  ? (
                      <div className={css.sparkTip} style={{ left: `${((hover + 0.5) / Math.max(sparkCount, 1)) * 100}%` }}>
                        <span className={css.tooltipHead}>{dayKeys[hover]}</span>
                        <span className={css.tooltipLine}>{formatTokens(spark.values[hover] ?? 0)}</span>
                      </div>
                    )
                  : null}
              </div>
            </div>
          )
        : null}
    </section>
  )
}
