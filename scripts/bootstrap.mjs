/**
 * One-time workspace setup: link this external plugin workspace against a local
 * DeepSeek Harness checkout so build / test / verify run anywhere.
 *
 * What it does (idempotent — safe to re-run):
 *   1. locates the DSH checkout (`DSH_ROOT` env or a `../deepseek-harness`
 *      sibling; see scripts/lib/dsh-root.mjs),
 *   2. symlinks every runtime/build dependency into the root node_modules by
 *      DISCOVERING each package inside the DSH install tree (candidates are
 *      resolved through Node from `apps/cli`, then realpath-normalized onto
 *      the true workspace package), plus the three self-referencing plugin
 *      halves,
 *   3. writes two gitignored tsconfig shims (`tsconfig.dsh.generated.json`,
 *      `tsconfig.dsh.client.generated.json`) that extend the upstream base
 *      configs in place — the upstream bases expose the monorepo as a
 *      source-level resolution facade whose `paths` are relative to their own
 *      location, so they must be extended where they live, not copied.
 *
 * Run from the repository root:  npm run bootstrap
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'
import { dshPath, repoRoot, resolveDshRoot } from './lib/dsh-root.mjs'

/** @deepseek-ai packages this workspace compiles against or loads at runtime. */
const SCOPED_PACKAGES = [
  'cordis',
  'dsh-agent',
  'dsh-agent-default-model',
  'dsh-agent-presets',
  'dsh-api-gateway',
  'dsh-api-remotes',
  'dsh-api-session-controller',
  'dsh-api-workspace-controller',
  'dsh-brand',
  'dsh-client-locale',
  'dsh-client-ui-conversation',
  'dsh-client-ui-primitives',
  'dsh-client-ui-renderer',
  'dsh-client-ui-sidebar',
  'dsh-client-ui-slots',
  'dsh-compaction',
  'dsh-invariants',
  'dsh-llm',
  'dsh-llm-retry',
  'dsh-schedule',
  'dsh-session',
  'dsh-session-query',
  'dsh-session-title',
  'dsh-storage',
  'dsh-storage-domain',
  'dsh-storage-json',
  'dsh-token-meter',
  'dsh-typert-protocol',
  'dsh-user-approval',
  'dsh-workspace',
]

/** Toolchain/runtime packages discovered in the DSH install tree. */
const TOP_LEVEL_PACKAGES = [
  '@types/node',
  '@types/react',
  '@types/react-dom',
  'lightningcss',
  'react',
  'tsdown',
  'tsx',
  'typescript',
  'zod',
]

/** Self-references between this workspace's own halves (name → local dir). */
const SELF_LINKS = new Map([
  ['@qihongmu/dsh-plugins-scheduled-task', 'packages/scheduled-task/host'],
  ['@qihongmu/dsh-client-remotes-scheduled-task', 'packages/scheduled-task/remotes'],
  ['@qihongmu/dsh-client-ui-scheduled-task', 'packages/scheduled-task/client'],
  ['@qihongmu/dsh-plugins-token-tracing', 'packages/token-tracing/host'],
  ['@qihongmu/dsh-client-remotes-token-tracing', 'packages/token-tracing/remotes'],
  ['@qihongmu/dsh-client-ui-token-tracing', 'packages/token-tracing/client'],
])

/**
 * Discover package directories inside the DSH checkout by scanning its install
 * tree. pnpm nests installs at arbitrary depths
 * (`apps/cli/node_modules/@scope/a/node_modules/@scope/b/...`, plus a
 * content-addressed `.pnpm` store), which Node's resolver cannot see from an
 * app anchor. This walks the tree breadth-first with a tiny state machine so a
 * name only ever matches in a legitimate position:
 *   - bare names (`react`, `zod`, ...) directly inside a `node_modules` dir,
 *   - scoped names (`@deepseek-ai/x`) inside `@deepseek-ai/` which itself sits
 *     directly inside a `node_modules` dir,
 * descending through `.pnpm`, nested `node_modules`, scope folders, and
 * (unmatched) package dirs to reach nested installs. The shallowest match per
 * name wins and is realpath-normalized onto the true workspace package.
 */
