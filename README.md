# dsh-plugins

User-authored external plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness),
loaded through a `dsh` profile as ordinary Cordis plugins — the `dsh` library is never edited.

This repository is the home of **more than one** plugin: every plugin lives in its
own directory under `packages/<plugin>/` and is split into three workspace packages —
a **host** half (node side: Service, scheduler, durable domain, Remote surface),
a **remotes** assembly (browser side: mounts the plugin's Remote contribution, the
plugin-scoped counterpart of the in-repo `dsh-api-remotes` assembly), and a
**client** half (browser side: the UI bundle served by `dsh web`, typically a
sidebar panel).

## Layout

```
dsh-plugins/
├── package.json                # root scripts (build / typecheck / verify)
├── pnpm-workspace.yaml         # packages/*/*  (one package per plugin half)
├── tsconfig.host.json          # host-face aggregate: references every packages/*/host
├── tsconfig.client.json        # client-face aggregate: references every packages/*/{client,remotes}
├── scripts/
│   ├── gen-typert.mjs          # typert probe (see "Typert constraint" below)
│   └── verify-remote.mjs       # verifies every host package's @Remote surface
├── FEASIBILITY.md              # feasibility record (external-plugin constraints)
└── packages/
    └── scheduled-task/         # the one shipped plugin: scheduled tasks sidebar panel
        ├── README.md
        ├── host/               # @deepseek-ai/dsh-plugins-scheduled-task
        │   ├── package.json
        │   ├── tsconfig.json
        │   ├── src/            # index (Service), domain, spec, types, invariant
        │   └── lib/            # tsc output + vendored typert.remote-client.{js,d.ts}
        ├── remotes/            # @deepseek-ai/dsh-client-remotes-scheduled-task
        │   ├── package.json
        │   ├── tsconfig.json
        │   ├── tsdown.config.ts
        │   ├── src/            # node half entry + client/ (mounts ./remote contribution)
        │   └── lib/            # tsc output + tsdown client.js bundle
        └── client/             # @deepseek-ai/dsh-client-ui-scheduled-task
            ├── package.json
            ├── tsconfig.json
            ├── tsdown.config.ts
            ├── src/            # node half entry + client/ (panel, slots, locales, bundle)
            └── lib/            # tsc output + tsdown client.js bundle
```

## Naming conventions

| Half    | Package name pattern                 | Example (scheduled-task)                         |
| ------- | ------------------------------------ | ------------------------------------------------ |
| host    | `@deepseek-ai/dsh-plugins-<name>`    | `@deepseek-ai/dsh-plugins-scheduled-task`        |
| remotes | `@deepseek-ai/dsh-client-remotes-<name>` | `@deepseek-ai/dsh-client-remotes-scheduled-task` |
| client  | `@deepseek-ai/dsh-client-ui-<name>`  | `@deepseek-ai/dsh-client-ui-scheduled-task`      |

Package ids are stable references used by the runtime profile (`cordis.patch.yml`)
and by the vendored typert artifacts; do not rename them casually.

## Setup

This workspace builds against a **local checkout of DeepSeek Harness** (its
`tsconfig.base*.json` doubles as a source-level resolution facade, and its
installed `node_modules` provides the toolchain — neither is published to npm).

```sh
# 1. get a built DSH next to this repo (or anywhere, then export DSH_ROOT)
git clone https://github.com/deepseek-ai/deepseek-harness ../deepseek-harness
cd ../deepseek-harness && pnpm install && pnpm build && cd -

# 2. link dependencies + generate tsconfig shims (idempotent)
npm run bootstrap

# 3. gates
npm run build && npm test && npm run verify
```

`bootstrap` discovers every dependency inside the DSH install tree (pnpm-nested
layouts included), symlinks it into the root `node_modules`, and writes the
gitignored `tsconfig.dsh*.generated.json` shims that all package configs
extend. Re-run it any time the DSH checkout moves or updates.

## Building and verifying

