/**
 * Replay-diagnose: reconcile the token-tracing fold against the shipped dsh
 * token-meter on a real session log, and quantify the estimated-vs-exact
 * attribution gap. This is the PoC-2 acceptance vehicle from the PRD: run it
 * over a real (or fixture) session JSONL and read the reconciliation table.
 *
 * Usage:
 *   node scripts/replay-diagnose.mjs <session-jsonl> [session-id]
 *
 * The log is the dsh `session-persistence-jsonl` transcript format: one JSON
 * object per line, each `{ type, seq, time, data, ... }` matching the session
 * event shape. If no file is given, a synthetic multi-step fixture is folded
 * so the script can be sanity-run anywhere.
 *
 * Reconciliation:
 *   - exact:  Σ TurnTrace.totals must equal Σ deriveTurnTokenUsage (the shipped
 *             token-meter fold) over the same turn, within tolerance.
 *   - estimate gap: per attempt, |Σcomposition − promptTotal| must be zero
 *             (calibration invariant), and the diff-vs-composition mismatch
 *             (attempts where the engine fell back to composition instead of
 *             an exact delta) is reported as an "unreconciled" count.
 */

import { readFileSync, existsSync } from 'node:fs'
import { deriveTurnTokenUsage } from '@deepseek-ai/dsh-token-meter/client'
import { SessionFolder } from '../packages/token-tracing/host/src/fold.ts'

const file = process.argv[2]
const sessionId = process.argv[3] ?? 'replay'

function loadEvents(filePath) {
  const lines = readFileSync(filePath, 'utf8').split('\n').filter(line => line.trim().length > 0)
  return lines.map((line, index) => {
    const parsed = JSON.parse(line)
    // Persisted events may omit derived fields (surfaceOp etc.) — the fold
    // only reads documented fields, but guard against non-object rows.
    return { ...parsed, seq: parsed.seq ?? index + 1 }
  })
}

/** Synthetic multi-step fixture when no log file is given. */
function syntheticEvents() {
  const BASE = Date.parse('2026-09-01T08:00:00.000Z')
  let seq = 0
  const ev = (type, data) => ({ type, seq: ++seq, time: BASE + seq * 1000, data })
  const usage = (inputTokens, outputTokens, totalTokens, extra = {}) => ({ inputTokens, outputTokens, totalTokens, ...extra })
  return [
    ev('turn/start', { turn: 1 }),
    ev('user/message', { id: 'm1', role: 'user', content: [{ type: 'text', text: 'Trace me' }], source: { kind: 'user' } }),
    ev('request/header', { header: { config: {}, system: 'S'.repeat(300) }, reason: 'initial' }),
    ev('step/start', { turn: 1, step: 0 }),
    ev('assistant/message', {
      turn: 1, step: 0,
      message: { id: 'a1', role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }], source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' } },
      usage: usage(100, 30, 130),
    }),
    ev('tool/call', { turn: 1, step: 0, callId: 'c1', name: 'read', arguments: '{}' }),
    ev('tool/result', {
      turn: 1, step: 0,
      message: { id: 't1', role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'x'.repeat(400) }], isError: false }], source: { kind: 'tool', callId: 'c1' } },
    }),
    ev('step/end', { turn: 1, step: 0 }),
    ev('step/start', { turn: 1, step: 1 }),
    ev('assistant/message', {
      turn: 1, step: 1,
      message: { id: 'a2', role: 'assistant', content: [{ type: 'text', text: 'Done' }], source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' } },
      usage: usage(45, 20, 160, { cacheReadTokens: 95 }),
    }),
    ev('step/end', { turn: 1, step: 1 }),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ]
}

/* ----------------------------------------------------------------- fold */

const events = file !== undefined && existsSync(file)
  ? loadEvents(file)
  : (console.log(`[replay-diagnose] no log file (or missing); using synthetic fixture\n`), syntheticEvents())

const folder = new SessionFolder({ sessionId, bufferTurns: true, maxBufferedTurns: 10_000 })
for (const event of events) folder.ingest(event)

/* ------------------------------------------------------------ reconcile */

const traces = folder.bufferedTurns
const turnNumbers = new Set(traces.map(trace => trace.turn))
const byTurn = (turn) => traces.find(trace => trace.turn === turn)

let exactMismatches = 0
let unreconciledAttempts = 0
let calibratedAttempts = 0
let diffAttempts = 0

