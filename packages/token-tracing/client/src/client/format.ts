/** Pure display formatters for the token-tracing tab. */

/** Compact token count: `840`, `12.4k`, `3.18M`. */
export function formatTokens(value: number): string {
  const abs = Math.abs(value)
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

/** Token count or an em dash when the provider never reported the bucket. */
export function formatOptional(value: number | undefined): string {
  return value === undefined ? '—' : formatTokens(value)
}

/** 0–1 ratio as a percentage string; null-safe for missing denominators. */
export function formatRatio(ratio: number | undefined): string {
  if (ratio === undefined || !Number.isFinite(ratio)) return '—'
  return `${Math.round(ratio * 100)}%`
}

/** Cache hit ratio from usage buckets; undefined when the prompt side is unknown. */
export function cacheHitRatio(usage: { inputTokens: number; cacheReadTokens?: number; totalTokens: number; outputTokens: number } | null): number | undefined {
  if (usage === null || usage.cacheReadTokens === undefined) return undefined
  const prompt = usage.totalTokens - usage.outputTokens
  if (prompt <= 0) return undefined
  return usage.cacheReadTokens / prompt
}
