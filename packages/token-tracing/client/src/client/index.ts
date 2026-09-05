/**
 * External token-tracing browser half: registers a `conversation.view`
 * session tab (per-turn trace) and a `sidebar.footer.action` entry opening
 * the M3 full-page cross-session dashboard — both fold data through the
 * plugin's `tokenTracing` Remote namespace, provided by the sibling remotes
 * assembly entry (`@qihongmu/dsh-client-remotes-token-tracing`), which
 * activates first.
 * @module @qihongmu/dsh-client-ui-token-tracing/client
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: the assembly import widens `ctx.remote` on `Context`.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: widens `ctx.sessions` on `Context` (the M3 session deep link).
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: the renderer's `Context` merge provides `ctx.slots`.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the `sidebar.footer.action` SlotMap row (declared by
// ui-sidebar) so the M3 dashboard trigger registration types.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { en, NS, zh } from './locales.ts'
import type { TokenTracingKey } from './locales.ts'
import { TokenTraceView } from './TokenTraceView.tsx'
import { TokenDashboardEntry } from './dashboard/DashboardEntry.tsx'
import type { TokenDashboardFace, TokenTraceViewFace } from './slots.ts'

// Merge the plugin's locale namespace into the shared map at the register site
// (the bundle resolves the built d.ts, so the augmentation must be co-located
// with the register call for `keyof LocaleNamespaceMap` to widen here).
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'token-tracing': TokenTracingKey
  }
}

export { TokenTraceView } from './TokenTraceView.tsx'
export { TokenDashboardEntry } from './dashboard/DashboardEntry.tsx'
export type { TokenDashboardFace, TokenTraceViewFace, TokenTracingRemote } from './slots.ts'

/**
 * Required services: the slot system, locale, the Remote key, the
 * `remote.tokenTracing` namespace provided by the remotes assembly entry,
 * and the `sessions` service backing the dashboard's session deep link.
 */
export const inject = ['slots', 'locale', 'remote', 'remote.tokenTracing', 'sessions']

/** Register the token-tracing tab and the M3 dashboard entry over the mounted Remote namespace. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-token-tracing: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'token-trace',
    order: 15,
    locale: NS,
    label: () => t('view.tokenTrace'),
    inject: (): TokenTraceViewFace => ({
      remote: ctx.remote.tokenTracing,
    }),
  }, TokenTraceView))
  // M3 dashboard: sidebar footer trigger + full-page surface (see
  // DashboardEntry). The deep link stages the session via the platform's
  // `sessions` service; the rollup's session ids are plain strings, hence
  // the single branded-id cast at this boundary.
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'token-dashboard',
    order: 100,
    locale: NS,
    label: () => t('dashboard.title'),
    inject: (): TokenDashboardFace => ({
      remote: ctx.remote.tokenTracing,
      openSession: (sessionId: string) => { ctx.sessions.open(sessionId as SessionId) },
    }),
  }, TokenDashboardEntry))
}
