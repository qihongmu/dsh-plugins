/**
 * FR-13 (P2): oversized tool-result scanning for the session detail. Pure
 * and transport-free — the component feeds it `traceBatch` answers, one
 * batch at a time, and renders the ordered findings. A finding is a
 * tool-result component whose tokens are strictly above the threshold,
 * deduplicated per turn (a cache invalidation re-sends the same result in a
 * later series-start composition — the recomposition reports it again; the
 * max observation is the honest number).
 * @module @qihongmu/dsh-client-ui-token-tracing/src/client/dashboard/scan
 */

import type { AttemptTrace, TurnTrace } from '@qihongmu/dsh-plugins-token-tracing/types'
import { LONG_RESULT_TOKENS, SCAN_BATCH_TURNS } from './suggest.ts'

/** One oversized tool result, located for governance (US-M3-9). */
export interface LongResultFinding {
  turn: number
  /** The attempt (`s{n}` in the waterfall) where the max was observed. */
  step: number
  /** Tool name from the component split. */
  tool: string
  tokens: number
}

/**
 * Scan turn traces for tool-result components above `threshold`. The
 * effective composition of an attempt is `composition` (series starts) or
 * `additions` (in-series attempts); attempts with neither contribute
 * nothing. Dedup per (turn, tool) keeps the max observation; results sort by
 * tokens descending, then turn, then tool.
 */
export function scanTurns(traces: readonly TurnTrace[], threshold: number = LONG_RESULT_TOKENS): LongResultFinding[] {
  const best = new Map<string, LongResultFinding>()
  for (const trace of traces) {
    for (const attempt of trace.attempts) {
      collect(attempt, trace.turn, threshold, best)
    }
  }
  return [...best.values()].sort((left, right) =>
    right.tokens - left.tokens || left.turn - right.turn || left.tool.localeCompare(right.tool))
}

function collect(attempt: AttemptTrace, turn: number, threshold: number, best: Map<string, LongResultFinding>): void {
  const split = attempt.composition ?? attempt.additions
  if (split === null) return
  for (const component of split) {
    if (component.kind !== 'tool-result' || component.tokens <= threshold) continue
    const tool = component.name ?? ''
    const key = `${turn}\u0000${tool}`
    const previous = best.get(key)
    if (previous === undefined || component.tokens > previous.tokens) {
      best.set(key, { turn, step: attempt.step, tool, tokens: component.tokens })
    }
  }
}

/** Turn numbers `1..latest` in ascending batches of `size` (empty for latest < 1). */
export function batchTurnNumbers(latest: number, size: number = SCAN_BATCH_TURNS): number[][] {
  const batches: number[][] = []
  for (let start = 1; start <= latest; start += size) {
    const batch: number[] = []
    for (let turn = start; turn < start + size && turn <= latest; turn += 1) batch.push(turn)
    batches.push(batch)
  }
  return batches
}
