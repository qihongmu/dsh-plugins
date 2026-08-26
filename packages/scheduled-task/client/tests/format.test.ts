/**
 * Unit tests for the client formatting helpers (pure functions, no DOM).
 * The translate stub echoes keys so assertions stay locale-independent.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { humanizeDuration, localizedDate, ruleSummary } from '../src/client/format.ts'
import type { ScheduledTaskRule } from '@deepseek-ai/dsh-plugins-scheduled-task/types'

/** Echo translator: renders `key` plus substituted params for visibility. */
const t = ((key: string, params?: Record<string, unknown>): string => {
  if (params === undefined) return key
  const filled = Object.entries(params).map(([name, value]) => `${name}=${String(value)}`)
  return `${key}(${filled.join(',')})`
}) as never as Parameters<typeof humanizeDuration>[0]

describe('humanizeDuration', () => {
  it('picks the largest exact unit', () => {
    assert.equal(humanizeDuration(t, 300), 'duration.minutes(count=5)')
    assert.equal(humanizeDuration(t, 7200), 'duration.hours(count=2)')
    assert.equal(humanizeDuration(t, 86_400), 'duration.days(count=1)')
    assert.equal(humanizeDuration(t, 90), 'duration.seconds(count=90)')
  })
})

describe('localizedDate', () => {
  it('formats defined values and yields empty string for undefined', () => {
    assert.equal(localizedDate(undefined), '')
    const rendered = localizedDate('2026-03-06T04:12:33Z')
    assert.equal(typeof rendered, 'string')
    assert.ok(rendered.length > 0)
    assert.notEqual(rendered, 'Invalid Date')
  })
})

describe('ruleSummary', () => {
  it('summarizes fixed-rate and one-shot rules', () => {
    const every = ruleSummary({ kind: 'every', everySeconds: 3600, scheduledAt: '' }, t)
    assert.match(every, /row\.schedule\.every/)
    // The echo stub nests the pre-rendered duration inside the template params.
    assert.match(every, /duration=duration\.hours\(count=1\)/)

    const after = ruleSummary({ kind: 'after', afterSeconds: 60, scheduledAt: '' }, t)
    assert.match(after, /row\.schedule\.after/)
    assert.match(after, /after a delay|duration=/)
  })

  it('joins weekly weekdays with the locale separator key', () => {
    const rule: ScheduledTaskRule = {
      kind: 'weekly',
      weekdays: [1, 3, 5],
      time: '09:00',
      time_zone: 'Asia/Shanghai',
      scheduledAt: '',
    }
    const summary = ruleSummary(rule, t)
    // Stub renders wd names as raw keys joined by the separator KEY itself.
    assert.match(summary, /schedule\.wd\.1schedule\.wd\.separatorschedule\.wd\.3/)
    assert.match(summary, /time=09:00/)
  })

  it('summarizes hourly/daily/monthly with their parameters', () => {
    assert.match(ruleSummary({ kind: 'hourly', minute: 7, scheduledAt: '' }, t), /minute=07/)
    assert.match(ruleSummary({ kind: 'daily', time: '23:05', time_zone: 'UTC', scheduledAt: '' }, t), /time=23:05/)
    assert.match(
      ruleSummary({ kind: 'monthly', dayOfMonth: 31, time: '09:00', time_zone: 'UTC', scheduledAt: '' }, t),
      /day=31/,
    )
  })
})
