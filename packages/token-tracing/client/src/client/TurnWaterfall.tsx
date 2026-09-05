/**
 * Token-usage waterfall for one turn: a row per attempt, prompt composition
 * (or increment) stacked left, output split text/reasoning right. Pure SVG +
 * CSS Modules (no charting library — none exists in the platform). Clicking a
 * row selects it for the drill-down panel. Hover uses a custom tooltip layer
 * (native SVG <title> needs a long dwell and renders unstyled).
 * @module @qihongmu/dsh-client-ui-token-tracing/src/client/TurnWaterfall
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import type {
  AttemptTrace,
  ComponentSplit,
  TurnTrace,
} from '@qihongmu/dsh-plugins-token-tracing/types'
import { formatTokens } from './format.ts'
import { aggregateByKind, COMPONENT_COLORS, isFoldable, kindLabel, segmentKey } from './component-meta.ts'
import { LONG_RESULT_TOKENS } from './dashboard/suggest.ts'
import styles from './TurnWaterfall.module.css'
import type { Translate } from './translate.ts'

/** Legend entries in display order. */
const LEGEND_KINDS = ['system-prompt', 'tool-definitions', 'user-input', 'tool-result', 'assistant-output', 'reasoning'] as const

/** Fixed pixel row geometry — the SVG renders at real container pixels (no viewBox scaling). */
const ROW_HEIGHT = 34
const LABEL_WIDTH = 64
const OUTPUT_WIDTH = 160
const GAP = 4

/** Width of the folded placeholder block (FR-14) — the gap it leaves shows the true scale. */
const FOLD_WIDTH = 20

interface Props {
  trace: TurnTrace
  t: Translate
  selectedSeq: number | null
  onSelect: (seq: number | null) => void
}

interface HoverState {
  x: number
  y: number
  lines: string[]
}

/** Scale merged splits proportionally to `total`, returning positioned segments. */
function normalizeSplits(
  splits: ReadonlyArray<{ split: ComponentSplit; count: number }>,
  total: number,
): Array<{ kind: string; name?: string; tokens: number; basis: ComponentSplit['basis']; start: number; width: number; count: number }> {
  if (total <= 0 || splits.length === 0) return []
  const sum = splits.reduce((acc, entry) => acc + entry.split.tokens, 0)
  const scale = sum > 0 ? total / sum : 1
  let cursor = 0
  return splits.map(entry => {
    const width = Math.max(0, Math.round(entry.split.tokens * scale))
    const segment = {
      kind: entry.split.kind,
      ...(entry.split.name === undefined ? {} : { name: entry.split.name }),
      tokens: entry.split.tokens,
      basis: entry.split.basis,
      start: cursor,
      width,
      count: entry.count,
    }
    cursor += width
    return segment
  })
}

/**
 * One attempt row: a left stack (prompt side) and a right output split
 * (text yellow + reasoning orange over a neutral track). Rendered at real
 * container pixels — the caller measures the width.
 */
