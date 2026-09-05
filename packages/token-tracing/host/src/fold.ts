/**
 * The token-tracing fold engine: a pure, incremental folder over the durable
 * session event log. Live ingestion and full replay run the same code path.
 *
 * Attribution is three-layered:
 *   1. exact — every attempt's provider usage buckets, verbatim;
 *   2. diff — within one request-header series, the prompt-total delta between
 *      neighboring attempts provably equals the re-serialized additions (the
 *      previous assistant output, tool results, mid-turn steering), so the
 *      delta total is exact and only its per-node split is estimated;
 *   3. calibrated estimate — at series starts (initial/resume/change/after
 *      compaction) the full request composition is estimated at a fixed char
 *      density and scaled so the components sum to the exact promptTotal.
 *
 * Deliberately tolerant where the dsh token-meter fold is strict: a missing
 * boundary degrades one attempt to less precise attribution instead of
 * discarding the whole turn's disclosure.
 * @module @qihongmu/dsh-plugins-token-tracing/src/fold
 */

import type { TokenUsage } from '@deepseek-ai/dsh-llm/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
// Type-only: pull the plugin-merged session event variants (`llm/retry*`,
// `compaction/*`) into the SessionEventMap program before folding.
import type {} from '@deepseek-ai/dsh-llm-retry/types'
import type {} from '@deepseek-ai/dsh-compaction/types'
import type {
  AttemptTrace,
  ComponentKind,
  ComponentSplit,
  TurnTrace,
  UsageBuckets,
} from './types.ts'
import { promptTotalOf, sumUsages, toBuckets } from './usage.ts'

/** Estimated tokens per content character (matches the dsh token-meter density). */
const CHARS_PER_TOKEN = 4
/** Fixed per-block structural overhead (role framing, block delimiters). */
const BLOCK_OVERHEAD_TOKENS = 4
/** A cache-read drop below this ratio of the previous prompt marks invalidation. */
const CACHE_DROP_RATIO = 0.9

interface SurfaceNode {
  seq: number
  kind: 'user' | 'assistant' | 'tool-result'
  sourceKind?: 'user' | 'plugin' | undefined
  pluginName?: string | undefined
  toolName?: string | undefined
  chars: number
}

interface RawComponent {
  kind: ComponentKind
  name?: string | undefined
  tokens: number
}

interface OpenTurn {
  turn: number
  startedAt: number
  startedSeq: number
  attempts: AttemptTrace[]
  cacheEvents: { atSeq: number; kind: 'invalidated' | 'compacted' }[]
  interrupted: boolean
}

export interface FoldCallbacks {
  /** Every closed attempt, including compaction pseudo-attempts. */
  onAttempt?: (attempt: AttemptTrace) => void
  /** A completed turn (attempts ≥ 1 or cache events present). */
  onTurnComplete?: (trace: TurnTrace) => void
  /** A turn-less (idle/maintenance) compaction attempt. */
  onMaintenance?: (attempt: AttemptTrace) => void
}

export interface FoldOptions extends FoldCallbacks {
  /** Session id stamped onto every produced TurnTrace. */
  sessionId: string
  /** Retain completed TurnTraces for `traceOf` (live folders: capped; replay: unlimited). */
  bufferTurns?: boolean
  maxBufferedTurns?: number
}

function estimateTokens(chars: number): number {
  return chars <= 0 ? 0 : Math.ceil(chars / CHARS_PER_TOKEN) + BLOCK_OVERHEAD_TOKENS
}

function contentChars(content: unknown): number {
  const json = JSON.stringify(content)
  return json === undefined ? 0 : json.length
}

/**
 * Scale raw component estimates so they sum to `total` exactly: proportional
 * allocation with the rounding drift absorbed into the largest component.
 */
