/**
 * Package-owned invariant companion for the UI half (nothing to assert
 * browser-side; ownership reserves the package slot only).
 * @module @qihongmu/dsh-client-ui-token-tracing/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@qihongmu/dsh-client-ui-token-tracing'

/** Cordis invariant-companion plugin name. */
export const name = 'token-tracing-ui-invariant'
/** Service required before reserving this package's invariant ownership. */
export const inject = ['invariants']

const install: InvariantInstaller = Object.assign(
  (_ctx: Context, _fail: (message: string) => never) => {},
  { inject: [] },
)

/**
 * Register the package-owned invariant companion.
 * @param ctx - Cordis context carrying the invariant registry.
 * @returns Exact registration disposer after child setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