function AttemptRow({
  attempt,
  row,
  width,
  maxPrompt,
  maxOutput,
  view,
  selected,
  onSelect,
  onHover,
  onLeave,
  expandedFolds,
  onToggleFold,
  t,
}: {
  attempt: AttemptTrace
  /** Row position within the waterfall — the y offset comes from this, NOT the turn number. */
  row: number
  /** Measured container width in px. */
  width: number
  maxPrompt: number
  maxOutput: number
  view: 'increment' | 'composition'
  selected: boolean
  onSelect: (seq: number | null) => void
  onHover: (event: ReactMouseEvent, lines: string[]) => void
  onLeave: () => void
  /** FR-14 fold keys currently expanded by the user (over-threshold ones default folded). */
  expandedFolds: ReadonlySet<string>
  onToggleFold: (key: string) => void
  t: Translate
}): ReactNode {
  const promptTotal = attempt.promptTotal ?? 0
  const outputTotal = attempt.usage?.outputTokens ?? 0
  const rawSplits = view === 'increment' ? attempt.additions : attempt.composition
  const merged = rawSplits === null ? [] : aggregateByKind(rawSplits)
  const segments = normalizeSplits(merged, promptTotal)

  const outputWidth = Math.min(OUTPUT_WIDTH, Math.max(60, width * 0.25))
  const promptTrack = Math.max(100, width - LABEL_WIDTH - outputWidth - GAP * 2)
  const promptScale = maxPrompt > 0 ? promptTrack / maxPrompt : 1
  const outputScale = maxOutput > 0 ? outputWidth / maxOutput : 1

  const promptWidth = Math.min(promptTotal * promptScale, promptTrack)
  const rowClass = selected ? `${styles.row} ${styles.rowSelected}` : styles.row
  const invalidated = attempt.invalidated === true ? ` ${styles.rowInvalidated}` : ''

  const segmentLines = (kind: string, name: string | undefined, tokens: number, basis: string, count: number): string[] => {
    const head = name === undefined ? kindLabel(kind, t) : `${kindLabel(kind, t)}·${name}`
    const lines = [`${head} · ${formatTokens(tokens)} · ${basis === 'exact' ? t('basis.exact') : t('basis.estimated')}`]
    if (count > 1) lines.push(t('tooltip.segments', { count }))
    return lines
  }

  return (
    <g
      className={rowClass + invalidated}
      transform={`translate(0, ${row * ROW_HEIGHT})`}
      onClick={() => onSelect(selected ? null : attempt.seq)}
      role="button"
      tabIndex={0}
      aria-label={`${t('attempt.step')} ${attempt.step} · prompt ${formatTokens(promptTotal)} · output ${formatTokens(outputTotal)}`}
    >
      <text x={2} y={ROW_HEIGHT / 2} className={styles.labelText}>{attempt.kind === 'compaction' ? '⧉' : `s${attempt.step}`}</text>
      {/* prompt stack */}
      <rect
        x={LABEL_WIDTH}
        y={6}
        width={Math.max(promptWidth, 1)}
        height={ROW_HEIGHT - 12}
        rx={3}
        className={styles.promptBase}
      />
      {segments.map(segment => {
        const left = LABEL_WIDTH + Math.min(segment.start * promptScale, promptWidth)
        const segWidth = Math.max(1, Math.min(segment.width * promptScale, promptWidth - (left - LABEL_WIDTH)))
        const key = segmentKey(segment.kind, segment.name)
        const foldable = isFoldable(segment.kind, segment.tokens, LONG_RESULT_TOKENS)
        const head = segment.name === undefined ? kindLabel(segment.kind, t) : `${kindLabel(segment.kind, t)}·${segment.name}`
        // FR-14: over-threshold tool-result segments fold into a placeholder
        // until expanded; the gap they leave keeps the row scale honest.
        if (foldable && !expandedFolds.has(key)) {
          return (
            <g
              key={key}
              role="button"
              tabIndex={0}
              aria-label={`${head} ${formatTokens(segment.tokens)} — ${t('waterfall.fold.expandHint')}`}
              className={styles.foldHit}
              onClick={event => { event.stopPropagation(); onToggleFold(key) }}
              onKeyDown={event => {
                if (event.key === 'Enter' || event.key === ' ') { event.stopPropagation(); onToggleFold(key) }
              }}
            >
              <rect
                x={left}
                y={6}
                width={FOLD_WIDTH}
                height={ROW_HEIGHT - 12}
                rx={2}
                fill={COMPONENT_COLORS[segment.kind] ?? '#9aa0a6'}
                className={styles.foldPlaceholder}
                onMouseMove={event => onHover(event, [...segmentLines(segment.kind, segment.name, segment.tokens, segment.basis, segment.count), t('waterfall.fold.expandHint')])}
                onMouseLeave={onLeave}
              />
              <text x={left + FOLD_WIDTH / 2} y={ROW_HEIGHT / 2 + 1} textAnchor="middle" className={styles.foldGlyph}>»</text>
            </g>
          )
        }
        return (
          <g key={key}>
            <rect
              x={left}
              y={6}
              width={segWidth}
              height={ROW_HEIGHT - 12}
              rx={2}
              fill={COMPONENT_COLORS[segment.kind] ?? '#9aa0a6'}
              opacity={0.85}
              onMouseMove={event => onHover(event, segmentLines(segment.kind, segment.name, segment.tokens, segment.basis, segment.count))}
              onMouseLeave={onLeave}
            />
            {foldable
              ? (
                  <g
                    role="button"
                    tabIndex={0}
                    aria-label={t('waterfall.fold.collapseHint')}
                    className={styles.foldHit}
                    onClick={event => { event.stopPropagation(); onToggleFold(key) }}
                    onKeyDown={event => {
                      if (event.key === 'Enter' || event.key === ' ') { event.stopPropagation(); onToggleFold(key) }
                    }}
                  >
                    <rect
                      x={left}
                      y={6}
                      width={12}
                      height={ROW_HEIGHT - 12}
                      fill={COMPONENT_COLORS[segment.kind] ?? '#9aa0a6'}
                      className={styles.foldHandle}
                      onMouseMove={event => onHover(event, [t('waterfall.fold.collapseHint')])}
                      onMouseLeave={onLeave}
                    />
                    <text x={left + 6} y={ROW_HEIGHT / 2 + 1} textAnchor="middle" className={styles.foldGlyphLight}>«</text>
                  </g>
                )
              : null}
          </g>
        )
      })}
      {/* output segment: text (yellow) + reasoning (orange) over a neutral track */}
      {(() => {
        const reasoning = attempt.usage?.reasoningTokens ?? 0
        const textOut = Math.max(0, outputTotal - reasoning)
        const trackX = width - outputWidth
        const barWidth = Math.max(outputTotal * outputScale, 1)
        const textWidth = Math.min(Math.max(textOut * outputScale, textOut > 0 ? 1 : 0), barWidth)
        const reasoningWidth = Math.min(Math.max(reasoning * outputScale, reasoning > 0 ? 1 : 0), barWidth - textWidth)
        return (
          <>
            <rect
              x={trackX} y={6} width={barWidth} height={ROW_HEIGHT - 12} rx={3}
              className={styles.outputBase}
              onMouseMove={event => onHover(event, [`${t('component.assistant-output')} · ${formatTokens(outputTotal)}`])}
              onMouseLeave={onLeave}
            />
            {textOut > 0
              ? (
                  <rect
                    x={trackX} y={6} width={textWidth} height={ROW_HEIGHT - 12} rx={2}
                    fill={COMPONENT_COLORS['assistant-output']} opacity={0.9}
                    onMouseMove={event => onHover(event, [`${t('component.assistant-output')} · ${formatTokens(textOut)} · ${t('basis.exact')}`])}
                    onMouseLeave={onLeave}
                  />
                )
              : null}
            {reasoning > 0
              ? (
                  <rect
                    x={trackX + textWidth} y={6} width={reasoningWidth} height={ROW_HEIGHT - 12} rx={2}
                    fill={COMPONENT_COLORS.reasoning} opacity={0.9}
                    onMouseMove={event => onHover(event, [`${t('component.reasoning')} · ${formatTokens(reasoning)} · ${t('basis.exact')}`])}
                    onMouseLeave={onLeave}
                  />
                )
              : null}
          </>
        )
      })()}
    </g>
  )
}

