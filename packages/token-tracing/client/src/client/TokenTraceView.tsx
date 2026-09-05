/**
 * Token-tracing conversation tab: session summary, the live turn, the
 * completed-turn list, a per-attempt waterfall with a drill-down, and JSON
 * export. Waterfall rows use per-attempt SVG (no charting library — none
 * exists in the platform); hover tooltips and the help panel are custom.
 * @module @qihongmu/dsh-client-ui-token-tracing/src/client/TokenTraceView
 */

import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  AttemptTrace,
  ComponentSplit,
  SessionRollupView,
  TurnTrace,
} from '@qihongmu/dsh-plugins-token-tracing/types'
import { cacheHitRatio, formatOptional, formatRatio, formatTokens } from './format.ts'
import { aggregateByKind, splitLabel } from './component-meta.ts'
import { mergeAttempt, turnCacheHitRatio, upsertTurn } from './trace-state.ts'
import { TurnWaterfall } from './TurnWaterfall.tsx'
import styles from './TokenTraceView.module.css'
import type { TokenTraceViewFace } from './slots.ts'

export interface TokenTraceViewProps
  extends PropsRuntime<'conversation.view'>,
  InjectFace<TokenTraceViewFace>,
  PropsLocale<'token-tracing'> {}

type Translate = TokenTraceViewProps['t']

interface StatProps {
  label: string
  value: string
}

function Stat({ label, value }: StatProps): ReactNode {
  return (
    <div className={styles.stat}>
      <span className={styles.statValue}>{value}</span>
      <span className={styles.statLabel}>{label}</span>
    </div>
  )
}

function BasisBadge({ basis, t }: { basis: ComponentSplit['basis']; t: Translate }): ReactNode {
  return (
    <span className={basis === 'exact' ? styles.badgeExact : styles.badgeEstimated}>
      {t(basis === 'exact' ? 'basis.exact' : 'basis.estimated')}
    </span>
  )
}

interface SplitsProps {
  title: string
  splits: readonly ComponentSplit[] | null
  t: Translate
}

function Splits({ title, splits, t }: SplitsProps): ReactNode {
  const [expanded, setExpanded] = useState(false)
  if (splits === null || splits.length === 0) return null
  // Same-kind splits (one per historical message/tool call) merge into one
  // localized entry per kind/name; the count hints at how many segments merged.
  const merged = aggregateByKind(splits)
    .map(entry => ({ ...entry, label: splitLabel(entry.split, t) }))
    .sort((left, right) => Math.abs(right.split.tokens) - Math.abs(left.split.tokens))
  const cap = 5
  const visible = expanded ? merged : merged.slice(0, cap)
  const rest = merged.length - visible.length
  return (
    <div className={styles.splits}>
      <span className={styles.splitsTitle}>{title}</span>
      {visible.map((entry, index) => (
        <span key={`${entry.split.kind}/${entry.split.name ?? ''}/${index}`} className={styles.split}>
          {entry.label}
          {' '}
          {formatTokens(entry.split.tokens)}
          {entry.count > 1 ? <span className={styles.segmentCount}> {t('tooltip.segments', { count: entry.count })}</span> : null}
          <BasisBadge basis={entry.split.basis} t={t} />
        </span>
      ))}
      {rest > 0
        ? (
            <button
              type="button"
              className={styles.expandButton}
              onClick={() => setExpanded(expanded => !expanded)}
            >
              {expanded ? t('action.collapse') : t('action.expandAll', { count: rest })}
            </button>
          )
        : null}
    </div>
  )
}

interface AttemptRowProps {
  attempt: AttemptTrace
  t: Translate
}

