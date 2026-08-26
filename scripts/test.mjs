/**
 * Test runner wrapper: executes the node:test suites through the `tsx` loader
 * shipped inside the local DSH checkout, so no toolchain needs to be installed
 * in this repository. Run from the repository root:  npm test
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { repoRoot } from './lib/dsh-root.mjs'

const tsxBin = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
if (!existsSync(tsxBin)) {
  console.error('[test] tsx not linked — run `npm run bootstrap` first.')
  process.exit(1)
}

const testRoots = [
  join(repoRoot, 'packages', 'scheduled-task', 'host', 'tests'),
  join(repoRoot, 'packages', 'scheduled-task', 'client', 'tests'),
]
const files = testRoots.flatMap(root => readdirSync(root)
  .filter(file => file.endsWith('.test.ts'))
  .map(file => join(root, file)))
  .sort()
if (files.length === 0) {
  console.error(`[test] no *.test.ts found under ${testRoots.join(', ')}`)
  process.exit(1)
}

const result = spawnSync(process.execPath, [tsxBin, '--test', ...files], {
  stdio: 'inherit',
})
process.exit(result.status ?? 1)
