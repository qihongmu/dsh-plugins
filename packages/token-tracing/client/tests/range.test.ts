/**
 * Unit tests for the M3 dashboard period splitting: UTC day arithmetic,
 * current/previous cuts for day rows and session rollups, and the
 * zero-filled day window. Pure functions — no DOM, no Remote.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { DayRollupView } from '@qihongmu/dsh-plugins-token-tracing/types'
import { BASE_DAY, BASE_MS, day } from './fixtures.ts'
import { dayWindow, periodStart, shiftDay, splitDays, splitSessions, utcDay } from '../src/client/dashboard/range.ts'
import { session } from './fixtures.ts'

const NOW = Date.parse('2026-09-01T12:00:00.000Z')

describe('utcDay / shiftDay / periodStart', () => {
  it('formats epoch ms as a UTC calendar day', () => {
    assert.equal(utcDay(0), '1970-01-01')
    assert.equal(utcDay(Date.parse('2026-09-01T23:59:59.000Z')), '2026-09-01')
  })

  it('shifts across month and leap-year boundaries', () => {
    assert.equal(shiftDay('2026-03-01', -1), '2026-02-28')
    assert.equal(shiftDay('2028-03-01', -1), '2028-02-29')
    assert.equal(shiftDay('2026-08-31', 1), '2026-09-01')
  })

  it('computes the current-period start (today − (rangeDays − 1))', () => {
    assert.equal(periodStart(30, NOW), '2026-08-03')
    assert.equal(periodStart(7, NOW), '2026-08-26')
    assert.equal(periodStart(1, NOW), '2026-09-01')
  })
})

describe('splitDays', () => {
  it('cuts at the period start; earlier days go to previous', () => {
    // periodStart(30, NOW) = 2026-08-03; previousStart = 2026-07-04.
    const rows = [
      day('2026-08-01'),
      day('2026-08-02'),
      day('2026-08-03'),  // currentStart → current
      day('2026-08-10'),
      day('2026-09-01'),  // today
    ]
    const { current, previous } = splitDays(rows, 30, NOW)
    assert.deepEqual(current.map(row => row.day), ['2026-08-03', '2026-08-10', '2026-09-01'])
    assert.deepEqual(previous.map(row => row.day), ['2026-08-01', '2026-08-02'])
  })

  it('sorts both halves ascending regardless of input order', () => {
    const rows = [day('2026-09-01'), day('2026-08-05'), day('2026-08-20'), day('2026-07-01')]
    const { current, previous } = splitDays(rows, 30, NOW)
    assert.deepEqual(current.map(row => row.day), ['2026-08-05', '2026-08-20', '2026-09-01'])
    assert.deepEqual(previous.map(row => row.day), []) // 2026-07-01 is outside the 2× window
  })

  it('returns empty halves for empty input', () => {
    const { current, previous } = splitDays([], 7, NOW)
    assert.deepEqual(current, [])
    assert.deepEqual(previous, [])
  })
})

describe('splitSessions', () => {
  it('splits by lastAt at the period-start boundary', () => {
    const startMs = Date.parse(`${periodStart(7, NOW)}T00:00:00.000Z`)
    const rows = [
      session('old', { lastAt: startMs - 1 }),
      session('edge', { lastAt: startMs }),
      session('new', { lastAt: NOW }),
    ]
    const { current, previous } = splitSessions(rows, 7, NOW)
    assert.deepEqual(current.map(row => row.sessionId), ['edge', 'new'])
    assert.deepEqual(previous.map(row => row.sessionId), ['old'])
  })

  it('returns empty halves for empty input', () => {
    assert.deepEqual(splitSessions([], 7, NOW), { current: [], previous: [] })
  })

  it('keeps everything in previous when no session is active in range', () => {
    const startMs = Date.parse(`${periodStart(7, NOW)}T00:00:00.000Z`)
    const rows = [session('old', { lastAt: startMs - 1 })]
    const { current, previous } = splitSessions(rows, 7, NOW)
    assert.deepEqual(current, [])
    assert.deepEqual(previous.map(row => row.sessionId), ['old'])
  })
})

describe('dayWindow', () => {
  it('lists exactly rangeDays ascending keys ending today', () => {
    assert.deepEqual(dayWindow(3, NOW), ['2026-08-30', '2026-08-31', '2026-09-01'])
  })

  it('spans a month boundary without gaps', () => {
    const now = Date.parse('2026-03-02T00:00:00.000Z')
    assert.deepEqual(dayWindow(4, now), ['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02'])
  })
})

describe('fixtures sanity', () => {
  it('BASE_MS lands on BASE_DAY', () => {
    assert.equal(utcDay(BASE_MS), '2026-08-15')
    const row: DayRollupView = day(BASE_DAY)
    assert.equal(row.day, BASE_DAY)
  })
})