function discoverPackages(dshRoot, wanted) {
  const found = new Map()
  const seeds = [
    join(dshRoot, 'apps', 'cli', 'node_modules'),
    join(dshRoot, 'node_modules'),
    join(dshRoot, 'vendor'),
  ].filter(dir => existsSync(dir))
  // kind: 'modules' = a node_modules dir; 'scope' = @scope dir inside one;
  // 'pnpm' = the .pnpm store dir; 'package' = an installed package dir.
  const queue = seeds.map(dir => ({ dir, depth: 0, kind: 'modules' }))
  const MAX_DEPTH = 16
  let visited = 0

  const tryRecord = (name, dir) => {
    if (!wanted.has(name) || found.has(name)) return false
    if (!existsSync(join(dir, 'package.json'))) return false
    try {
      found.set(name, realpathSync(dir))
    } catch {
      found.set(name, dir)
    }
    return true
  }
  const pushIf = (dir, depth, kind, condition) => {
    if (condition && depth < MAX_DEPTH) queue.push({ dir, depth: depth + 1, kind })
  }

  while (queue.length > 0 && visited < 50_000 && found.size < wanted.size) {
    const { dir, depth, kind } = queue.shift()
    visited += 1
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      const child = join(dir, entry.name)
      if (kind === 'modules') {
        if (tryRecord(entry.name, child)) continue
        if (entry.name.startsWith('@')) {
          pushIf(child, depth, 'scope', true)
        } else if (entry.name === 'node_modules' || entry.name === '.pnpm') {
          pushIf(child, depth, 'modules', true)
        } else {
          pushIf(child, depth, 'package', entry.isDirectory())
        }
      } else if (kind === 'scope') {
        // dir itself is the "@scope" folder, so compose "@scope/<name>".
        if (tryRecord(`${basename(dir)}/${entry.name}`, child)) continue
        pushIf(child, depth, 'package', entry.isDirectory())
      } else if (kind === 'pnpm') {
        pushIf(child, depth, 'package', entry.isDirectory())
      } else {
        // 'package': its only interesting child is a nested node_modules.
        if (entry.name === 'node_modules') pushIf(child, depth, 'modules', true)
      }
    }
  }
  return found

  function entriesWhere(dir) {
    try {
      return readdirSync(dir, { withFileTypes: true }).map(d => ({ path: join(dir, d.name) }))
    } catch {
      return []
    }
  }
}

/**
 * Create or refresh one symlink (idempotent). Skips when an existing link
 * already resolves to the same package, and downgrades sandbox/permission
 * failures on PRE-EXISTING correct links to warnings so a locked-down
 * environment (or root-owned node_modules) never blocks setup.
 */
function forceLink(linkPath, targetDir, skipped = []) {
  mkdirSync(dirname(linkPath), { recursive: true })
  try {
    if (existsSync(linkPath) && realpathSync(linkPath) === targetDir) {
      skipped.push(linkPath)
      return
    }
  } catch { /* dangling link — refresh below */ }
  try {
    rmSync(linkPath, { force: true })
    symlinkSync(targetDir, linkPath, 'dir')
  } catch (error) {
    if (existsSync(linkPath) && error.code === 'EPERM') {
      console.warn(`[bootstrap] kept existing link ${linkPath} (relink denied: ${error.code})`)
      return
    }
    throw error
  }
}

/** Write one generated shim extending an upstream base config, in place. */
function writeShim(shimName, upstreamBase) {
  let rel = relative(repoRoot, dshPath(upstreamBase))
  if (!rel.startsWith('.')) rel = `./${rel}`
  writeFileSync(join(repoRoot, shimName), `${JSON.stringify({ extends: rel.split(sep).join('/') }, null, 2)}\n`)
  console.log(`[bootstrap] ${shimName} -> ${rel}`)
}

const DSH_ROOT = resolveDshRoot()
console.log(`[bootstrap] DSH_ROOT = ${DSH_ROOT}`)

const modulesDir = join(repoRoot, 'node_modules')
mkdirSync(modulesDir, { recursive: true })

const requested = new Set([...SCOPED_PACKAGES.map(n => `@deepseek-ai/${n}`), ...TOP_LEVEL_PACKAGES])
const discovered = discoverPackages(DSH_ROOT, requested)

const missing = [...requested].filter(name => !discovered.has(name))
const skipped = []
for (const name of requested) {
  const target = discovered.get(name)
  if (target === undefined) continue
  const linkPath = name.startsWith('@deepseek-ai/')
    ? join(modulesDir, '@deepseek-ai', name.slice('@deepseek-ai/'.length))
    : join(modulesDir, name)
  forceLink(linkPath, target, skipped)
}
if (missing.length > 0) {
  console.error(`[bootstrap] could not discover: ${missing.join(', ')}`)
  console.error('[bootstrap] is the DSH checkout built (pnpm install + build)? See README "Setup".')
  process.exitCode = 1
}

for (const [name, local] of SELF_LINKS) {
  forceLink(join(modulesDir, name), join(repoRoot, local))
}

writeShim('tsconfig.dsh.generated.json', 'tsconfig.base.json')
writeShim('tsconfig.dsh.client.generated.json', 'tsconfig.base.client.json')

console.log(`[bootstrap] links refreshed; ${skipped.length} already up-to-date`)
console.log('[bootstrap] done — next: npm run build && npm test && npm run verify')
