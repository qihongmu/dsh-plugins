/**
 * Standalone browser-bundle config for the external scheduled-task UI plugin.
 *
 * The dsh repo's `clientBundle` preset hard-pins its workspace manifest to the
 * dsh checkout (`REPOSITORY_ROOT`), so it can no longer see external plugin
 * manifests. This config reproduces only what this package needs:
 *   - CJS browser bundle at lib/client.js (served at /plugins/<id>/client.js),
 *   - `react` and the shared UI primitives stay external (runtime module table),
 *   - `.module.css` compiles through lightningcss with the same `[hash]_[local]`
 *     pattern the preset used, emitting a virtual module that exports the
 *     hashed class map and injects the stylesheet into document.head.
 *
 * Run from this directory: `<dsh>/node_modules/.bin/tsdown`.
 */

import { readFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { defineConfig, type Plugin } from 'tsdown'

// This workspace builds against a local DSH checkout (see scripts/bootstrap.mjs
// and README "Setup"); toolchain packages resolve through that checkout's
// node_modules. `lightningcss` is a transitive dep of the DSH tsdown install.
const REPO_ROOT = resolve(dirname(import.meta.url), '../..')
const DSH_ROOT = process.env.DSH_ROOT ?? resolve(REPO_ROOT, '..', 'deepseek-harness')
const dshRequire = createRequire(join(DSH_ROOT, 'package.json'))
const { transform } = dshRequire('lightningcss') as {
  transform: (options: Record<string, unknown>) => { code: Buffer; exports?: Record<string, { name: string }> }
}

const CSS_PREFIX = '\0dsh-plugin-css:'
const CSS_SUFFIX = '.dshcss.js'

// Virtual ids must stay package-relative: they surface verbatim in rolldown's
// `//#region` comments inside the shipped lib/client.js, and an absolute id
// would leak the build machine's paths into the published tarball.
const PKG_ROOT = process.cwd()

/** Plugin id stamped into the __ModuleLoader__.load registration handoff. */
const PLUGIN_ID = '@qihongmu/dsh-client-ui-scheduled-task'

/**
 * Compile one `.module.css` into a class-map module that self-injects its CSS.
 * The virtual `\0`-prefixed, non-`.css` id keeps tsdown's own CSS pipeline
 * from grabbing the file first.
 */
function cssModules(): Plugin {
  return {
    name: 'external-dsh-css-modules',
    resolveId(source, importer) {
      if (!source.endsWith('.module.css') || importer === undefined) return null
      if (source.startsWith('.')) {
        return `${CSS_PREFIX}${relative(PKG_ROOT, resolve(dirname(importer), source))}${CSS_SUFFIX}`
      }
      return null
    },
    load(id) {
      if (!id.startsWith(CSS_PREFIX) || !id.endsWith(CSS_SUFFIX)) return null
      const file = resolve(PKG_ROOT, id.slice(CSS_PREFIX.length, -CSS_SUFFIX.length))
      const sourceName = basename(file)
      const result = transform({
        filename: file,
        code: Buffer.from(readFileSync(file)),
        cssModules: { pattern: '[hash]_[local]' },
      })
      const classes = Object.fromEntries(
        Object.entries(result.exports ?? {}).map(([local, exported]) => [local, exported.name]),
      )
      const css = Buffer.from(result.code).toString('utf8')
      return [
        `const classes = ${JSON.stringify(classes)};`,
        `if (typeof document !== 'undefined' && !document.querySelector('style[data-dsh-plugin-css="${sourceName}"]')) {`,
        `  const style = document.createElement('style');`,
        `  style.setAttribute('data-dsh-plugin-css', ${JSON.stringify(sourceName)});`,
        `  style.textContent = ${JSON.stringify(css)};`,
        `  document.head.append(style);`,
        `}`,
        `export default new Proxy(classes, { get(target, key) { return target[key] ?? (${JSON.stringify(sourceName)} + '_' + String(key)); } });`,
      ].join('\n')
    },
  }
}

export default defineConfig({
  name: '@qihongmu/dsh-client-ui-scheduled-task/client',
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  // No sourcemaps in the shipped bundle: the tarball excludes *.map, so a
  // sourceMappingURL comment here would only be a dangling reference.
  sourcemap: false,
  clean: false,
  // Pin `lib/client.js`: the module table resolves exports["./client"] there.
  outputOptions: {
    entryFileNames: 'client.js',
    chunkFileNames: '[name].js',
    assetFileNames: '[name][ext]',
    // The module system only records a factory registration; executing the
    // bundle must hand `window.__ModuleLoader__.load({ id, factory })` the
    // CJS closure, exactly as the dsh clientBundle preset wraps every graph row.
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
  deps: { neverBundle: [/^react($|\/)/, /^@deepseek-ai\/dsh-client-ui-primitives($|\/)/] },
  plugins: [cssModules()],
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
})
