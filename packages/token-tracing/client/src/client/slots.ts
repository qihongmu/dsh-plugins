/**
 * Injected face + Remote typing for the external token-tracing tab.
 */

import type { TypertRemoteNamespaceMap } from '@deepseek-ai/dsh-typert-protocol'
// Type-only: pulls the `conversation.view` SlotMap row (declared by the slot's
// owning package) so the register call types.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the Remote assembly's `Context` merge (ctx.remote).
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the tokenTracing namespace merge lives in the sibling source
// module (d.ts-side augmentation does not merge under the 0.1.7 dts layout).
import type {} from './remote-namespace.ts'

/** The typed `tokenTracing` Remote namespace the tab drives. */
export type TokenTracingRemote = TypertRemoteNamespaceMap['tokenTracing']

/**
 * Registrant-private injected share (arrives via the register inject factory):
 * the live Remote namespace. The bound session id arrives through the
 * session-scoped slot's standard props, not the inject face.
 */
export interface TokenTraceViewFace {
  readonly remote: TokenTracingRemote
}

/**
 * Injected share of the M3 dashboard footer entry: the same Remote namespace
 * plus the session deep-link (ctx.sessions.open) for the 会话 list.
 */
export interface TokenDashboardFace {
  readonly remote: TokenTracingRemote
  /** Open a session in the conversation view (closes the dashboard). */
  readonly openSession: (sessionId: string) => void
}
