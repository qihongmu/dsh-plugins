/**
 * Unit tests for the FR-14 waterfall fold helpers: the foldable predicate
 * (strictly above the shared oversized threshold, tool-result kind only)
 * and the segment key format matching `aggregateByKind`'s merge key.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isFoldable, segmentKey } from '../src/client/component-meta.ts'
import { LONG_RESULT_TOKENS } from '../src/client/dashboard/suggest.ts'

describe('isFoldable', () => {
  it('folds tool results strictly above the shared oversized threshold', () => {
    assert.equal(isFoldable('tool-result', LONG_RESULT_TOKENS + 1, LONG_RESULT_TOKENS), true)
    assert.equal(isFoldable('tool-result', LONG_RESULT_TOKENS, LONG_RESULT_TOKENS), false, 'exactly at threshold stays visible')
    assert.equal(isFoldable('tool-result', LONG_RESULT_TOKENS - 1, LONG_RESULT_TOKENS), false)
  })

  it('never folds other kinds, however large', () => {
    assert.equal(isFoldable('system-prompt', 50_000, LONG_RESULT_TOKENS), false)
    assert.equal(isFoldable('injected-context', 50_000, LONG_RESULT_TOKENS), false)
    assert.equal(isFoldable('assistant-output', 50_000, LONG_RESULT_TOKENS), false)
  })

  it('accepts an explicit threshold override', () => {
    assert.equal(isFoldable('tool-result', 500, 400), true)
    assert.equal(isFoldable('tool-result', 400, 400), false)
  })
})

describe('segmentKey', () => {
  it('mirrors aggregateByKind merge keys', () => {
    assert.equal(segmentKey('tool-result', 'read'), 'tool-result/read')
    assert.equal(segmentKey('tool-result', undefined), 'tool-result')
    assert.equal(segmentKey('system-prompt', undefined), 'system-prompt')
  })
})
