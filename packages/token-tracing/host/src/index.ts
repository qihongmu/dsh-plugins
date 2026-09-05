/**
 * External token-tracing capability: folds the durable session event log into
 * per-attempt token attribution (exact usage, exact prompt deltas inside a
 * request series, calibrated composition estimates), maintains per-session
 * rollups in a storage domain, and serves queries plus a live stream to the
 * plugin's browser half. Reuses only shipped dsh API — no repo edits.
 * @module @qihongmu/dsh-plugins-token-tracing
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { SessionQueryEngine, SessionLogSnapshot } from '@deepseek-ai/dsh-session-query'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { SessionFolder } from './fold.ts'
import {
  applyMaintenanceToRollup,
  applyTurnToRollup,
  emptySessionRollup,
  mergeDayRollups,
} from './rollup.ts'
import { fromRecord, toRecord, tokenTracingDomainSpec } from './spec.ts'
import type { SessionRollupRecord } from './spec.ts'
import type {
  AttemptTrace,
  DayRollupView,
  RollupQuery,
  SessionRollupView,
  TokenTraceFrame,
  TurnTrace,
} from './types.ts'

export { SessionFolder } from './fold.ts'
export {
  applyMaintenanceToRollup,
  applyTurnToRollup,
  dayKeyOf,
  emptySessionRollup,
  mergeDayRollups,
} from './rollup.ts'
export { fromRecord, toRecord, tokenTracingDomainSpec, sessionRollupRecord, usageBuckets } from './spec.ts'
export type * from './types.ts'

/** Minimum spacing between live `attempt` frames for one session (turn frames are never throttled). */
const ATTEMPT_FRAME_MIN_MS = 500
/** Completed-trace cache entries kept in memory for `trace` re-reads. */
const TRACE_CACHE_CAPACITY = 32
/**
 * Fold-engine data version. Bump when produced rollup numbers change meaning
 * (e.g. optional-bucket aggregation fix, latestTurn field) so stored rows
 * re-backfill on boot.
 */
const ENGINE = 4

interface TraceSink {
  enqueue(frame: TokenTraceFrame): void
}

