/**
 * External scheduled-tasks remotes assembly (browser half): mounts the
 * vendored `scheduledTasks` Remote contribution so the UI entry can consume
 * `ctx.remote.scheduledTasks` through a declared inject edge.
 * @module @qihongmu/dsh-client-remotes-scheduled-task/client
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import TYPERT_REMOTE from './remote-client.js'

/** Required service: the typed Client Remote contribution mount. */
export const inject = ['remote']

/**
 * Mount the scheduledTasks Remote namespaces for this plugin.
 * @param ctx - Client Cordis context carrying the typed API service.
 * @returns disposer after every mounted namespace is ready.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const disposeMount = await ctx.remote.$mount(TYPERT_REMOTE)
  return disposeMount
}