function allocateScaled(total: number, raws: readonly RawComponent[]): ComponentSplit[] {
  if (raws.length === 0) {
    return [{ kind: 'unattributed', tokens: total, basis: 'estimated' }]
  }
  const sum = raws.reduce((acc, raw) => acc + raw.tokens, 0)
  const scale = sum > 0 ? total / sum : 0
  const splits: ComponentSplit[] = raws.map(raw => ({
    kind: raw.kind,
    ...(raw.name === undefined ? {} : { name: raw.name }),
    tokens: Math.max(0, Math.round(raw.tokens * scale)),
    basis: 'estimated',
  }))
  let drift = total - splits.reduce((acc, split) => acc + split.tokens, 0)
  if (drift !== 0 && splits.length > 0) {
    let largest = 0
    for (let index = 1; index < splits.length; index += 1) {
      const candidate = splits[index]
      const current = splits[largest]
      if (candidate !== undefined && current !== undefined && candidate.tokens > current.tokens) largest = index
    }
    const target = splits[largest]
    if (target !== undefined) target.tokens = Math.max(0, target.tokens + drift)
  }
  return splits
}

function splitForNode(node: SurfaceNode): RawComponent {
  if (node.kind === 'assistant') return { kind: 'assistant-output', tokens: estimateTokens(node.chars) }
  if (node.kind === 'tool-result') {
    return { kind: 'tool-result', name: node.toolName ?? 'unknown', tokens: estimateTokens(node.chars) }
  }
  if (node.sourceKind === 'plugin') {
    return { kind: 'injected-context', name: node.pluginName, tokens: estimateTokens(node.chars) }
  }
  return { kind: 'user-input', tokens: estimateTokens(node.chars) }
}

/** Cache read/write summary for one attempt (null when usage was not reported). */
function cacheInfoOf(usageBuckets: UsageBuckets | null, promptTotal: number | null): AttemptTrace['cache'] {
  if (usageBuckets === null) return null
  const read = usageBuckets.cacheReadTokens ?? 0
  const write = usageBuckets.cacheWriteTokens ?? 0
  return { read, write, hitRatio: promptTotal !== null && promptTotal > 0 ? read / promptTotal : 0 }
}

/**
 * Incremental session folder. Feed durable events in order; read completed
 * turns from the callback/buffer. One instance per session, never shared.
 */
export class SessionFolder {
  private readonly options: FoldOptions
  private readonly buffered: TurnTrace[] = []
  private readonly maxBuffered: number

  private surface: SurfaceNode[] = []
  private readonly toolNames = new Map<string, string>()
  private header: { systemChars: number; toolsChars: number } | null = null
  /** Header changed since the last attempt close (reason initial/resume/change). */
  private headerChanged = false
  /** A compaction (or other surface replacement) happened since the last attempt close. */
  private compacted = false
  /** The last turn ended other than `completed` — diffing across it is unprovable. */
  private lastTurnBroken = false
  private lastPromptTotal: number | null = null
  /** Seq of the newest surface node priced into the previous attempt's prompt. */
  private lastAbsorbedSeq = -1
  private priorAttemptExists = false
  /** `shadowedTokenCount` of the last compaction, awaiting cross-validation by the next attempt. */
  private pendingShadow: number | undefined
  private attemptState: { kind: 'idle' | 'settled' } | {
    kind: 'open'
    turn: number
    step: number
    sample?: TokenUsage
  } = { kind: 'idle' }
  private current: OpenTurn | null = null

  constructor(options: FoldOptions) {
    this.options = options
    this.maxBuffered = options.bufferTurns === true ? options.maxBufferedTurns ?? 50 : 0
  }

  /** Completed turns retained by this folder (newest last). */
  get bufferedTurns(): readonly TurnTrace[] {
    return this.buffered
  }

  /** Final trace for one turn number, if retained. */
  traceOf(turn: number): TurnTrace | undefined {
    return this.buffered.find(trace => trace.turn === turn)
  }

  /** Snapshot of the still-open turn, if any. */
  activeTrace(): TurnTrace | null {
    if (this.current === null) return null
    return this.buildTrace(this.current, 'active', null)
  }

  /** Snapshot of the still-open turn with the given number, if any. */
  activeTraceOf(turn: number): TurnTrace | null {
    if (this.current === null || this.current.turn !== turn) return null
    return this.activeTrace()
  }