function AttemptRow({ attempt, t }: AttemptRowProps): ReactNode {
  const kindLabel = attempt.kind === 'compaction' ? t('attempt.kind.compaction') : t('attempt.kind.llm')
  return (
    <div className={attempt.invalidated === true ? `${styles.attempt} ${styles.attemptInvalidated}` : styles.attempt}>
      <div className={styles.attemptHead}>
        <span className={styles.attemptStep}>{t('attempt.step')} {attempt.step}</span>
        <span>{kindLabel}</span>
        {attempt.retry === true ? <span className={styles.badgeWarn}>{t('attempt.retry')}</span> : null}
        {attempt.invalidated === true ? <span className={styles.badgeWarn}>{t('attempt.invalidated')}</span> : null}
        {attempt.usage === null ? <span className={styles.muted}>{t('attempt.noUsage')}</span> : (
          <>
            <span>{t('attempt.tokens')} {formatTokens(attempt.usage.totalTokens)}</span>
            <span>{t('attempt.prompt')} {formatTokens(attempt.promptTotal ?? 0)}</span>
            <span>{t('attempt.cacheHit')} {formatRatio(cacheHitRatio(attempt.usage))}</span>
          </>
        )}
      </div>
      <Splits title={t('attempt.additions')} splits={attempt.additions} t={t} />
      <Splits title={t('attempt.composition')} splits={attempt.composition} t={t} />
    </div>
  )
}

/** Download `data` as a JSON file (PRD story 19: session trace export). */
function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

/**
 * The tab body: subscribes to the follow stream for this session, renders the
 * aggregate summary, the live turn, and the completed-turn drill-down.
 */