function renderThrown(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/**
 * Global token-tracing capability. The `sessions` storage-domain table is the
 * durable aggregate authority; folders, followers, and the trace cache are
 * disposable projections rebuilt from the platform's own session log.
 */
export class TokenTracingService extends TypertRemoteService {
  /** Services required before folds can be ingested or queried. */
  static inject = ['storageDomain', 'sessionQuery']

  private table?: KvTable<string, SessionRollupRecord>
  /** Live folders: full fold state per session seen this run (lazy or backfilled). */
  private readonly folders = new Map<string, SessionFolder>()
  private readonly followers = new Map<string, Set<TraceSink>>()
  private readonly traceCache = new Map<string, TurnTrace>()
  private readonly lastAttemptFrameAt = new Map<string, number>()
  private backfillPromise: Promise<number> | undefined

  constructor(ctx: Context) {
    super(ctx, 'tokenTracing')
  }

  /** Open the domain, subscribe to the session event feed, and start backfill. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(tokenTracingDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'token-tracing.domainClose')
    this.table = domain.table('sessions')
    this.ctx.on('session/event', (session, event) => this.ingest(session, event))
    void this.ensureBackfill()
  }

  // -------------------------------------------------------------- ingestion

  /** Fold one committed session event; never throws into the host. */
  private ingest(session: Session, event: SessionEvent): void {
    const id = String(session.id)
    try {
      let folder = this.folders.get(id)
      if (folder === undefined) {
        folder = this.makeFolder(id)
        this.folders.set(id, folder)
      }
      folder.ingest(event)
      // A compaction replace rewrites the surface the cached traces' compositions
      // were calibrated against — drop this session's cached traces.
      if (event.type === 'compaction/summary' || event.type === 'compaction/prune') {
        for (const key of [...this.traceCache.keys()]) {
          if (key.startsWith(`${id}#`)) this.traceCache.delete(key)
        }
      }
    } catch (error: unknown) {
      this.ctx.logger.warn(`token-tracing: could not ingest event for session "${id}": ${renderThrown(error)}`)
    }
  }

  /**
   * Folder for a session without a full-replay backfill: exact usage stays
   * exact, but the first attempts lack surface/history state and fall back to
   * calibrated composition. A restart's backfill heals the state wholesale.
   */
  private makeFolder(sessionId: string): SessionFolder {
    return new SessionFolder({
      sessionId,
      bufferTurns: true,
      maxBufferedTurns: 50,
      onAttempt: attempt => this.dispatchAttempt(sessionId, attempt),
      onTurnComplete: trace => void this.applyTurn(sessionId, trace),
      onMaintenance: attempt => void this.applyMaintenance(sessionId, attempt),
    })
  }

  /**
   * Read-modify-write the session rollup (shared by turn completion and
   * maintenance), stamping the engine version on every write.
   */
  private async persistRollup(
    sessionId: string,
    mutate: (rollup: SessionRollupView) => void,
  ): Promise<void> {
    try {
      const table = this.requireTable()
      const stored = table.get(sessionId)
      const rollup = stored !== undefined ? fromRecord(stored) : emptySessionRollup(sessionId, 0)
      mutate(rollup)
      rollup.engine = ENGINE
      await table.put(sessionId, toRecord(rollup))
    } catch (error: unknown) {
      this.ctx.logger.warn(`token-tracing: could not persist rollup for session "${sessionId}": ${renderThrown(error)}`)
    }
  }

  private async applyTurn(sessionId: string, trace: TurnTrace): Promise<void> {
    await this.persistRollup(sessionId, rollup => {
      applyTurnToRollup(rollup, trace)
      const lastAttemptSeq = trace.attempts[trace.attempts.length - 1]?.seq ?? 0
      rollup.lastSeq = Math.max(rollup.lastSeq, lastAttemptSeq)
    })
    this.dispatchTurn(sessionId, trace)
  }

  private applyMaintenance(sessionId: string, attempt: AttemptTrace): Promise<void> {
    return this.persistRollup(sessionId, rollup => {
      applyMaintenanceToRollup(rollup, attempt)
      rollup.lastSeq = Math.max(rollup.lastSeq, attempt.seq)
    })
  }

  // ---------------------------------------------------------------- dispatch

  private followersFor(sessionId: string): Set<TraceSink> {
    let set = this.followers.get(sessionId)
    if (set === undefined) {
      set = new Set()
      this.followers.set(sessionId, set)
    }
    return set
  }

  private dispatchTurn(sessionId: string, trace: TurnTrace): void {
    const frame: TokenTraceFrame = { kind: 'turn', trace }
    for (const sink of this.followersFor(sessionId)) sink.enqueue(frame)
  }

  private dispatchAttempt(sessionId: string, attempt: AttemptTrace): void {
    const now = Date.now()
    const last = this.lastAttemptFrameAt.get(sessionId) ?? 0
    if (now - last < ATTEMPT_FRAME_MIN_MS) return
    this.lastAttemptFrameAt.set(sessionId, now)
    const frame: TokenTraceFrame = { kind: 'attempt', sessionId, attempt }
    for (const sink of this.followersFor(sessionId)) sink.enqueue(frame)
  }

  // ------------------------------------------------------------ remote reads

  /**
   * List per-session rollups, most recently active first.
   * @param query - optional limit (default 50) and sinceDays recency filter.
   * @returns The stored rollups, newest activity first.
   */
  @Remote
  sessions(query?: RollupQuery): SessionRollupView[] {
    const sinceMs = query?.sinceDays === undefined ? undefined : Date.now() - query.sinceDays * 86_400_000
    const rows = [...this.requireTable().entries()]
      .map(([, record]) => fromRecord(record))
      .filter(row => sinceMs === undefined || row.lastAt >= sinceMs)
      .sort((left, right) =>
        right.lastAt - left.lastAt || left.sessionId.localeCompare(right.sessionId))
    return rows.slice(0, Math.max(0, query?.limit ?? 50))
  }

  /**
   * One session's rollup; a zeroed aggregate when nothing was traced yet.
   * @param sessionId - session to summarize.
   */
  @Remote
  summary(sessionId: string): SessionRollupView {
    const stored = this.requireTable().get(sessionId)
    return stored !== undefined ? fromRecord(stored) : emptySessionRollup(sessionId, 0)
  }

  /**
   * Rebuild one turn's trace from the platform session log (cached in memory).
   * @param sessionId - owning session.
   * @param turn - turn number inside that session.
   * @returns The trace, or null when the turn has no traceable attempts.
   */
  @Remote
  async trace(sessionId: string, turn: number): Promise<TurnTrace | null> {
    const traces = await this.traceBatch(sessionId, [turn])
    return traces[0] ?? null
  }

  /**
   * Rebuild several turns' traces in ONE session-log replay (a full replay per
   * turn makes history loading O(n·replay); batching makes it O(replay)).
   * @param sessionId - owning session.
   * @param turns - turn numbers to rebuild.
   * @returns The traces that exist, in the requested order; untraceable turns are omitted.
   */
  @Remote
  async traceBatch(sessionId: string, turns: readonly number[]): Promise<TurnTrace[]> {
    const found = new Map<number, TurnTrace>()
    const missing: number[] = []
    for (const turn of turns) {
      const cached = this.traceCache.get(`${sessionId}#${turn}`)
      if (cached !== undefined) {
        // Refresh LRU recency on hit.
        this.traceCache.delete(`${sessionId}#${turn}`)
        this.traceCache.set(`${sessionId}#${turn}`, cached)
        found.set(turn, cached)
      } else {
        missing.push(turn)
      }
    }
    if (missing.length > 0) {
      const folder = new SessionFolder({
        sessionId,
        bufferTurns: true,
        maxBufferedTurns: Number.MAX_SAFE_INTEGER,
      })
      for (const event of await this.readEvents(sessionId)) folder.ingest(event)
      for (const turn of missing) {
        const trace = folder.traceOf(turn) ?? folder.activeTraceOf(turn) ?? null
        if (trace === null) continue
        found.set(turn, trace)
        if (trace.status !== 'active') this.traceCache.set(`${sessionId}#${turn}`, trace)
      }
      this.evictTraceCache()
    }
    return turns.flatMap(turn => {
      const trace = found.get(turn)
      return trace === undefined ? [] : [trace]
    })
  }

  /**
   * Cross-session day rollups, newest day first.
   * @param query - optional limit (default 50) and sinceDays recency filter.
   */
  @Remote
  days(query?: RollupQuery): DayRollupView[] {
    return mergeDayRollups([...this.requireTable().entries()].map(([, record]) => fromRecord(record)), {
      limit: query?.limit ?? 50,
      ...(query?.sinceDays === undefined ? {} : { sinceDays: query.sinceDays }),
    })
  }

  /**
   * Live trace feed for one session: an immediate snapshot frame, then
   * attempt/turn frames as folding progresses. Attempt frames are throttled;
   * turn frames fire once per completed turn.
   */
  @Remote({ mode: 'stream' })
  async *follow(sessionId: string, signal: AbortSignal): AsyncIterable<TokenTraceFrame> {
    const queue: TokenTraceFrame[] = []
    let wake: (() => void) | undefined
    const sink: TraceSink = {
      enqueue: frame => {
        queue.push(frame)
        wake?.()
      },
    }
    this.followersFor(sessionId).add(sink)
    try {
      // Register BEFORE fetching the snapshot so no event falls into the gap;
      // frames that arrive while the snapshot is being read queue up, and the
      // snapshot is then pushed ahead of them (client upserts reconcile).
      const snapshot = await this.snapshotFrame(sessionId)
      queue.unshift(snapshot)
      while (!signal.aborted) {
        while (queue.length > 0) {
          const frame = queue.shift()
          if (frame !== undefined) yield frame
        }
        await new Promise<void>(resolve => {
          wake = resolve
          signal.addEventListener('abort', () => resolve(), { once: true })
        })
        wake = undefined
      }
    } finally {
      this.followers.get(sessionId)?.delete(sink)
    }
  }

  /**
   * Recompute rollups for every session whose stored aggregate lags its log.
   * Sessions already folded live this run are left to their live folder.
   * @returns How many sessions were recomputed.
   */
  @Remote
  async backfillAll(): Promise<{ processed: number }> {
    return { processed: await this.ensureBackfill() }
  }

  // ----------------------------------------------------------------- backfill

  private ensureBackfill(): Promise<number> {
    this.backfillPromise ??= this.runBackfill().catch(error => {
      this.ctx.logger.warn(`token-tracing: backfill failed: ${renderThrown(error)}`)
      return 0
    })
    return this.backfillPromise
  }

  /**
   * Full-replay recompute for lagging sessions. The replayed folder is kept as
   * the session's live folder, so post-restart events continue from complete
   * surface/history state instead of a cold start.
   */
  private async runBackfill(): Promise<number> {
    const query = this.sessionQuery()
    const records = await query.listSessions()
    let processed = 0
    for (const record of records) {
      const id = String(record.header.id)
      if (this.folders.has(id)) continue
      let snapshot: SessionLogSnapshot
      try {
        snapshot = await query.readSession(record.header.id)
      } catch (error: unknown) {
        this.ctx.logger.warn(`token-tracing: could not read session "${id}" for backfill: ${renderThrown(error)}`)
        continue
      }
      const stored = this.requireTable().get(id)
      const lastEvent = snapshot.events[snapshot.events.length - 1]
      const lastEventSeq = lastEvent === undefined ? 0 : lastEvent.seq
      // Up-to-date AND produced by the current engine version: skip. Old-version
      // rows recompute wholesale so fixed aggregation semantics apply retroactively.
      if (stored !== undefined && stored.lastSeq >= lastEventSeq && stored.engine === ENGINE) continue

      const rollup = emptySessionRollup(id, snapshot.session.createdAt)
      rollup.engine = ENGINE
      const folder = new SessionFolder({
        sessionId: id,
        bufferTurns: true,
        maxBufferedTurns: 50,
        onAttempt: attempt => this.dispatchAttempt(id, attempt),
        onTurnComplete: trace => {
          applyTurnToRollup(rollup, trace)
          rollup.lastSeq = Math.max(rollup.lastSeq, trace.attempts[trace.attempts.length - 1]?.seq ?? 0)
        },
        onMaintenance: attempt => applyMaintenanceToRollup(rollup, attempt),
      })
      for (const event of snapshot.events) folder.ingest(event)
      rollup.lastSeq = Math.max(rollup.lastSeq, lastEventSeq)
      try {
        await this.requireTable().put(record.header.id, toRecord(rollup))
      } catch (error: unknown) {
        this.ctx.logger.warn(`token-tracing: could not persist backfill for session "${id}": ${renderThrown(error)}`)
        continue
      }
      this.folders.set(id, folder)
      processed += 1
    }
    return processed
  }

  // ------------------------------------------------------------------ helpers

  private sessionQuery(): SessionQueryEngine {
    return this.ctx.sessionQuery as SessionQueryEngine
  }

  private async readEvents(sessionId: string): Promise<readonly SessionEvent[]> {
    const snapshot = await this.sessionQuery().readSession(SessionId(sessionId))
    return snapshot.events
  }

  private async snapshotFrame(sessionId: string): Promise<TokenTraceFrame> {
    const stored = this.requireTable().get(sessionId)
    const folder = this.folders.get(sessionId)
    return {
      kind: 'snapshot',
      summary: stored !== undefined ? fromRecord(stored) : emptySessionRollup(sessionId, 0),
      activeTurn: folder?.activeTrace() ?? null,
    }
  }

  private requireTable(): KvTable<string, SessionRollupRecord> {
    if (this.table === undefined) throw new Error('token tracing service is not started yet')
    return this.table
  }

  /** Keep the completed-trace cache bounded (insertion-ordered LRU eviction). */
  private evictTraceCache(): void {
    while (this.traceCache.size > TRACE_CACHE_CAPACITY) {
      const oldest = this.traceCache.keys().next()
      if (oldest.done === true) break
      this.traceCache.delete(oldest.value)
    }
  }
}

export default TokenTracingService
