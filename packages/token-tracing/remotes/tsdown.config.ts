/**
 * Standalone browser-bundle config for the external token-tracing remotes plugin.
 *
 * Same story as the scheduled-task configs: the dsh repo's `clientBundle`
 * preset hard-pins its workspace manifest to the dsh checkout, so it cannot
 * see this external package. This config emits a single CJS browser row at
 * lib/client.js that registers under the plugin id and mounts the vendored
 * tokenTracing Remote contribution, with `zod` bundled inline (the mounted
 * descriptors carry their schemas).
 *
 * Run from this directory: `<dsh>/node_modules/.bin/tsdown`.
 */

import { defineConfig } from 'tsdown'

/** Plugin id stamped into the __ModuleLoader__.load registration handoff. */
const PLUGIN_ID = '@qihongmu/dsh-client-remotes-token-tracing'

export default defineConfig({
  name: `${PLUGIN_ID}/client`,
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
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
