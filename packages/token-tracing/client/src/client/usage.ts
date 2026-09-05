/**
 * Usage-bucket math shared by the live trace state (trace-state.ts) and the
 * dashboard aggregation (dashboard/aggregate.ts): one implementation of the
 * "optional bucket survives only when reported" rule both used to carry.
 * @module @qihongmu/dsh-client-ui-token-tracing/src/client/usage
 */

import type { UsageBuckets } from '@qihongmu/dsh-plugins-token-tracing/types'

/**
 * Sum usage buckets. The three mandatory buckets always sum; each optional
 * bucket (cacheRead / cacheWrite / reasoning) survives only when at least
 * one entry reported it.
 */
export function sumUsageBuckets(entries: readonly UsageBuckets[]): UsageBuckets {
  let inputTokens = 0
  let outputTokens = 0
  let totalTokens = 0
  let hasRead = false
  let hasWrite = false
  let hasReasoning = false
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  let reasoningTokens = 0
  for (const usage of entries) {
    inputTokens += usage.inputTokens
    outputTokens += usage.outputTokens
    totalTokens += usage.totalTokens
    if (usage.cacheReadTokens !== undefined) {
      hasRead = true
      cacheReadTokens += usage.cacheReadTokens
    }
    if (usage.cacheWriteTokens !== undefined) {
      hasWrite = true
      cacheWriteTokens += usage.cacheWriteTokens
    }
    if (usage.reasoningTokens !== undefined) {
      hasReasoning = true
      reasoningTokens += usage.reasoningTokens
    }
  }
  const buckets: UsageBuckets = { inputTokens, outputTokens, totalTokens }
  if (hasRead) buckets.cacheReadTokens = cacheReadTokens
  if (hasWrite) buckets.cacheWriteTokens = cacheWriteTokens
  if (hasReasoning) buckets.reasoningTokens = reasoningTokens
  return buckets
}
