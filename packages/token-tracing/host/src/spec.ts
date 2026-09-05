/**
 * The token-tracing durable domain: zod schemas for the persisted rollups and
 * the `defineDomain` spec the service opens. Only aggregates are durable —
 * per-turn traces are rebuilt on demand from the platform's own session log.
 * @module @qihongmu/dsh-plugins-token-tracing/src/spec
 */

import { z } from 'zod'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { SessionRollupView } from './types.ts'

/** Session id schema; branding has no runtime representation. */
const sessionId = z.string().transform(SessionId)

/** Usage buckets at the durable boundary; every field is a safe non-negative integer. */
export const usageBuckets = z.object({
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  totalTokens: z.number().int().min(0),
  cacheReadTokens: z.number().int().min(0).optional(),
  cacheWriteTokens: z.number().int().min(0).optional(),
  reasoningTokens: z.number().int().min(0).optional(),
})

const contribution = z.object({
  turns: z.number().int().min(0),
  incompleteTurns: z.number().int().min(0),
  totals: usageBuckets,
  byComponent: z.record(z.string(), z.number()),
  byTool: z.record(z.string(), z.number()),
})

/** Day keys are `YYYY-MM-DD` (UTC); contributions must be non-negative. */
const dayKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

/**
 * Durable per-session aggregate. `totals` is exact provider usage;
 * `byComponent`/`byTool` are calibrated estimates (see rollup.ts for口径).
 */
export const sessionRollupRecord = z.object({
  sessionId,
  sessionCreatedAt: z.number().int().min(0),
  engine: z.number().int().min(1).optional(),
  lastSeq: z.number().int().min(0),
  latestTurn: z.number().int().min(0).optional(),
  turns: z.number().int().min(0),
  incompleteTurns: z.number().int().min(0),
  totals: usageBuckets,
  byComponent: z.record(z.string(), z.number()),
  byTool: z.record(z.string(), z.number()),
  byDay: z.record(dayKey, contribution),
  firstAt: z.number().int().min(0),
  lastAt: z.number().int().min(0),
})

export type SessionRollupRecord = z.infer<typeof sessionRollupRecord>

export function toRecord(rollup: SessionRollupView): SessionRollupRecord {
  return rollup as SessionRollupRecord
}

export function fromRecord(record: SessionRollupRecord): SessionRollupView {
  return record as SessionRollupView
}

/**
 * The token-tracing domain spec: one `sessions` table keyed by session id.
 *
 * `per-record` layout — one document per session rollup (`<root>/token_tracing/
 * sessions/<sessionId>.json`, dsh rc.1): a stale or malformed record document
 * reads as absent instead of bricking the whole unit, and the whole-unit file
 * written by plugin builds before this layout change one-time-bootstraps into
 * the record tree (stored unit version is still 1; the legacy file itself is
 * never modified). Session ids are path-safe by construction — the platform's
 * own persistence uses them as path segments, and its projection cache runs
 * the same per-record table shape.
 *
 * `invalidRecords: 'backup-and-skip'` — rollups are disposable derived data:
 * every record is rebuildable from the platform session log via the `backfillAll`
 * Remote method. A record whose document is format-valid but fails its zod
 * schema after a plugin upgrade (schema drift) is moved aside to
 * `<key>.json.bak.<stamp>` and skipped, so one bad record can never block a
 * boot; authoritative domains keep the rejecting default. On backends without
 * `backupRecord` (no per-record document to move) the loud path is preserved.
 */
export const tokenTracingDomainSpec = defineDomain({
  name: 'token_tracing',
  version: 1,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: {
    sessions: domainTable<SessionRollupView['sessionId'], SessionRollupRecord>(sessionRollupRecord),
  },
})