  /**
   * Fold one durable event. Events must arrive in seq order; unknown
   * (plugin-merged) types are ignored — the folder only reads core events.
   */
  ingest(event: SessionEvent): void {
    switch (event.type) {
      case 'turn/start': return this.onTurnStart(event)
      case 'turn/end': return this.onTurnEnd(event)
      case 'step/start': return this.onStepStart(event)
      case 'step/end': return this.onStepEnd(event)
      case 'assistant/chunk': return this.onAssistantChunk(event)
      case 'assistant/message': return this.onAssistantMessage(event)
      case 'llm/retry': return this.onLlmRetry(event)
      case 'llm/retry-started': return this.onLlmRetryStarted(event)
      case 'tool/call': return this.onToolCall(event)
      case 'tool/result': return this.onToolResult(event)
      case 'user/message': return this.onUserMessage(event)
      case 'request/header': return this.onRequestHeader(event)
      case 'compaction/summary': return this.onCompactionSummary(event)
      case 'compaction/prune': return this.onCompactionPrune(event)
      default: return
    }
  }

  // ------------------------------------------------------------- turn frame

  private onTurnStart(event: SessionEvent<'turn/start'>): void {
    // A turn/start while a turn is open means the previous turn never ended
    // (crash orphan before a persistence repair pass): finalize it broken.
    if (this.current !== null) this.finalizeTurn('incomplete', event.time)
    this.current = {
      turn: event.data.turn,
      startedAt: event.time,
      startedSeq: event.seq,
      attempts: [],
      cacheEvents: [],
      interrupted: false,
    }
    this.attemptState = { kind: 'idle' }
  }

  private onTurnEnd(event: SessionEvent<'turn/end'>): void {
    if (this.current === null || this.current.turn !== event.data.turn) return
    this.finalizeTurn(event.data.reason.kind === 'completed' ? 'complete' : 'incomplete', event.time)
    this.attemptState = { kind: 'idle' }
  }

  private finalizeTurn(status: 'complete' | 'incomplete', endedAt: number): void {
    const turn = this.current
    this.current = null
    if (turn === null) return
    this.lastTurnBroken = status !== 'complete' || turn.interrupted
    if (turn.attempts.length === 0 && turn.cacheEvents.length === 0) return
    const trace = this.buildTrace(turn, status, endedAt)
    if (this.maxBuffered > 0) {
      this.buffered.push(trace)
      if (this.buffered.length > this.maxBuffered) this.buffered.shift()
    }
    this.options.onTurnComplete?.(trace)
  }

  private buildTrace(turn: OpenTurn, status: TurnTrace['status'], endedAt: number | null): TurnTrace {
    return {
      sessionId: this.options.sessionId,
      turn: turn.turn,
      status,
      startedAt: turn.startedAt,
      endedAt,
      attempts: turn.attempts,
      totals: sumUsages(turn.attempts.map(attempt => attempt.usage)),
      cacheEvents: turn.cacheEvents,
    }
  }

  // ----------------------------------------------------------- attempt life

  private onStepStart(event: SessionEvent<'step/start'>): void {
    if (this.current === null || this.current.turn !== event.data.turn) return
    this.attemptState = { kind: 'open', turn: event.data.turn, step: event.data.step }
  }

  private onStepEnd(event: SessionEvent<'step/end'>): void {
    if (this.attemptState.kind === 'open') this.closeAttempt(event.seq, event.time, undefined, false)
    this.attemptState = { kind: 'idle' }
  }

  private onAssistantChunk(event: SessionEvent<'assistant/chunk'>): void {
    if (this.attemptState.kind !== 'open') return
    const { chunk, turn, step } = event.data
    if (this.attemptState.turn !== turn || this.attemptState.step !== step) return
    if (chunk.type === 'usage') this.attemptState.sample = chunk.usage
  }

