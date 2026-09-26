/**
 * Client-face type for the plugin's `tokenTracing` Remote namespace.
 *
 * The generated descriptors (runtime) live in the host package's `./remote`
 * artifact; this source-level module carries the namespace's TYPE so
 * `ctx.remote.tokenTracing` widens through the merge-extensible
 * `TypertRemoteNamespaceMap`. Kept in sync with host/src/types.ts and the
 * vendored `typert.remote-client` artifacts (including the `follow` stream).
 * @module @qihongmu/dsh-client-ui-token-tracing/client/remote-namespace
 */
import type { RemoteResult, RemoteStreamHandle } from '@deepseek-ai/dsh-typert-protocol'
import type {
  DayRollupView,
  RollupQuery,
  SessionRollupView,
  TokenTraceFrame,
  TurnTrace,
} from '@qihongmu/dsh-plugins-token-tracing/types'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespace$746f6b656e54726163696e67 {
    backfillAll: () => Promise<RemoteResult<{ processed: number }>>
    days: (query: RollupQuery) => Promise<RemoteResult<DayRollupView[]>>
    follow: (sessionId: string, signal?: AbortSignal) => RemoteStreamHandle<TokenTraceFrame, never>
    sessions: (query: RollupQuery) => Promise<RemoteResult<SessionRollupView[]>>
    summary: (sessionId: string) => Promise<RemoteResult<SessionRollupView>>
    trace: (sessionId: string, turn: number) => Promise<RemoteResult<TurnTrace>>
    traceBatch: (sessionId: string, turns: number[]) => Promise<RemoteResult<TurnTrace[]>>
  }
  interface TypertRemoteMap {
    'tokenTracing/backfillAll': () => Promise<RemoteResult<{ processed: number }>>
    'tokenTracing/days': (query: RollupQuery) => Promise<RemoteResult<DayRollupView[]>>
    'tokenTracing/follow': (sessionId: string, signal?: AbortSignal) => RemoteStreamHandle<TokenTraceFrame, never>
    'tokenTracing/sessions': (query: RollupQuery) => Promise<RemoteResult<SessionRollupView[]>>
    'tokenTracing/summary': (sessionId: string) => Promise<RemoteResult<SessionRollupView>>
    'tokenTracing/trace': (sessionId: string, turn: number) => Promise<RemoteResult<TurnTrace>>
    'tokenTracing/traceBatch': (sessionId: string, turns: number[]) => Promise<RemoteResult<TurnTrace[]>>
  }
  interface TypertRemoteNamespaceMap {
    'tokenTracing': TypertRemoteNamespace$746f6b656e54726163696e67
  }
}
