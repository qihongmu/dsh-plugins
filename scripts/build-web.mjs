/**
 * Build the browser halves' `lib/client.js` bundles with the tsdown install of
 * the local DSH checkout. The tsc aggregate build (`npm run build`) only emits
 * typechecked lib/ output for node consumption; the browser bundles are built
 * by each half's standalone tsdown.config.ts (see that file for why the dsh
 * `clientBundle` preset cannot be reused). Run from the repository root:
 *   npm run build:web
 *
 * Discovers the packages to bundle from the tsconfig.client.json references —
 * the browser halves — mirroring how `npm run verify` discovers host packages
 * from tsconfig.host.json. After each build, asserts lib/client.js exists and
 * self-registers under the package name via `window.__ModuleLoader__.load`.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { repoRoot, dshPath } from './lib/dsh-root.mjs'

const tsdownBin = dshPath('node_modules', 'tsdown', 'dist', 'run.mjs')
if (!existsSync(tsdownBin)) {
  console.error('[build:web] tsdown not found in the DSH checkout — run `npm run bootstrap` first.')
  process.exit(1)
}

const aggregate = JSON.parse(readFileSync(join(repoRoot, 'tsconfig.client.json'), 'utf8'))
const references = (aggregate.references ?? []).map(reference => reference.path)
if (references.length === 0) {
  console.error('[build:web] no browser halves discovered from tsconfig.client.json references')
  process.exit(1)
}

let failures = 0
for (const referencePath of references) {
  const packageDir = join(repoRoot, referencePath)
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
  console.log(`[build:web] ${manifest.name} (${referencePath})`)

  const result = spawnSync(process.execPath, [tsdownBin], {
    cwd: packageDir,
    stdio: 'inherit',
  })
  if (result.status !== 0) {
    failures += 1
    console.error(`[FAIL] ${manifest.name}: tsdown exited with status ${result.status}`)
    continue
  }

  // The module system resolves exports["./client"] at lib/client.js and only
  // records the factory registration; the bundle must execute its own
  // `__ModuleLoader__.load` handoff stamped with the package name. tsdown may
  // reformat the banner, so match on content, not layout.
  const bundle = join(packageDir, 'lib', 'client.js')
  if (!existsSync(bundle)) {
    failures += 1
    console.error(`[FAIL] ${manifest.name}: lib/client.js was not produced`)
    continue
  }
  const code = readFileSync(bundle, 'utf8')
  if (!code.includes('__ModuleLoader__.load(') || !code.includes(`"${manifest.name}"`)) {
    failures += 1
    console.error(`[FAIL] ${manifest.name}: lib/client.js is missing the __ModuleLoader__ registration banner`)
    continue
  }
  console.log(`[ok] ${manifest.name}: lib/client.js`)
}

if (failures > 0) {
  console.error(`\n${failures} browser bundle(s) failed`)
  process.exit(1)
}
console.log('\nall browser bundles built')