  private onAssistantMessage(event: SessionEvent<'assistant/message'>): void {
    const { turn, step, usage, interrupted } = event.data
    if (this.current !== null && interrupted === true) this.current.interrupted = true
    if (this.attemptState.kind === 'open' && this.attemptState.turn === turn && this.attemptState.step === step) {
      this.closeAttempt(event.seq, event.time, usage ?? this.attemptState.sample, false)
    } else {
      // Tolerant path: a message without its bracket (seed edge, lost event).
      this.closeStandalone(turn, step, event.seq, event.time, usage, interrupted === true)
    }
    this.attemptState = { kind: 'settled' }
    // The message's own surface node belongs to the NEXT attempt's prompt.
    this.appendSurfaceNode(event, {
      kind: 'assistant',
      chars: contentChars(event.data.message.content),
    })
  }

  private onLlmRetry(event: SessionEvent<'llm/retry'>): void {
    if (this.attemptState.kind === 'open') {
      this.closeAttempt(event.seq, event.time, this.attemptState.sample, true)
    }
    this.attemptState = { kind: 'settled' }
  }

  private onLlmRetryStarted(event: SessionEvent<'llm/retry-started'>): void {
    this.attemptState = { kind: 'open', turn: event.data.turn, step: event.data.step }
  }

  /** Shared attempt construction: exact buckets, prompt total, cache info. */
  private attemptBase(
    seq: number,
    turn: number,
    step: number,
    time: number,
    kind: AttemptTrace['kind'],
    usage: TokenUsage | undefined,
    flags: { retry?: boolean | undefined; interrupted?: boolean | undefined },
  ): { usageBuckets: UsageBuckets | null; promptTotal: number | null; attempt: AttemptTrace } {
    const usageBuckets = usage === undefined ? null : toBuckets(usage)
    const promptTotal = usageBuckets === null ? null : promptTotalOf(usageBuckets)
    const attempt: AttemptTrace = {
      seq,
      turn,
      step,
      kind,
      time,
      ...(flags.retry ? { retry: true } : {}),
      ...(flags.interrupted ? { interrupted: true } : {}),
      usage: usageBuckets,
      promptTotal,
      composition: null,
      additions: null,
      cache: cacheInfoOf(usageBuckets, promptTotal),
    }
    return { usageBuckets, promptTotal, attempt }
  }

  /**
   * Shared bookkeeping once an attempt is fully built: push it, absorb the
   * surface (everything currently on it rides the next request), and reset
   * the series/break bookkeeping.
   */
  private commitAttempt(turn: OpenTurn, attempt: AttemptTrace): void {
    turn.attempts.push(attempt)
    const lastNode = this.surface[this.surface.length - 1]
    this.lastAbsorbedSeq = lastNode === undefined ? -1 : lastNode.seq
    this.priorAttemptExists = true
    this.lastPromptTotal = attempt.promptTotal
    this.headerChanged = false
    this.compacted = false
    this.lastTurnBroken = false
    this.options.onAttempt?.(attempt)
  }