/**
 * The waterfall: rows are attempts in seq order; x axis is tokens. Increment
 * view stacks `additions` (the exact prompt deltas, one segment per node);
 * composition view aggregates the full request composition by component kind.
 */
export function TurnWaterfall({ trace, t, selectedSeq, onSelect }: Props): ReactNode {
  const [view, setView] = useState<'increment' | 'composition'>('increment')
  const [hover, setHover] = useState<HoverState | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)
  // FR-14: fold keys the user expanded (over-threshold tool-result segments
  // start folded). Keyed by kind/name across the whole waterfall — expanding
  // a tool once reveals it in every attempt row. Persists across view
  // switches; keys are view-independent.
  const [expandedFolds, setExpandedFolds] = useState<ReadonlySet<string>>(new Set())
  const toggleFold = (key: string): void => {
    setExpandedFolds(previous => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  const wrapRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(720)

  // The SVG renders at real container pixels (no viewBox scaling): a fixed
  // viewBox would stretch rows/text ~3x on a wide conversation pane.
  useEffect(() => {
    const element = wrapRef.current
    if (element === null) return
    const observer = new ResizeObserver(entries => {
      const next = entries[0]?.contentRect.width
      if (next !== undefined && next > 0) setWidth(Math.round(next))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const { maxPrompt, maxOutput } = useMemo(() => {
    let maxPrompt = 0
    let maxOutput = 0
    for (const attempt of trace.attempts) {
      maxPrompt = Math.max(maxPrompt, attempt.promptTotal ?? 0)
      maxOutput = Math.max(maxOutput, attempt.usage?.outputTokens ?? 0)
    }
    return { maxPrompt, maxOutput }
  }, [trace])

  const height = trace.attempts.length * ROW_HEIGHT + 8

  const showHover = (event: ReactMouseEvent, lines: string[]): void => {
    const rect = wrapRef.current?.getBoundingClientRect()
    setHover({
      x: event.clientX - (rect?.left ?? 0),
      y: event.clientY - (rect?.top ?? 0),
      lines,
    })
  }
  const hideHover = (): void => setHover(null)

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <div className={styles.legend}>
        <span className={styles.title}>{t('view.tokenTrace')}</span>
        <button
          type="button"
          className={view === 'increment' ? `${styles.viewButton} ${styles.viewButtonActive}` : styles.viewButton}
          onClick={() => { setView('increment'); setHover(null) }}
        >
          {t('attempt.additions')}
        </button>
        <button
          type="button"
          className={view === 'composition' ? `${styles.viewButton} ${styles.viewButtonActive}` : styles.viewButton}
          onClick={() => { setView('composition'); setHover(null) }}
        >
          {t('attempt.composition')}
        </button>
        <span className={styles.spacer} />
        {LEGEND_KINDS.map(kind => (
          <span key={kind} className={styles.legendItem}>
            <span className={styles.legendDot} style={{ background: COMPONENT_COLORS[kind] }} />
            <span className={styles.legendLabel}>{kindLabel(kind, t)}</span>
          </span>
        ))}
        <button
          type="button"
          className={helpOpen ? `${styles.helpButton} ${styles.helpButtonActive}` : styles.helpButton}
          aria-label={t('help.toggle')}
          onClick={() => setHelpOpen(open => !open)}
        >
          ?
        </button>
      </div>
      {helpOpen
        ? (
            <div className={styles.helpPanel}>
              <div className={styles.helpRow}><span className={styles.helpKey}>{t('help.requestSideTitle')}</span>{t('help.requestSide')}</div>
              <div className={styles.helpRow}><span className={styles.helpKey}>{t('help.outputSideTitle')}</span>{t('help.outputSide')}</div>
              <div className={styles.helpRow}><span className={styles.helpKey}>{t('help.basisTitle')}</span>{t('help.basis')}</div>
            </div>
          )
        : null}
      <svg width={width} height={height} className={styles.svg}>
        {trace.attempts.map((attempt, row) => (
          <AttemptRow
            key={attempt.seq}
            attempt={attempt}
            row={row}
            width={width}
            maxPrompt={maxPrompt}
            maxOutput={maxOutput}
            view={view}
            selected={selectedSeq === attempt.seq}
            onSelect={onSelect}
            onHover={showHover}
            onLeave={hideHover}
            expandedFolds={expandedFolds}
            onToggleFold={toggleFold}
            t={t}
          />
        ))}
      </svg>
      {hover !== null
        ? (
            <div
              className={styles.tooltip}
              style={{ left: Math.min(hover.x + 12, width - 180), top: Math.max(hover.y - 34, 0) }}
            >
              {hover.lines.map((line, index) => (
                <div key={index} className={index === 0 ? styles.tooltipHead : styles.tooltipLine}>{line}</div>
              ))}
            </div>
          )
        : null}
    </div>
  )
}
