/**
 * Shared component-kind metadata for the token-tracing UI: stable colors,
 * localized display names, and same-kind aggregation. Used by both the
 * waterfall and the step drill-down rows.
 * @module @qihongmu/dsh-client-ui-token-tracing/src/client/component-meta
 */

import type { ComponentSplit } from '@qihongmu/dsh-plugins-token-tracing/types'
import type { TokenTracingKey } from './locales.ts'
import type { Translate } from './translate.ts'

/** Stable color per component kind, shared with the legend and tooltips. */
export const COMPONENT_COLORS: Record<string, string> = {
  'system-prompt': '#8ea9c9',
  'tool-definitions': '#b0b7c3',
  'user-input': '#4d8ef7',
  'injected-context': '#8b7cf6',
  'runtime-context': '#6ea8dc',
  'tool-result': '#c78bf6',
  'assistant-output': '#f6c44d',
  reasoning: '#f6a05c',
  compaction: '#e27c7c',
  'context-shrink': '#e27c7c',
  unattributed: '#9aa0a6',
}

/**
 * Localized display name for one component kind — the locale keys mirror the
 * ComponentKind union one-to-one (`component.<kind>`); unknown kinds fall
 * through to the unattributed label.
 */
export function kindLabel(kind: string, t: Translate): string {
  const key = `component.${kind in COMPONENT_COLORS ? kind : 'unattributed'}` as TokenTracingKey
  return t(key)
}

/** Head label for one split: localized kind, plus the tool/source name when present. */
export function splitLabel(split: { kind: string; name?: string }, t: Translate): string {
  return split.name === undefined ? kindLabel(split.kind, t) : `${kindLabel(split.kind, t)}·${split.name}`
}

/**
 * Merge same-kind splits into one entry each (named components like tool
 * results per tool keep one entry per name); returns entries in first-seen
 * order with a segment count for the "+N 段" style hints.
 */
/** Composite segment key: kind, or `kind/name` for named components. */
export function segmentKey(kind: string, name: string | undefined): string {
  return name === undefined ? kind : `${kind}/${name}`
}

/**
 * FR-14: a tool-result segment above the oversized threshold folds into a
 * placeholder block until expanded. The threshold is passed in (no import of
 * the dashboard module from here) — both features share
 * `LONG_RESULT_TOKENS` from dashboard/suggest.ts as their single source, so
 * the waterfall folds exactly the results the dashboard flags as oversized.
 */
export function isFoldable(kind: string, tokens: number, threshold: number): boolean {
  return kind === 'tool-result' && tokens > threshold
}

export function aggregateByKind(splits: readonly ComponentSplit[]): Array<{ split: ComponentSplit; count: number }> {
  const order: string[] = []
  const merged = new Map<string, { split: ComponentSplit; count: number }>()
  for (const split of splits) {
    const key = segmentKey(split.kind, split.name)
    const existing = merged.get(key)
    if (existing === undefined) {
      order.push(key)
      merged.set(key, { split: { ...split }, count: 1 })
    } else {
      existing.split.tokens += split.tokens
      existing.count += 1
    }
  }
  return order.map(key => merged.get(key) as { split: ComponentSplit; count: number })
}