export function TokenTraceView(props: TokenTraceViewProps): ReactNode {
  const { remote, sessionId, t } = props
  const [summary, setSummary] = useState<SessionRollupView | null>(null)
  const [active, setActive] = useState<TurnTrace | null>(null)
  const [turns, setTurns] = useState<readonly TurnTrace[]>([])
  const [historyLoading, setHistoryLoading] = useState(true)
  const [selected, setSelected] = useState<TurnTrace | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    setSummary(null)
    setActive(null)
    setTurns([])
    setSelected(null)
    setError(null)
    setHistoryLoading(true)
    void (async () => {
      try {
        for await (const frame of remote.follow(sessionId, controller.signal)) {
          if (frame.kind === 'snapshot') {
            setSummary(frame.summary)
            setActive(frame.activeTurn)
            // One batched replay on the host returns all requested turns —
            // per-turn calls would replay the whole session log each time.
            // `turns` on the rollup is a COUNT (zero-attempt turns are dropped
            // by the fold); the highest actual turn number is `latestTurn`.
            const latest = frame.summary.latestTurn ?? frame.summary.turns
            const from = Math.max(1, latest - 10)
            const requested: number[] = []
            for (let turn = latest; turn >= from; turn -= 1) requested.push(turn)
            const loaded: TurnTrace[] = []
            if (requested.length > 0) {
              const response = await remote.traceBatch(sessionId, requested)
              if (response.ok) loaded.push(...response.value)
            }
            if (!controller.signal.aborted) {
              setTurns(loaded.sort((left, right) => right.turn - left.turn))
              setHistoryLoading(false)
            }
          } else if (frame.kind === 'turn') {
            setTurns(previous => upsertTurn(previous, frame.trace))
            setActive(previous => previous !== null && previous.turn === frame.trace.turn ? null : previous)
          } else {
            setActive(previous => mergeAttempt(previous, frame.attempt))
          }
        }
      } catch (thrown: unknown) {
        if (!controller.signal.aborted) {
          setError(thrown instanceof Error ? thrown.message : String(thrown))
        }
      }
    })()
    return () => controller.abort()
  }, [remote, sessionId])

  const totals = summary?.totals
  const rows = useMemo(() => turns.map(trace => (
    <button
      key={trace.turn}
      type="button"
      className={selected !== null && selected.turn === trace.turn
        ? `${styles.turnRow} ${styles.turnRowSelected}`
        : styles.turnRow}
      onClick={() => setSelected(trace)}
    >
      <span className={styles.turnNumber}>#{trace.turn}</span>
      <span className={trace.status === 'complete' ? styles.badge : styles.badgeWarn}>
        {trace.status === 'complete' ? t('turn.complete') : t('turn.incomplete')}
      </span>
      {/* totals === null means the provider never reported usage for this turn
        * (interrupted/crashed) — show an explicit dash instead of a fake 0. */}
      {trace.totals === null
        ? <span className={styles.muted}>{t('turn.noUsage')}</span>
        : (
            <>
              <span>{t('summary.totalTokens')} {formatTokens(trace.totals.totalTokens)}</span>
              <span>{t('attempt.cacheHit')} {formatRatio(turnCacheHitRatio(trace))}</span>
            </>
          )}
    </button>
  )), [turns, selected, t])

  if (error !== null) {
    return (
      <div className={styles.view} data-conversation-composer-overlay="">
        <div className={styles.scroll}><div className={styles.error}>{t('panel.readFailed', { message: error })}</div></div>
      </div>
    )
  }
  if (summary === null) {
    return (
      <div className={styles.view} data-conversation-composer-overlay="">
        <div className={styles.scroll}><div className={styles.muted}>{t('panel.loading')}</div></div>
      </div>
    )
  }
  if (summary.turns === 0 && active === null && !historyLoading) {
    return (
      <div className={styles.view} data-conversation-composer-overlay="">
        <div className={styles.scroll}><div className={styles.muted}>{t('panel.empty')}</div></div>
      </div>
    )
  }
  return (
    <div className={styles.view} data-conversation-composer-overlay="">
      <div className={styles.scroll}>
        <div className={styles.summary}>
          <Stat label={t('summary.turns')} value={String(summary.turns)} />
          <Stat label={t('summary.totalTokens')} value={formatTokens(totals?.totalTokens ?? 0)} />
          <Stat label={t('summary.inputTokens')} value={formatTokens(totals?.inputTokens ?? 0)} />
          <Stat label={t('summary.outputTokens')} value={formatTokens(totals?.outputTokens ?? 0)} />
          {totals?.reasoningTokens !== undefined
            ? <Stat label={t('summary.reasoningTokens')} value={formatOptional(totals.reasoningTokens)} />
            : null}
          <Stat label={t('summary.cacheHit')} value={formatRatio(cacheHitRatio(totals ?? null))} />
          <Stat label={t('summary.cacheRead')} value={formatOptional(totals?.cacheReadTokens)} />
          {totals?.cacheWriteTokens !== undefined
            ? <Stat label={t('summary.cacheWrite')} value={formatOptional(totals.cacheWriteTokens)} />
            : null}
        </div>
        {active !== null && active.attempts.length > 0
          ? (
              <div className={styles.section}>
                <div className={styles.sectionTitle}>{t('turn.active')}</div>
                {active.attempts.map(attempt => <AttemptRow key={attempt.seq} attempt={attempt} t={t} />)}
              </div>
            )
          : null}
        <div className={styles.section}>
          <div className={styles.sectionTitle}>{t('turn.list')}</div>
          {historyLoading
            ? <div className={styles.muted}>{t('turn.loading')}</div>
            : rows.length === 0 ? <div className={styles.muted}>{t('turn.empty')}</div> : rows}
        </div>
      {selected !== null
        ? (
            <div className={styles.section}>
              <div className={styles.sectionTitle}>
                #{selected.turn}
                <button
                  type="button"
                  className={styles.exportButton}
                  onClick={() => downloadJson(
                    `token-trace-${selected.sessionId || sessionId}-${selected.turn}.json`,
                    { kind: 'dsh-token-trace', version: 1, sessionId, exportedAt: new Date().toISOString(), trace: selected },
                  )}
                >
                  {t('action.exportJson')}
                </button>
              </div>
              <TurnWaterfall
                trace={selected}
                t={t}
                selectedSeq={null}
                onSelect={() => {}}
              />
              {selected.attempts.map(attempt => <AttemptRow key={attempt.seq} attempt={attempt} t={t} />)}
            </div>
          )
        : null}
      </div>
    </div>
  )
}
