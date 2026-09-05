/**
 * Exact usage arithmetic shared by the fold engine and the rollups. Semantics
 * mirror the dsh token-meter's strict attempt normalization (tolerant here:
 * unprovable parts become null instead of discarding the whole disclosure).
 * @module @qihongmu/dsh-plugins-token-tracing/src/usage
 */

import type { TokenUsage } from '@deepseek-ai/dsh-llm/types'
import type { UsageBuckets } from './types.ts'

/**
 * Convert one harness `TokenUsage` (its `totalTokens` is optional) into the
 * plugin's required-total bucket shape, deriving the total the same way the
 * dsh token-meter does when the provider omitted it.
 */
export function toBuckets(usage: TokenUsage): UsageBuckets {
  const totalTokens = usage.totalTokens
  ?? usage.inputTokens + usage.outputTokens
  + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens,
    ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }),
    ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
  }
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * Prompt-side total of one attempt: `totalTokens - outputTokens` when the
 * provider gave an exact total, else the known prompt buckets. Mirrors the
 * dsh token-meter invariant `input + cacheRead + cacheWrite = full prompt`.
 * @param usage - provider usage; callers pass null before calling.
 * @returns the prompt total (0 is a valid empty report), or null when unprovable.
 */
export function promptTotalOf(usage: UsageBuckets): number | null {
  if (isCount(usage.totalTokens) && isCount(usage.outputTokens) && usage.totalTokens >= usage.outputTokens) {
    return usage.totalTokens - usage.outputTokens
  }
  if (!isCount(usage.inputTokens)) return null
  let known = usage.inputTokens
  for (const bucket of [usage.cacheReadTokens, usage.cacheWriteTokens]) {
    if (bucket === undefined) continue
    if (!isCount(bucket)) return null
    known += bucket
  }
  return known
}

/**
 * Per-bucket aggregation: each optional bucket sums every attempt that
 * REPORTS it, independently — some responses omit cacheRead/cacheWrite/
 * reasoning, and dropping a whole turn's reads from the aggregate because one
 * attempt omitted the field understated session-level cache numbers badly.
 */
export function sumUsages(usages: readonly (UsageBuckets | null)[]): UsageBuckets | null {
  if (usages.length === 0 || usages.some(usage => usage === null)) return null
  const known = usages as readonly UsageBuckets[]
  let inputTokens = 0
  let outputTokens = 0
  let totalTokens = 0
  for (const usage of known) {
    inputTokens += usage.inputTokens
    outputTokens += usage.outputTokens
    totalTokens += usage.totalTokens
  }
  const result: UsageBuckets = { inputTokens, outputTokens, totalTokens }
  const reportedRead = known.filter(usage => usage.cacheReadTokens !== undefined)
  if (reportedRead.length > 0) {
    result.cacheReadTokens = reportedRead.reduce((acc, usage) => acc + (usage.cacheReadTokens ?? 0), 0)
  }
  const reportedWrite = known.filter(usage => usage.cacheWriteTokens !== undefined)
  if (reportedWrite.length > 0) {
    result.cacheWriteTokens = reportedWrite.reduce((acc, usage) => acc + (usage.cacheWriteTokens ?? 0), 0)
  }
  const reportedReasoning = known.filter(usage => usage.reasoningTokens !== undefined)
  if (reportedReasoning.length > 0) {
    result.reasoningTokens = reportedReasoning.reduce((acc, usage) => acc + (usage.reasoningTokens ?? 0), 0)
  }
  return result
}

export function emptyBuckets(): UsageBuckets {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
}

export function addBuckets(target: UsageBuckets, addend: UsageBuckets): UsageBuckets {
  target.inputTokens += addend.inputTokens
  target.outputTokens += addend.outputTokens
  target.totalTokens += addend.totalTokens
  if (addend.cacheReadTokens !== undefined) {
    target.cacheReadTokens = (target.cacheReadTokens ?? 0) + addend.cacheReadTokens
  }
  if (addend.cacheWriteTokens !== undefined) {
    target.cacheWriteTokens = (target.cacheWriteTokens ?? 0) + addend.cacheWriteTokens
  }
  if (addend.reasoningTokens !== undefined) {
    target.reasoningTokens = (target.reasoningTokens ?? 0) + addend.reasoningTokens
  }
  return target
}
