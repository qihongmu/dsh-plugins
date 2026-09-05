# Client bundle contract (`lib/client.js`)

Every dsh client plugin bundle (served at `/plugins/.../client.js` in the
combo graph) must **self-register** the moment the script executes:

```js
window.__ModuleLoader__.load({ id: "<package-name>", factory: (require) => {
  // ...bundle body (CommonJS style)...
  return module.exports;
} });
```

The module system only records the factory; all side effects (slot
registration, remote mounting) run at first materialization. If the wrapper
is missing, the page logs
`failed to import loader entry … loaded without registering "<pkg>" via __ModuleLoader__.load`
even though compile/start succeed — check this exact string in the browser
console before suspecting UI code.

## Hand-written tsdown config

The shared preset `clientBundle()` in
`deepseek-harness/packages/client/tsdown.client.ts` emits the wrapper
automatically, but it pins the dsh checkout's workspace manifest, so external
plugins usually cannot use it. Reproduce it in `outputOptions`:

- **banner:** `window.__ModuleLoader__.load({ id: "<package-name>", factory: (require) => {`
- **footer:** `return module.exports; } });`
- **intro:** `var module = { exports: {} }; var exports = module.exports;`

The `id` is the package's **own npm name** (e.g. the UI half registers as
`@qihongmu/dsh-client-ui-scheduled-task`; both existing configs keep it in a
`PLUGIN_ID` const). Don't confuse it with the short insert ids in
`cordis.patch.yml` (`plugins-ui-scheduled-task` …) — those are profile layer
ids, a different namespace.

## Externals

Bare specifiers inside a client bundle only work if dsh's browser **module
table** provides them (no `dsh.client.inject` request needed for seed
entries). Two lists govern this, both living outside this repo — check them
before adding a new bare import:

- **Runtime module table** (what `require` inside the wrapper can resolve):
  `deepseek-harness/packages/client/web/src/platform.ts` is the single
  upstream source.
- **Compile-time links** (what typecheck can see):
  `SCOPED_PACKAGES` in `scripts/bootstrap.mjs` — new dsh-facing imports need
  an entry there too, and a missing one fails only on a clean runner (the
  dev machine's node_modules masks it; this is why `npm run ci:local`
  exists).

Anything not in the module table must be **inlined into the bundle** or
declared as a request, or it throws at require time.

Migration note (rc → 0.1.2-alpha line): `@deepseek-ai/dsh-client-runtime`
was removed upstream; `ctx.slots` now comes from `@deepseek-ai/dsh-client-ui-renderer`
and the `ctx.remote` merge from `@deepseek-ai/dsh-api-remotes/client`. When
a pinned dsh ref moves, re-check platform.ts for renames like these before
trusting an old bundle.

## Fast check without a browser

Load the built `lib/client.js` in Node with a stubbed loader:

```js
globalThis.window = { __ModuleLoader__: { load: (reg) => reg.factory(requireTableStub) } };
require('./lib/client.js');   // asserts registration id, exports (apply/inject), every bare require resolves
```

`scripts/verify-remote.mjs` (`npm run verify`) is the repo's version of this
check for the remote surface; extend it when the client calls new
`ctx.remote` methods.

## Release hygiene for bundles

- `sourcemap: false`; exclude `*.map` / `*.tsbuildinfo` from the tarball.
- cssModules virtual module ids must be package-relative paths, not absolute
  build-machine paths (they leak into the published bundle otherwise).
