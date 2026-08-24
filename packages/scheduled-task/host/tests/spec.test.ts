/**
 * Unit tests for the durable-record zod schema: accepts every rule kind with
 * carry fields, rejects malformed selectors and out-of-domain values.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { scheduledTaskRecord } from '../src/spec.ts'

const BASE = {
  id: '9e1c2a44-0000-4000-8000-1f2f3f4f5f6f',
  title: '每日总结',
  prompt: '总结工作区每个项目的状态',
  status: 'active',
  sessionId: 'session-x',
  createdAt: '2026-03-06T00:00:00.000Z',
  confirmBeforeChange: false,
}

describe('scheduledTaskRecord schema', () => {
  it('accepts a complete record for every rule kind', () => {
    const rules = [
      { kind: 'after', afterSeconds: 300, scheduledAt: '2026-03-06T04:17:33.000Z' },
      { kind: 'at', scheduledAt: '2026-03-07T01:00:00.000Z' },
      { kind: 'every', everySeconds: 3600, scheduledAt: '2026-03-06T05:12:33.000Z' },
      { kind: 'hourly', minute: 30, scheduledAt: '2026-03-06T04:30:00.000Z' },
      { kind: 'daily', time: '09:00', time_zone: 'Asia/Shanghai', scheduledAt: '2026-03-07T01:00:00.000Z' },
      {
        kind: 'weekly', weekdays: [1, 2, 3, 4, 5], time: '09:00',
        time_zone: 'Asia/Shanghai', scheduledAt: '2026-03-09T01:00:00.000Z',
      },
      { kind: 'monthly', dayOfMonth: 31, time: '09:00', time_zone: 'Asia/Shanghai', scheduledAt: '2026-03-31T01:00:00.000Z' },
    ]
    for (const rule of rules) {
      const parsed = scheduledTaskRecord.safeParse({ ...BASE, rule })
      assert.ok(parsed.success, `rule ${rule.kind} should parse: ${JSON.stringify(parsed.error?.issues)}`)
    }
  })

  it('accepts optional carry fields (workspace/model/confirm)', () => {
    const parsed = scheduledTaskRecord.safeParse({
      ...BASE,
      rule: { kind: 'daily', time: '23:05', time_zone: 'Asia/Singapore', scheduledAt: '2026-03-06T15:05:00.000Z' },
      workspaceId: '11111111-2222-4333-8444-555555555555',
      cwd: '/opt/demo-workspace',
      model: { provider: 'openrouter', model: 'stealth/ox-alpha' },
      confirmBeforeChange: true,
      lastRunAt: '2026-03-06T15:05:00.003Z',
    })
    assert.ok(parsed.success)
    assert.equal(parsed.data.model?.model, 'stealth/ox-alpha')
  })

  it('rejects malformed rules and out-of-domain values', () => {
    const badRules = [
      { kind: 'hourly', minute: 60, scheduledAt: 'x' },
      { kind: 'weekly', weekdays: [], time: '09:00', time_zone: 'UTC', scheduledAt: 'x' },
      { kind: 'weekly', weekdays: [8], time: '09:00', time_zone: 'UTC', scheduledAt: 'x' },
      { kind: 'monthly', dayOfMonth: 32, time: '09:00', time_zone: 'UTC', scheduledAt: 'x' },
      { kind: 'every', everySeconds: 299, scheduledAt: 'x' },
      { kind: 'unknown-kind', scheduledAt: 'x' },
    ]
    for (const rule of badRules) {
      assert.ok(!scheduledTaskRecord.safeParse({ ...BASE, rule }).success, `should reject ${JSON.stringify(rule)}`)
    }
  })

  it('rejects empty title/prompt, bad status, and missing confirm flag', () => {
    for (const patch of [
      { title: '' },
      { prompt: '' },
      { status: 'running' },
      { confirmBeforeChange: undefined },
    ]) {
      const candidate = { ...BASE, rule: { kind: 'at', scheduledAt: 'x' }, ...patch }
      if (patch.confirmBeforeChange === undefined) delete (candidate as Record<string, unknown>).confirmBeforeChange
      assert.ok(!scheduledTaskRecord.safeParse(candidate).success, `should reject ${JSON.stringify(patch)}`)
    }
  })
})
