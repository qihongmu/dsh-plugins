/**
 * Unit tests for the scheduled-task domain core: rule construction
 * (`buildRule`) across all seven selectors, occurrence math for the wall-clock
 * presets, `advanceRule` progression/terminal semantics, input validation, and
 * framing/view projection. Wall-clock expectations in a fixed zone use
 * Asia/Shanghai (UTC+8, no DST) so epochs are exact; hourly uses process-local
 * time and derives its expectations dynamically.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  advanceRule, buildRule, ScheduledTaskError, renderTaskFraming,
  scheduledTaskView, validatePrompt, validateTitle,
} from '../src/domain.ts'
import type { ScheduledTaskRecord } from '../src/spec.ts'

/** Fri 2026-03-06 12:12:33 Asia/Shanghai (04:12:33Z). */
const NOW = Date.parse('2026-03-06T04:12:33Z')
const SHANGHAI = 'Asia/Shanghai'
/** 09:00 Asia/Shanghai on the given local date, as epoch ms. */
const at09 = (isoDate: string): number => Date.parse(`${isoDate}T01:00:00.000Z`)
const HOUR = 3_600_000
const DAY = 86_400_000

/** Assert the callback throws ScheduledTaskError with exactly this code. */
function failsWith(code: string, run: () => unknown): void {
  try {
    run()
    assert.fail(`expected ScheduledTaskError "${code}"`)
  } catch (error: unknown) {
    assert.ok(error instanceof ScheduledTaskError, `expected ScheduledTaskError, got ${String(error)}`)
    assert.equal(error.code, code)
  }
}

describe('input validation', () => {
  it('rejects blank titles and prompts', () => {
    failsWith('invalid_title', () => validateTitle('   '))
    assert.equal(validateTitle('  x '), 'x')
    failsWith('invalid_prompt', () => validatePrompt(''))
    assert.equal(validatePrompt(' do it '), 'do it')
  })

  it('accepts zero selectors as undefined (caller maps to invalid_selector)', () => {
    assert.equal(buildRule({ title: 't', prompt: 'p' }, NOW), undefined)
  })

  it('rejects more than one selector', () => {
    failsWith('invalid_selector', () => buildRule({
      title: 't', prompt: 'p',
      daily: { time: '09:00', time_zone: SHANGHAI },
      hourly: { minute: 0 },
    }, NOW))
  })
})

describe('one-shot selectors', () => {
  it('after_seconds fires exactly now+N and is terminal', () => {
    const rule = buildRule({ title: 't', prompt: 'p', after_seconds: 60 }, NOW)
    assert.deepEqual(rule, { kind: 'after', afterSeconds: 60, scheduledAt: new Date(NOW + 60_000).toISOString() })
    assert.equal(advanceRule(rule!, Date.parse(rule!.scheduledAt)), undefined)
  })

  it('at converts bare HH:mm through the named zone (UI sends HH:mm)', () => {
    const rule = buildRule({
      title: 't', prompt: 'p', at: { date: '2026-03-07', time: '09:00', time_zone: SHANGHAI },
    }, NOW)
    assert.equal(rule!.kind, 'at')
    assert.equal(Date.parse(rule!.scheduledAt), at09('2026-03-07'))
    assert.equal(advanceRule(rule!, Date.parse(rule!.scheduledAt)), undefined)
  })

  it('at accepts explicit seconds too', () => {
    const rule = buildRule({
      title: 't', prompt: 'p', at: { date: '2026-03-07', time: '09:00:30', time_zone: SHANGHAI },
    }, NOW)
    assert.equal(Date.parse(rule!.scheduledAt), Date.parse('2026-03-07T01:00:30.000Z'))
  })

  it('every is fixed-rate from the creation instant', () => {
    const rule = buildRule({ title: 't', prompt: 'p', every_seconds: 3600 }, NOW)
    assert.deepEqual(rule, { kind: 'every', everySeconds: 3600, scheduledAt: new Date(NOW + HOUR).toISOString() })
    const next = advanceRule(rule!, NOW + HOUR)
    assert.ok(next && next.kind === 'every')
    assert.equal(Date.parse(next.scheduledAt), NOW + 2 * HOUR)
  })
})

describe('hourly selector (process-local anchor)', () => {
  it('anchors to the first :minute at or after now', () => {
    const rule = buildRule({ title: 't', prompt: 'p', hourly: { minute: 30 } }, NOW)
    const expected = new Date(NOW)
    expected.setSeconds(0, 0)
    expected.setMinutes(30) // 12:30 local > 12:12 → today
    assert.ok(rule && rule.kind === 'hourly')
    assert.equal(rule.minute, 30)
    assert.equal(Date.parse(rule.scheduledAt), expected.getTime())
  })

  it('advances by one hour strictly after each run', () => {
    const rule = buildRule({ title: 't', prompt: 'p', hourly: { minute: 59 } }, NOW)
    const first = Date.parse(rule!.scheduledAt)
    const second = advanceRule(rule!, first)
    assert.ok(second && second.kind === 'hourly')
    assert.equal(Date.parse(second.scheduledAt), first + HOUR)
    // Exclusive at the boundary: advancing AT the old target never re-fires it.
    const third = advanceRule(second, first + HOUR)
    assert.equal(Date.parse(third!.scheduledAt), first + 2 * HOUR)
  })

  it('rejects out-of-range minutes', () => {
    for (const minute of [-1, 60, 1.5]) {
      failsWith('time_out_of_range', () => buildRule({ title: 't', prompt: 'p', hourly: { minute } }, NOW))
    }
  })
})

