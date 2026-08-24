// Verify every host plugin package's @Remote surface registers + is readable.
// Discovers host packages from the workspace aggregate (tsconfig.host.json
// project references), imports each by package name, and reports its Remote
// namespace and methods. Run from the workspace root: `npm run verify`.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const aggregate = JSON.parse(readFileSync(join(root, 'tsconfig.host.json'), 'utf8'))
const references = (aggregate.references ?? []).map(reference => reference.path)

const packages = references
  .map(referencePath => {
    const manifest = JSON.parse(readFileSync(join(root, referencePath, 'package.json'), 'utf8'))
    return { name: manifest.name, referencePath }
  })
  .filter(candidate => typeof candidate.name === 'string' && candidate.name.startsWith('@deepseek-ai/'))

if (packages.length === 0) {
  console.log('no host plugin packages discovered from tsconfig.host.json references')
  process.exit(1)
}

let failures = 0
for (const { name, referencePath } of packages) {
  try {
    const { default: ServiceClass } = await import(name)
    if (typeof ServiceClass !== 'function') {
      throw new Error(`package ${name} has no default class export`)
    }
    const ctx = new Context()
    const service = new ServiceClass(ctx)
    const methods = remoteMethods(service)
    console.log(`[ok] ${name} (${referencePath})`)
    console.log(`     namespace: ${service.typertRemote?.namespace ?? '(none)'}`)
    console.log(`     methods (${methods.length}): ${methods.map(m => m.method ?? m.exportName).join(', ') || '(none)'}`)
  } catch (error) {
    failures += 1
    console.error(`[FAIL] ${name} (${referencePath}): ${error instanceof Error ? error.message : String(error)}`)
  }
}
if (failures > 0) {
  console.error(`\n${failures} host package(s) failed verification`)
  process.exit(1)
}
console.log('\nall host plugin packages verified')