console.log('turn | attempts | engine.total | tokenMeter.total | diff | estGap(Σcomp−prompt)')
console.log('-----|----------|--------------|------------------|------|---------------------')
for (const trace of traces) {
  // Reconstruct the turn's own event window (turn/start .. turn/end inclusive)
  // for the strict token-meter fold.
  const turnEvents = []
  let inTurn = false
  for (const event of events) {
    if (event.type === 'turn/start') inTurn = event.data.turn === trace.turn
    if (inTurn) turnEvents.push(event)
    if (event.type === 'turn/end') inTurn = false
  }
  const reference = deriveTurnTokenUsage(turnEvents)
  const engineTotal = trace.totals?.totalTokens ?? null
  const meterTotal = reference?.totalTokens ?? null
  const diff = engineTotal !== null && meterTotal !== null ? engineTotal - meterTotal : '—'
  if (diff !== '—' && Math.abs(diff) > 0) exactMismatches += 1
  let gap = 0
  for (const attempt of trace.attempts) {
    if (attempt.composition !== null) {
      const sum = attempt.composition.reduce((acc, split) => acc + split.tokens, 0)
      gap = Math.max(gap, Math.abs(sum - (attempt.promptTotal ?? 0)))
      calibratedAttempts += 1
    } else {
      diffAttempts += 1
    }
  }
  console.log(
    `${trace.turn} | ${trace.attempts.length} | ${engineTotal ?? '—'} | ${meterTotal ?? '—'}`
    + ` | ${diff} | ${gap}`,
  )
}

console.log('\nattempts: diff-based (exact) =', diffAttempts, '| calibrated =', calibratedAttempts)
console.log('unreconciled (no diff, no composition) =', unreconciledAttempts)
console.log('exact-total mismatches vs token-meter =', exactMismatches)

/* ------------------------------------------------- compaction cross-check */

// DESIGN §2.2: the measured prompt delta across a compaction validates
// −shadowedTokenCount. Report attempts whose measured shrink diverges wildly
// from the shadow price (the shadow number is a heuristic estimate).
let crossChecks = 0
let crossCheckMismatches = 0
for (let index = 0; index < events.length; index += 1) {
  const event = events[index]
  if (event.type !== 'compaction/summary') continue
  const shadowed = event.data.shadowedTokenCount
  // First LLM attempt after the summary with a known promptTotal.
  for (let scan = index + 1; scan < events.length; scan += 1) {
    const later = events[scan]
    if (later.type === 'compaction/summary') break
    if (later.type !== 'assistant/message' || later.data.usage === undefined) continue
    const usage = later.data.usage
    const promptTotal = usage.totalTokens !== undefined
      ? usage.totalTokens - usage.outputTokens
      : null
    const before = attemptsPromptTotalBefore(events, index, later.seq)
    if (promptTotal === null || before === null) break
    const measured = promptTotal - before
    crossChecks += 1
    const divergence = shadowed === 0 ? Math.abs(measured) : Math.abs(measured + shadowed) / shadowed
    if (divergence > 0.35) {
      crossCheckMismatches += 1
      console.log(`compaction cross-check MISMATCH at seq ${later.seq}: measured ${measured} vs shadow -${shadowed}`)
    }
    break
  }
}
console.log('compaction cross-checks =', crossChecks, '| mismatches (>35% divergence) =', crossCheckMismatches)
console.log('max composition gap vs promptTotal (should be 0) =', Math.max(0, ...traces.flatMap(trace =>
  trace.attempts.filter(attempt => attempt.composition !== null)
    .map(attempt => Math.abs(attempt.composition.reduce((acc, split) => acc + split.tokens, 0) - (attempt.promptTotal ?? 0))))))

/** Prompt total of the last billed attempt strictly before `seq`, or null. */
function attemptsPromptTotalBefore(events, summaryIndex, seq) {
  for (let scan = summaryIndex - 1; scan >= 0; scan -= 1) {
    const earlier = events[scan]
    if (earlier.type === 'assistant/message' && earlier.data.usage !== undefined && earlier.seq < seq) {
      const usage = earlier.data.usage
      if (usage.totalTokens !== undefined) return usage.totalTokens - usage.outputTokens
    }
  }
  return null
}

if (exactMismatches > 0 || unreconciledAttempts > 0) {
  console.error('\n[replay-diagnose] reconciliation FAILED')
  process.exitCode = 1
} else {
  console.log('\n[replay-diagnose] reconciliation OK')
}