  /**
   * Close one open attempt: exact usage, prompt total, a full calibrated
   * composition (computed for every reported attempt — the composition view
   * needs it everywhere), and either a diff-based additions split (same
   * series, prior total known) or level-3 fallbacks.
   *
   * Invalidation rules (DESIGN §2.2): (a) the request header CHANGED since
   * the previous attempt, or (b) cacheRead dropped below the previous prompt
   * total while the prompt grew. A negative delta or a compaction breaks the
   * diff chain but is NOT an invalidation.
   */
  private closeAttempt(
    seq: number,
    time: number,
    usage: TokenUsage | undefined,
    closedByRetry: boolean,
  ): void {
    const turn = this.current
    if (turn === null) return
    const state = this.attemptState
    if (state.kind !== 'open') return
    // Additions = surface nodes appended after the previous attempt absorbed
    // the surface, and strictly before this closing event's own node.
    const newNodes = this.surface.filter(node => node.seq > this.lastAbsorbedSeq)

    const step = state.step
    const retry = closedByRetry || turn.attempts.some(attempt => attempt.step === step)
    const { usageBuckets, promptTotal, attempt } = this.attemptBase(
      seq, state.turn, step, time, 'llm', usage, { retry },
    )

    let invalidated = false
    attempt.composition = promptTotal === null ? null : this.composeSurface(promptTotal)

    const diffable = this.lastPromptTotal !== null && promptTotal !== null
      && !this.headerChanged && !this.compacted && !this.lastTurnBroken
    if (diffable && this.lastPromptTotal !== null && promptTotal !== null) {
      const delta = promptTotal - this.lastPromptTotal
      if (delta >= 0) {
        attempt.additions = this.attributeDelta(delta, newNodes)
        const cacheRead = usageBuckets?.cacheReadTokens
        if (delta > 0 && cacheRead !== undefined && cacheRead < this.lastPromptTotal * CACHE_DROP_RATIO) {
          invalidated = true
        }
      } else {
        // The prompt shrank inside a live series without compaction: attribute
        // the measured shrink exactly and fall back to composition. Per spec
        // this is a level-3 fallback, NOT a cache invalidation.
        attempt.additions = [{ kind: 'context-shrink', tokens: delta, basis: 'exact' }]
      }
    } else {
      // Cross-check (DESIGN §2.2): the measured prompt delta around a
      // compaction validates −shadowedTokenCount; a measured shrink is
      // attributed exactly instead of the shadow-price estimate.
      if (this.compacted && this.pendingShadow !== undefined
        && this.lastPromptTotal !== null && promptTotal !== null) {
        const delta = promptTotal - this.lastPromptTotal
        if (delta < 0) {
          attempt.additions = [{ kind: 'context-shrink', tokens: delta, basis: 'exact' }]
        }
      }
      this.pendingShadow = undefined
      invalidated = this.headerChanged && this.priorAttemptExists
    }
    if (invalidated) {
      attempt.invalidated = true
      turn.cacheEvents.push({ atSeq: seq, kind: 'invalidated' })
    }
    this.commitAttempt(turn, attempt)
  }

  /** Attempt reconstructed from a bare assistant/message without its brackets. */
  private closeStandalone(
    turn: number,
    step: number,
    seq: number,
    time: number,
    usage: TokenUsage | undefined,
    interrupted: boolean,
  ): AttemptTrace | undefined {
    if (this.current === null || this.current.turn !== turn) return undefined
    const { promptTotal, attempt } = this.attemptBase(
      seq, turn, step, time, 'llm', usage, { interrupted },
    )
    attempt.composition = promptTotal === null ? null : this.composeSurface(promptTotal)
    this.commitAttempt(this.current, attempt)
    return attempt
  }

  // -------------------------------------------------------------- attribution

  /** Full-request composition: system + tools + every surface node, scaled to the exact prompt total. */
  private composeSurface(promptTotal: number): ComponentSplit[] {
    const raws: RawComponent[] = []
    if (this.header !== null) {
      if (this.header.systemChars > 0) {
        raws.push({ kind: 'system-prompt', tokens: estimateTokens(this.header.systemChars) })
      }
      if (this.header.toolsChars > 0) {
        raws.push({ kind: 'tool-definitions', tokens: estimateTokens(this.header.toolsChars) })
      }
    }
    for (const node of this.surface) raws.push(splitForNode(node))
    return allocateScaled(promptTotal, raws)
  }

  /** Split an exact prompt delta across the interval's new surface nodes. */
  private attributeDelta(delta: number, newNodes: readonly SurfaceNode[]): ComponentSplit[] {
    if (delta === 0) return []
    const first = newNodes[0]
    if (first === undefined) {
      return [{ kind: 'unattributed', tokens: delta, basis: 'estimated' }]
    }
    if (newNodes.length === 1) {
      const single = splitForNode(first)
      return [{
        kind: single.kind,
        ...(single.name === undefined ? {} : { name: single.name }),
        tokens: delta,
        basis: 'exact',
      }]
    }
    return allocateScaled(delta, newNodes.map(splitForNode))
  }

  // ----------------------------------------------------------------- surface

