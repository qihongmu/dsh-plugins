/**
 * Package-owned invariant companion for the external scheduled-task UI plugin.
 * @module @deepseek-ai/dsh-client-ui-scheduled-task/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-scheduled-task'

/** Cordis invariant-companion plugin name. */
export const name = 'scheduled-task-ui-invariant'
/** Service required before reserving this package's invariant ownership. */
export const inject = ['invariants']

/**
 * Owned relation: the client half is pure presentation over the hosted
 * `scheduledTasks` Remote; it owns no durable or event relationship, so the
 * companion installs no invariant.
 */
const install: InvariantInstaller = Object.assign(
  () => undefined,
  { inject: [] },
)

/**
 * Register the package-owned invariant companion.
 * @param ctx - Cordis context carrying the invariant registry.
 * @returns Exact registration disposer after child setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
