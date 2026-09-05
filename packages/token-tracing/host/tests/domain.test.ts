/**
 * Integration tests for the token-tracing domain on the real JSON storage
 * medium: the whole-unit → per-record migration (legacy bootstrap) and the
 * `backup-and-skip` salvage of a schema-invalid record. These run against the
 * harness's storage packages exactly as the host service does.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { tokenTracingDomainSpec } from '../src/spec.ts'
import type { SessionRollupRecord } from '../src/spec.ts'

const UNIT_DIR = 'token_tracing'

const valid: SessionRollupRecord = {
  sessionId: 'session-1',
  sessionCreatedAt: 1_700_000_000_000,
  lastSeq: 42,
  turns: 3,
  incompleteTurns: 1,
  totals: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  byComponent: { 'system-prompt': 100 },
  byTool: { read: 250 },
  byDay: {
    '2026-09-01': {
      turns: 3,
      incompleteTurns: 1,
      totals: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      byComponent: { 'system-prompt': 100 },
      byTool: {},
    },
  },
  firstAt: 1_700_000_000_000,
  lastAt: 1_700_000_100_000,
}

const roots: string[] = []
after(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** Fresh JSON backend root + facility over it, mirroring the host's wiring. */
async function boot(): Promise<{ root: string; facility: DomainFacility }> {
  const root = await mkdtemp(join(tmpdir(), 'token-tracing-domain-'))
  roots.push(root)
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('json', new JsonStorageBackend(root))
  const facility = new DomainFacility(ctx, { backend: 'json', routes: {} })
  return { root, facility }
}

/** Wrap a record in the per-record document envelope (version-stamped). */
function recordDoc(record: unknown): string {
  return JSON.stringify({ version: 1, record })
}

describe('token-tracing domain on the JSON medium', () => {
  it('bootstraps a legacy whole-unit file into the per-record tree', async () => {
    const { root, facility } = await boot()
    // The medium a pre-per-record plugin build left behind: one whole-unit
    // file at <root>/token_tracing.json, no record tree.
    await writeFile(join(root, `${UNIT_DIR}.json`), JSON.stringify({
      unit: { name: UNIT_DIR, version: 1 },
      global: null,
      tables: { sessions: { 'session-1': valid } },
    }))
    const domain = await facility.open(tokenTracingDomainSpec)
    const restored = await domain.table('sessions').get('session-1')
    assert.ok(restored, 'legacy record must be visible through the per-record domain')
    assert.equal(restored.turns, 3)
    // The bootstrap seeds the record tree and never touches the legacy file.
    assert.ok(existsSync(join(root, UNIT_DIR, 'sessions', 'session-1.json')), 'seeded document exists')
    assert.ok(existsSync(join(root, `${UNIT_DIR}.json`)), 'legacy file is preserved, not deleted')
    await domain.close()
  })

  it('backs up and skips a schema-invalid record instead of failing the open', async () => {
    const { root, facility } = await boot()
    const tableDir = join(root, UNIT_DIR, 'sessions')
    await mkdir(tableDir, { recursive: true })
    // Format-valid documents (version stamp accepted); the SECOND one fails
    // the record schema (negative counter) after a simulated plugin upgrade.
    await writeFile(join(tableDir, 'session-good.json'), recordDoc(valid))
    await writeFile(join(tableDir, 'session-bad.json'), recordDoc({ ...valid, sessionId: 'session-bad', turns: -1 }))
    const domain = await facility.open(tokenTracingDomainSpec)
    const table = domain.table('sessions')
    assert.ok(await table.get('session-good'), 'healthy record survives the salvage open')
    assert.equal(await table.get('session-bad'), undefined, 'schema-invalid record reads as absent')
    const moved = (await readdir(tableDir)).filter(name => name.startsWith('session-bad.json.bak.'))
    assert.equal(moved.length, 1, 'the failing document is moved aside exactly once')
    // The salvage did not wedge writes: the domain still round-trips records.
    await table.put('session-new', { ...valid, sessionId: 'session-new' })
    assert.ok(await table.get('session-new'), 'domain remains writable after salvage')
    await domain.close()
    // Reopening is stable: no second backup, no loud failure.
    const ctx = new Context()
    await ctx.plugin(Storage)
    ctx.storage.backend.register('json', new JsonStorageBackend(root))
    const reopened = await new DomainFacility(ctx, { backend: 'json', routes: {} }).open(tokenTracingDomainSpec)
    assert.ok(await reopened.table('sessions').get('session-good'))
    const movedAgain = (await readdir(tableDir)).filter(name => name.startsWith('session-bad.json.bak.'))
    assert.equal(movedAgain.length, 1, 'no duplicate backup on the next open')
    await reopened.close()
  })
})