Tooling resolves from this repo's root `node_modules` (symlinks created by
`npm run bootstrap`; see FEASIBILITY.md for how the resolution chain works).

```sh
npm run build       # tsc -b tsconfig.host.json && tsc -b tsconfig.client.json
npm run typecheck   # alias of build
npm run test        # node:test unit suites (host domain + record schema)
npm run verify      # load every host package in Node and print its Remote surface
npm run gen:typert  # probe the DSH typert generator against this workspace
```

## Adding a new plugin

1. **Create the directories**: `packages/<name>/host`, `packages/<name>/remotes`,
   `packages/<name>/client`.
2. **Write the host package** (`host/package.json`, `host/tsconfig.json`, `host/src/`):
   - Copy the shape of `packages/scheduled-task/host` (extends the DSH base
     tsconfig with `"paths": {}`; exports `.` / `./invariant` / `./types` /
     `./remote`).
   - Name it `@deepseek-ai/dsh-plugins-<name>`.
   - The Service extends `TypertRemoteService` and exposes `@Remote` methods.
3. **Write the remotes assembly** (`remotes/package.json`, `remotes/tsconfig.json`,
   `remotes/tsdown.config.ts`, `remotes/src/`):
   - Copy the shape of `packages/scheduled-task/remotes`; name it
     `@deepseek-ai/dsh-client-remotes-<name>`.
   - Its client apply mounts the vendored `./remote` contribution via
     `ctx.remote.$mount(...)` with `inject = ['remote']`.
4. **Write the client package** (`client/package.json`, `client/tsconfig.json`,
   `client/tsdown.config.ts`, `client/src/`):
   - Copy the shape of `packages/scheduled-task/client`.
   - In `client/tsconfig.json`, point the `paths` for
     `@deepseek-ai/dsh-plugins-<name>/remote` and `.../types` at the **host
     sibling** (`../host/lib/...`).
   - The UI apply must declare `remote.<namespace>` in its `inject` list
     (cordis grants `ctx.remote.<namespace>` reads only to fibers that declared
     them — and only when a *different*, earlier-activated entry provided the
     namespace; that is the remotes assembly's job).
5. **Register the halves in the aggregates**:
   - Add `{ "path": "./packages/<name>/host" }` to `tsconfig.host.json` and
     `{ "path": "./packages/<name>/client" }` plus
     `{ "path": "./packages/<name>/remotes" }` to `tsconfig.client.json`.
6. **Vendor the typert `./remote` contribution** (see constraint below):
   - host: `packages/<name>/host/lib/typert.remote-client.{js,d.ts}`
   - remotes: `packages/<name>/remotes/src/client/remote-client.{js,d.ts}`
   - Both must declare the `@deepseek-ai/dsh-plugins-<name>/types` imports with
     the host package's real name; the remotes copy carries the schemas into
     its bundle.
7. **Register in the runtime profile** (outside this repo, in `~/.dsh`):
   - Symlink `~/.dsh/profiles/node_modules/@deepseek-ai/dsh-plugins-<name>` →
     `packages/<name>/host`, `.../dsh-client-remotes-<name>` →
     `packages/<name>/remotes`, and `.../dsh-client-ui-<name>` →
     `packages/<name>/client`.
   - Add the three rows to `~/.dsh/profiles/web/cordis.patch.yml`
     (`plugins-<name>` + `plugins-remotes-<name>` + `plugins-ui-<name>`).
8. **Build and verify**: `npm run build && npm run verify`, then restart `dsh web`.

## Typert constraint

The DSH typert generator only emits artifacts for packages whose *meta symbols*
(`TypertRemoteService`, `@Remote`, ...) analyze inside `root/packages` — a
requirement no external plugin repo can meet without vendoring DSH's meta source.
So `./remote` artifacts are **vendored by hand** rather than regenerated
(FEASIBILITY.md documents the full reasoning). `scripts/gen-typert.mjs` proves
the discovery half still works; `npm run verify` proves the vendored surfaces
still register.