describe('daily selector', () => {
  it('rolls to tomorrow when today’s wall time already passed', () => {
    const rule = buildRule({ title: 't', prompt: 'p', daily: { time: '09:00', time_zone: SHANGHAI } }, NOW)
    assert.deepEqual(rule, {
      kind: 'daily', time: '09:00', time_zone: SHANGHAI, scheduledAt: new Date(at09('2026-03-07')).toISOString(),
    })
  })

  it('stays today when the wall time is still ahead', () => {
    const earlier = Date.parse('2026-03-06T00:30:00Z') // 08:30 +08
    const rule = buildRule({ title: 't', prompt: 'p', daily: { time: '09:00', time_zone: SHANGHAI } }, earlier)
    assert.equal(Date.parse(rule!.scheduledAt), at09('2026-03-06'))
  })

  it('advances day by day at the same wall time', () => {
    const rule = buildRule({ title: 't', prompt: 'p', daily: { time: '09:00', time_zone: SHANGHAI } }, NOW)
    const next = advanceRule(rule!, at09('2026-03-07'))
    assert.ok(next && next.kind === 'daily')
    assert.equal(Date.parse(next.scheduledAt), at09('2026-03-08'))
  })

  it('validates time shape and zone presence', () => {
    failsWith('invalid_rule', () => buildRule({ title: 't', prompt: 'p', daily: { time: '9:00', time_zone: SHANGHAI } }, NOW))
    failsWith('invalid_rule', () => buildRule({ title: 't', prompt: 'p', daily: { time: '09:00', time_zone: ' ' } }, NOW))
  })
})

describe('weekly selector', () => {
  const workweek = { weekdays: [1, 2, 3, 4, 5], time: '09:00', time_zone: SHANGHAI }

  it('finds the next selected weekday (Fri evening → Monday)', () => {
    const rule = buildRule({ title: 't', prompt: 'p', weekly: workweek }, NOW)
    assert.deepEqual(rule, {
      kind: 'weekly', weekdays: [1, 2, 3, 4, 5], time: '09:00', time_zone: SHANGHAI,
      scheduledAt: new Date(at09('2026-03-09')).toISOString(),
    })
  })

  it('skips unselected days (Sat morning still lands on Monday)', () => {
    const saturday = Date.parse('2026-03-07T02:00:00Z')
    const rule = buildRule({ title: 't', prompt: 'p', weekly: workweek }, saturday)
    assert.equal(Date.parse(rule!.scheduledAt), at09('2026-03-09'))
  })

  it('dedupes and sorts weekdays', () => {
    const rule = buildRule({ title: 't', prompt: 'p', weekly: { ...workweek, weekdays: [5, 1, 3] } }, NOW)
    assert.ok(rule && rule.kind === 'weekly')
    assert.deepEqual(rule.weekdays, [1, 3, 5])
  })

  it('wraps the week after the last selected day (Fri run → Mon)', () => {
    const rule = buildRule({ title: 't', prompt: 'p', weekly: workweek }, NOW)
    const fridayRun = advanceRule(rule!, at09('2026-03-13'))
    assert.ok(fridayRun && fridayRun.kind === 'weekly')
    assert.equal(Date.parse(fridayRun.scheduledAt), at09('2026-03-16'))
    const mondayToTuesday = advanceRule(rule!, at09('2026-03-09'))
    assert.equal(Date.parse(mondayToTuesday!.scheduledAt), at09('2026-03-10'))
  })

  it('validates weekday domain and emptiness', () => {
    failsWith('invalid_rule', () => buildRule({ title: 't', prompt: 'p', weekly: { ...workweek, weekdays: [] } }, NOW))
    failsWith('invalid_rule', () => buildRule({ title: 't', prompt: 'p', weekly: { ...workweek, weekdays: [0] } }, NOW))
    failsWith('invalid_rule', () => buildRule({ title: 't', prompt: 'p', weekly: { ...workweek, weekdays: [8] } }, NOW))
  })
})

