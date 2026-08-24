// Typert probe: ask the DSH generator what it can see in this workspace.
//
// IMPORTANT: this is a diagnostics script, not the artifact pipeline. The DSH
// typert generator only recognizes the meta symbols (TypertRemoteService,
// @Remote, ...) when their declarations resolve into `root/packages` (see
// FEASIBILITY.md "The blocking constraint"), so for an external plugin repo it
// emits NO remote artifacts. The `./remote` contributions (host + client) are
// therefore vendored by hand:
//   packages/<plugin>/host/lib/typert.remote-client.{js,d.ts}
//   packages/<plugin>/remotes/src/client/remote-client.{js,d.ts}
// Keep their package-scope imports pointing at the host package name, and keep
// their zod schemas in sync with host/src/types.ts.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { dshPath, resolveDshRoot } from './lib/dsh-root.mjs'

const generatorEntry = join(dshPath('packages', 'typert', 'generator'), 'lib/types/workspace.js')
if (!existsSync(generatorEntry)) {
  console.error(`[gen-typert] generator not built in the DSH checkout: ${generatorEntry}`)
  console.error('[gen-typert] build DSH first (pnpm install && pnpm build).')
  process.exit(1)
}
const { WorkspaceTypertGenerator } = await import(generatorEntry)

const root = resolveDshRoot()
const generator = new WorkspaceTypertGenerator(root)

for (const face of ['host', 'client']) {
  const discovered = generator.discover([face])
  console.log(`faces[${face}] discovered:`, JSON.stringify(discovered.map(p => ({ package: p.package, root: p.root }))))
  const selected = discovered.map(p => p.package)
  const artifacts = generator.generate(selected, [face])
  console.log(`faces[${face}] artifacts:`, JSON.stringify(artifacts.map(a => ({ package: a.package, face: a.face, hasRemote: a.remote !== undefined }))))
}
console.log(`\nprobe done (workspace root: ${root})`)
