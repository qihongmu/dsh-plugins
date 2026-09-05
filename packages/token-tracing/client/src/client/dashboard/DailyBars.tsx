/**
 * Dashboard daily stacked bars (inline SVG — the platform has no charting
 * library): one column per UTC day of the selected range, stacked by
 * component kind with the shared waterfall palette. Zero-filled days render
 * as a faint baseline tick so the trend shape stays continuous. Hover shows
 * a custom tooltip (M2 waterfall pattern); clicking a day toggles the
 * session-list filter.
 * @module @qihongmu/dsh-client-ui-token-tracing/src/client/dashboard/DailyBars
 */

import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { DayRollupView } from '@qihongmu/dsh-plugins-token-tracing/types'
import { COMPONENT_COLORS, kindLabel } from '../component-meta.ts'
import { formatTokens } from '../format.ts'
import type { Translate } from '../translate.ts'
import type { SuggestionEvidence } from './suggest.ts'
import css from './Dashboard.module.css'

/** Fixed stacking order (bottom → top) shared with the mini session bars. */
export const STACK_ORDER: readonly string[] = [
  'system-prompt', 'tool-definitions', 'user-input', 'injected-context',
  'runtime-context', 'tool-result', 'assistant-output', 'reasoning',
  'compaction', 'unattributed',
]

export interface StackSegment {
  kind: string
  tokens: number
}

/**
 * Aggregate a row's byComponent map into positive per-kind segments in the
 * fixed stack order. Composite `kind/name` keys fold into their kind prefix;
 * negative values (context-shrink) are skipped — the stack is an estimated
 * request-side composition, while numeric totals stay exact elsewhere.
 */
export function stackSegments(row: DayRollupView): StackSegment[] {
  const byKind = new Map<string, number>()
  for (const [key, tokens] of Object.entries(row.byComponent)) {
    if (tokens <= 0) continue
    const kind = key.includes('/') ? key.slice(0, key.indexOf('/')) : key
    byKind.set(kind, (byKind.get(kind) ?? 0) + tokens)
  }
  const segments: StackSegment[] = []
  for (const kind of STACK_ORDER) {
    const tokens = byKind.get(kind)
    if (tokens !== undefined) segments.push({ kind, tokens })
  }
  for (const [kind, tokens] of byKind) {
    if (!STACK_ORDER.includes(kind)) segments.push({ kind, tokens })
  }
  return segments
}

interface DailyBarsProps {
  /** Ascending zero-fill skeleton of the current period's day keys. */
  dayKeys: readonly string[]
  /** Current-period rows (sparse — only days with activity). */
  rows: readonly DayRollupView[]
  selectedDay: string | null
  onSelectDay: (day: string | null) => void
  locate: SuggestionEvidence | null
  t: Translate
}

const HEIGHT = 120
const COLUMN = 16
const COLUMN_GAP = 4
const PAD = 4

export function DailyBars({ dayKeys, rows, selectedDay, onSelectDay, locate, t }: DailyBarsProps): ReactNode {
  const [hover, setHover] = useState<number | null>(null)
  const rowsByDay = useMemo(() => new Map(rows.map(row => [row.day, row])), [rows])
  const maxTotal = useMemo(() => {
    let max = 0
    for (const row of rows) {
      const total = stackSegments(row).reduce((acc, segment) => acc + segment.tokens, 0)
      if (total > max) max = total
    }
    return max
  }, [rows])

  const width = dayKeys.length * COLUMN
  const hoverRow = hover === null ? undefined : rowsByDay.get(dayKeys[hover] ?? '')
  const locatedDay = locate?.kind === 'day' ? locate.key : null
  // Axis labels: at most ~8 evenly spaced day marks.
  const axisStep = Math.max(1, Math.ceil(dayKeys.length / 8))

  return (
    <div className={css.barsWrap}>
      <svg
        className={css.barsSvg}
        viewBox={`0 0 ${width} ${HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={t('dashboard.daily.title')}
      >
        {dayKeys.map((dayKey, index) => {
          const row = rowsByDay.get(dayKey)
          const segments = row === undefined ? [] : stackSegments(row)
          let y = HEIGHT - PAD
          const isSelected = selectedDay === dayKey
          const isLocated = locatedDay === dayKey
          return (
            <g key={dayKey}>
              {segments.map((segment, segmentIndex) => {
                const height = Math.max(1, (segment.tokens / maxTotal) * (HEIGHT - PAD * 2))
                y -= height
                return (
                  <rect
                    key={segmentIndex}
                    x={index * COLUMN + COLUMN_GAP / 2}
                    y={y}
                    width={COLUMN - COLUMN_GAP}
                    height={height}
                    fill={COMPONENT_COLORS[segment.kind] ?? COMPONENT_COLORS.unattributed}
                  />
                )
              })}
              {row === undefined
                ? <rect x={index * COLUMN + COLUMN_GAP / 2} y={HEIGHT - 2} width={COLUMN - COLUMN_GAP} height={2} className={css.emptyCol} />
                : null}
              {isSelected || isLocated
                ? (
                    <rect
                      x={index * COLUMN}
                      y={0}
                      width={COLUMN}
                      height={HEIGHT}
                      className={isSelected ? css.colSelected : css.colLocated}
                    />
                  )
                : null}
              <rect
                x={index * COLUMN}
                y={0}
                width={COLUMN}
                height={HEIGHT}
                fill="transparent"
                data-locate={isLocated ? `day:${dayKey}` : undefined}
                onPointerEnter={() => { setHover(index) }}
                onPointerLeave={() => { setHover(previous => previous === index ? null : previous) }}
                onClick={() => { onSelectDay(row === undefined ? null : dayKey) }}
              />
            </g>
          )
        })}
      </svg>
      <div className={css.axis}>
        {dayKeys.map((dayKey, index) => (
          <span key={dayKey} className={css.axisLabel}>
            {index % axisStep === 0 ? dayKey.slice(5) : ''}
          </span>
        ))}
      </div>
      {hover !== null && hoverRow !== undefined
        ? (
            <div className={css.tooltip} style={{ left: `${((hover + 0.5) / dayKeys.length) * 100}%` }}>
              <div className={css.tooltipHead}>{dayKeys[hover] ?? ''}</div>
              {stackSegments(hoverRow).map(segment => (
                <div key={segment.kind} className={css.tooltipLine}>
                  {kindLabel(segment.kind, t)}
                  {' '}
                  {formatTokens(segment.tokens)}
                </div>
              ))}
              <div className={css.tooltipLine}>
                {t('dashboard.daily.total')}
                {' '}
                {formatTokens(hoverRow.totals.totalTokens)}
              </div>
            </div>
          )
        : null}
    </div>
  )
}
