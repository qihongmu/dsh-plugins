/**
 * Resolve the local DeepSeek Harness checkout this external plugin workspace
 * builds against.
 *
 * Resolution order:
 *   1. `DSH_ROOT` environment variable (recommended; set it once per shell or
 *      in `.profile`),
 *   2. a `deepseek-harness/` checkout cloned as a sibling of THIS repository,
 *   3. otherwise: fail with setup instructions.
 *
 * The DSH checkout is required because the upstream `tsconfig.base*.json`
 * exposes the whole monorepo as a source-level resolution facade (`paths`
 * entries are relative to that file), and because toolchain binaries (tsc,
 * tsx, tsdown, lightningcss) come from its installed node_modules.
 */

import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repository root (the directory containing this file's ../..). */
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/** Locate the DSH checkout or throw with actionable setup instructions. */
export function resolveDshRoot() {
  const candidates = []
  if (process.env.DSH_ROOT !== undefined && process.env.DSH_ROOT !== '') {
    candidates.push(resolve(process.env.DSH_ROOT))
  }
  candidates.push(resolve(repoRoot, '..', 'deepseek-harness'))
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  throw new Error(
    'Cannot locate a DeepSeek Harness checkout.\n'
    + 'This workspace builds against a local clone of https://github.com/deepseek-ai/deepseek-harness.\n'
    + 'Either:\n'
    + '  - export DSH_ROOT=/path/to/deepseek-harness   (a built checkout), or\n'
    + `  - clone it as a sibling:  git clone https://github.com/deepseek-ai/deepseek-harness ${resolve(repoRoot, '..', 'deepseek-harness')}\n`
    + 'then re-run:  npm run bootstrap',
  )
}

/** Absolute path of one package/tool inside the DSH checkout. */
export function dshPath(...segments) {
  return join(resolveDshRoot(), ...segments)
}
