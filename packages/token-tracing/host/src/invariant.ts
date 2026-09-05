/**
 * Package-owned invariant companion for the external token-tracing plugin.
 * @module @qihongmu/dsh-plugins-token-tracing/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'
import type { SessionRollupRecord } from './spec.ts'

const PACKAGE_NAME = '@qihongmu/dsh-plugins-token-tracing'

/** Cordis invariant-companion plugin name. */
export const name = 'token-tracing-invariant'
/** Service required before reserving this package's invariant ownership. */
export const inject = ['invariants']

/**
 * Owned relationship: a persisted rollup never reports more incomplete turns
 * than turns, and its usage totals never report output exceeding the exact
 * total (prompt + output ≥ output by definition). Either violation proves a
 * write path bypassed the fold/rollup arithmetic.
 */
const install: InvariantInstaller = Object.assign(
  (ctx: Context, fail: (message: string) => never) => {
    ctx.on('domain/changed', (change: DomainChanged) => {
      if (change.domain !== 'token_tracing' || change.table !== 'sessions' || change.operation !== 'put') return
      const record = change.value as SessionRollupRecord
      if (record.incompleteTurns > record.turns) {
        fail(`token tracing rollup for '${record.sessionId}' reports more incomplete turns than turns`)
      }
      if (record.totals.totalTokens < record.totals.outputTokens) {
        fail(`token tracing rollup for '${record.sessionId}' reports output tokens exceeding total tokens`)
      }
    })
  },
  { inject: [] },
)

/**
 * Register the package-owned invariant companion.
 * @param ctx - Cordis context carrying the invariant registry.
 * @returns Exact registration disposer after child setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