  private onToolCall(event: SessionEvent<'tool/call'>): void {
    this.toolNames.set(event.data.callId, event.data.name)
  }

  private onToolResult(event: SessionEvent<'tool/result'>): void {
    this.appendSurfaceNode(event, {
      kind: 'tool-result',
      toolName: this.toolNames.get(event.data.message.source.callId),
      chars: contentChars(event.data.message.content),
    })
  }

  private onUserMessage(event: SessionEvent<'user/message'>): void {
    const source = event.data.source
    if (source.kind === 'tool') return
    this.appendSurfaceNode(event, {
      kind: 'user',
      sourceKind: source.kind === 'plugin' ? 'plugin' : 'user',
      pluginName: source.kind === 'plugin' ? source.plugin : undefined,
      chars: contentChars(event.data.content),
    })
  }

  private appendSurfaceNode(
    event: SessionEvent<'assistant/message' | 'tool/result' | 'user/message'>,
    fields: Omit<SurfaceNode, 'seq'>,
  ): void {
    const node: SurfaceNode = { seq: event.seq, ...fields }
    const op = event.surfaceOp
    if (op !== undefined && typeof op === 'object') {
      // op.start/op.end are SURFACE NODE SEQS, not array indices — the harness
      // converts them with indexOf over its node list. Treating them as
      // indices corrupts every post-compaction fold once seqs and indices
      // drift apart. Tolerant fallback: append when the range is already gone.
      const startIndex = this.surface.findIndex(entry => entry.seq === op.start)
      const endIndex = this.surface.findIndex(entry => entry.seq === op.end)
      if (startIndex !== -1 && endIndex !== -1) {
        const [lo, hi] = startIndex <= endIndex ? [startIndex, endIndex] : [endIndex, startIndex]
        this.surface.splice(lo, hi - lo + 1, node)
      } else {
        this.surface.push(node)
      }
    } else {
      this.surface.push(node)
    }
  }

  // ------------------------------------------------------------------ header

  private onRequestHeader(event: SessionEvent<'request/header'>): void {
    const { header, reason } = event.data
    this.header = {
      systemChars: header.system?.length ?? 0,
      toolsChars: header.tools === undefined ? 0 : contentChars(header.tools),
    }
    // Only an actual header CHANGE invalidates the provider prefix cache.
    // 'initial'/'resume' re-establish a series over the same header — the
    // provider-side cache survives a process restart.
    if (reason === 'change') this.headerChanged = true
  }

  // -------------------------------------------------------------- compaction

  private onCompactionSummary(event: SessionEvent<'compaction/summary'>): void {
    const { usage, shadowedTokenCount } = event.data
    this.compacted = true
    // The next attempt's measured prompt delta cross-validates this estimate.
    this.pendingShadow = shadowedTokenCount
    const usageBuckets = usage === undefined ? null : toBuckets(usage)
    const promptTotal = usageBuckets === null ? null : promptTotalOf(usageBuckets)
    const attempt: AttemptTrace = {
      seq: event.seq,
      turn: this.current?.turn ?? 0,
      step: -1,
      kind: 'compaction',
      time: event.time,
      usage: usageBuckets,
      promptTotal,
      composition: promptTotal === null ? null : [{ kind: 'compaction', tokens: promptTotal, basis: 'exact' }],
      additions: [{ kind: 'context-shrink', tokens: -shadowedTokenCount, basis: 'estimated' }],
      cache: null,
    }
    // A summary inside an open turn bills that turn; a turn-less (idle)
    // compaction is maintenance cost with no owning turn.
    if (this.current === null) {
      this.options.onMaintenance?.(attempt)
      return
    }
    this.current.cacheEvents.push({ atSeq: event.seq, kind: 'compacted' })
    this.current.attempts.push(attempt)
    this.options.onAttempt?.(attempt)
  }

  private onCompactionPrune(event: SessionEvent<'compaction/prune'>): void {
    this.compacted = true
    if (this.current !== null) this.current.cacheEvents.push({ atSeq: event.seq, kind: 'compacted' })
  }
}
