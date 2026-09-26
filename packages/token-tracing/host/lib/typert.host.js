/* Vendored by hand for this external plugin (the DSH generator cannot see
 * external repos — see FEASIBILITY.md). Host-face TYPERT manifest: the
 * invocation descriptors are the SAME objects the vendored client
 * contribution carries (single source of truth; the loader/registry
 * validation treats both faces identically for direct, non-lookup methods),
 * and `model` carries the minimal reflection face the loader accepts.
 * Kept in sync with host/src/types.ts and typert.remote-client.js.
 */
import TYPERT_REMOTE from './typert.remote-client.js'

export const TYPERT = {
  package: '@qihongmu/dsh-plugins-token-tracing',
  face: 'host',
  schemas: [],
  invocations: TYPERT_REMOTE.descriptors,
  model: {
    services: [
      {
        key: 'tokenTracing',
        exportName: 'TokenTracingService',
        summary: 'Per-turn token tracing: durable rollups, fold engine, live trace stream.',
        tags: [],
        members: [
          { name: 'sessions', signature: '(query: RollupQuery) => Promise<RemoteResult<SessionRollupView[]>>', kind: 'method' },
          { name: 'summary', signature: '(sessionId: string) => Promise<RemoteResult<SessionRollupView>>', kind: 'method' },
          { name: 'trace', signature: '(sessionId: string, turn: number) => Promise<RemoteResult<TurnTrace>>', kind: 'method' },
          { name: 'traceBatch', signature: '(sessionId: string, turns: number[]) => Promise<RemoteResult<TurnTrace[]>>', kind: 'method' },
          { name: 'days', signature: '(query: RollupQuery) => Promise<RemoteResult<DayRollupView[]>>', kind: 'method' },
          { name: 'follow', signature: '(sessionId: string, signal?: AbortSignal) => RemoteStreamHandle<TokenTraceFrame, never>', kind: 'method' },
          { name: 'backfillAll', signature: '() => Promise<RemoteResult<{ processed: number }>>', kind: 'method' },
        ],
        types: [],
      },
    ],
    events: [],
    objects: [],
  },
}