describe('monthly selector', () => {
  const monthly = (dayOfMonth: number) => ({ dayOfMonth, time: '09:00', time_zone: SHANGHAI })

  it('lands on this month when the day is still ahead', () => {
    const rule = buildRule({ title: 't', prompt: 'p', monthly: monthly(31) }, NOW)
    assert.equal(Date.parse(rule!.scheduledAt), at09('2026-03-31'))
  })

  it('skips months without the day (Mar 31 → May 31, April has 30)', () => {
    const rule = buildRule({ title: 't', prompt: 'p', monthly: monthly(31) }, NOW)
    const next = advanceRule(rule!, at09('2026-03-31'))
    assert.ok(next && next.kind === 'monthly')
    assert.equal(Date.parse(next.scheduledAt), at09('2026-05-31'))
  })

  it('skips February for day 30 (Jan 30 → Mar 30 in 2026)', () => {
    const january = Date.parse('2026-01-06T04:00:00Z')
    const rule = buildRule({ title: 't', prompt: 'p', monthly: monthly(30) }, january)
    assert.equal(Date.parse(rule!.scheduledAt), at09('2026-01-30'))
    const next = advanceRule(rule!, at09('2026-01-30'))
    assert.equal(Date.parse(next!.scheduledAt), at09('2026-03-30'))
  })

  it('rolls to next month when this month’s day passed', () => {
    const late = Date.parse('2026-03-20T00:00:00Z')
    const rule = buildRule({ title: 't', prompt: 'p', monthly: monthly(15) }, late)
    assert.equal(Date.parse(rule!.scheduledAt), at09('2026-04-15'))
  })

  it('recurs across consecutive valid months', () => {
    const rule = buildRule({ title: 't', prompt: 'p', monthly: monthly(1) }, NOW)
    const april = advanceRule(rule!, at09('2026-04-01'))
    assert.ok(april && april.kind === 'monthly')
    assert.equal(Date.parse(april.scheduledAt), at09('2026-05-01'))
  })

  it('rejects out-of-range days', () => {
    failsWith('time_out_of_range', () => buildRule({ title: 't', prompt: 'p', monthly: monthly(0) }, NOW))
    failsWith('time_out_of_range', () => buildRule({ title: 't', prompt: 'p', monthly: monthly(32) }, NOW))
  })
})

describe('projection helpers', () => {
  const record: ScheduledTaskRecord = {
    id: '9e1c2a44-0000-4000-8000-1f2f3f4f5f6f',
    title: '每日总结',
    prompt: '总结工作区每个项目的状态',
    rule: { kind: 'daily', time: '23:05', time_zone: SHANGHAI, scheduledAt: new Date(at09('2026-03-07')).toISOString() },
    status: 'active',
    sessionId: 'session-x',
    createdAt: '2026-03-06T00:00:00.000Z',
    confirmBeforeChange: true,
  }

  it('framing carries the prompt verbatim inside task_prompt_json', () => {
    const text = renderTaskFraming(record)
    assert.match(text, /\[SCHEDULED TASK\]/)
    assert.match(text, /task_prompt_json:/)
    assert.ok(text.includes('总结工作区每个项目的状态'))
  })

  it('view projects identity, timing state, and carry fields', () => {
    const view = scheduledTaskView(record, NOW)
    assert.equal(view.id, record.id)
    assert.equal(view.title, record.title)
    assert.equal(view.prompt, record.prompt)
    assert.equal(view.status, 'active')
    assert.equal(view.confirmBeforeChange, true)
    assert.equal(view.state, 'scheduled')
    assert.equal(view.unread, false)
  })

  it('flags run-but-unread sessions and overdue targets', () => {
    const ran: ScheduledTaskRecord = {
      ...record,
      lastRunAt: new Date(NOW - DAY).toISOString(),
      rule: { ...record.rule, scheduledAt: new Date(NOW + HOUR).toISOString() },
    }
    const ranView = scheduledTaskView(ran, NOW)
    assert.equal(ranView.unread, true)
    assert.equal(ranView.state, 'scheduled')

    const seenAndDue: ScheduledTaskRecord = {
      ...record,
      lastRunAt: new Date(NOW).toISOString(),
      lastReadAt: new Date(NOW).toISOString(),
      rule: { kind: 'daily', time: '09:00', time_zone: SHANGHAI, scheduledAt: new Date(NOW - HOUR).toISOString() },
    }
    const dueView = scheduledTaskView(seenAndDue, NOW)
    assert.equal(dueView.unread, false)
    assert.equal(dueView.state, 'overdue')
  })

  it('hides nextRunAt for paused tasks and surfaces lastError', () => {
    // Paused at a past instant: the stored schedule would render as a stale
    // "next run", so the projection must omit it until the task resumes.
    const paused: ScheduledTaskRecord = {
      ...record,
      status: 'paused',
      rule: { ...record.rule, scheduledAt: new Date(NOW - HOUR).toISOString() },
    }
    const pausedView = scheduledTaskView(paused, NOW)
    assert.equal(pausedView.nextRunAt, undefined)
    assert.equal(pausedView.state, 'scheduled')
    assert.equal('lastError' in pausedView, false)

    const failed: ScheduledTaskRecord = {
      ...record,
      lastError: { at: new Date(NOW).toISOString(), message: 'boom' },
    }
    const failedView = scheduledTaskView(failed, NOW)
    assert.deepEqual(failedView.lastError, { at: new Date(NOW).toISOString(), message: 'boom' })
    assert.equal(scheduledTaskView(record, NOW).lastError, undefined)
  })
})
