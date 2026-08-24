# dsh-plugins — external plugin feasibility record

Status: full `@Remote`-bridge scheduled-task plugin is built, resolvable externally, and verified
in a real headless-browser boot (sidebar entry renders and lists tasks). The workspace is
structured as a multi-plugin monorepo (see README.md): each plugin owns `packages/<plugin>/` with
`host/`, `remotes/`, and `client/` halves.

This record captures what was proven and the constraint that initially blocked a fully-external
`@Remote`-bridge scheduled-task plugin, plus the workaround that unblocked it, so future work
does not repeat the investigation.

## What was proven (works)

1. **External typecheck**. A package under `packages/*/*` that `extends` the DSH repo's
   `tsconfig.base.json` with `"paths": {}` and whose `node_modules/@deepseek-ai` points at
   `$DSH_HOME/profiles/node_modules/@deepseek-ai` (the DSH **built** types) typechecks its
   imports of `@deepseek-ai/cordis`, `@deepseek-ai/dsh-schedule`, `@deepseek-ai/dsh-typert-protocol`,
   `@deepseek-ai/dsh-session`, etc. `tsc -p packages/scheduled-task/host/tsconfig.json` → exit 0.
2. **Build tooling**. `typescript` / `tsdown` / `vitest` / `tsx` resolve from the DSH
   checkout's root `node_modules`; runtime deps (`zod`, `react`, `@types/*`) resolve from
   `$DSH_HOME/profiles/node_modules`.
3. **Shipped-API reuse**. The external host uses only the shipped `@deepseek-ai/dsh-schedule`
   public record builders (`createAfterScheduleRecord`/`createAtScheduleRecord`/
   `createEveryScheduleRecord`) and `resolveEveryOccurrence`, so it needs no change to DSH.
4. **Typert discovery**. `WorkspaceTypertGenerator` (DSH's generator) discovers the external
   package once the root `tsconfig.host.json` references it: `discover(['host'])` returns
   `@deepseek-ai/dsh-plugins-scheduled-task`.
5. **Client bundle serving**. The modules node half (`clientExportOf` + `clientPath`) resolves
   `exports["./client"].default` → `lib/client.js` for the external client package from the
   runtime profile (`dsh.client.platform === 'web'`). Verified against
   `$DSH_HOME/profiles/node_modules/@deepseek-ai/dsh-client-ui-scheduled-task`.
6. **Remote descriptors register**. `scripts/verify-remote.mjs` loads the vendored `./remote`
   contribution in Node and confirms `namespace: scheduledTasks` with 6 methods
   (list/create/update/setStatus/delete/markRead).

## The blocking constraint (why regeneration is hard externally)

`WorkspaceTypertGenerator.generate()` returns **no artifacts** for the external host. Source
evidence in `packages/typert/generator/src/analyzer.ts`:

- `isTypeMetaSymbol` (lines 1805-1820) only accepts the meta symbols
  (`TypertRemoteService`, `bindTypertRemote`, `@Remote`, `TypertLookup`, `TypertContext`) when
  their declaration's file is mapped (via `registrationForFile`) to a package named
  `@deepseek-ai/dsh-typert-protocol`, **or** sits inside a `declare module
  '@deepseek-ai/dsh-typert-protocol'` string-literal block.
- `loadRegistrations` (line 467) fills the registration map from the **workspace root's own**
  `packages/*/*` project references, and uses `realPath(packageRoot)` — so a **symlinked** DSH
  package under `packages/` is rejected (its realpath is outside `root/packages`).

Therefore the typert generator only recognizes the meta packages when they are **physically
present** under the workspace root's `packages/`. For the DSH-repo build that is natural
(`packages/typert/protocol` etc.). For an external workspace it would require copying DSH's
meta source (`cordis`, `dsh-typert-protocol`, `dsh-session`, `dsh-agent`, …) into
`dsh-plugins/packages/`, which defeats the goal of an independent, minimal plugin project.

## Workaround used (how the bridge is unblocked)

**Vendor the already-generated `./remote` contribution instead of regenerating it.** The DSH-repo
build already emits the runtime `TYPERT_REMOTE` object + `.d.ts` for the in-repo
`dsh-scheduled-task` package. Those artifacts are copied into the external host as
`packages/scheduled-task/host/lib/typert.remote-client.{js,d.ts}` with the package-scope import
rewritten `@deepseek-ai/dsh-scheduled-task` → `@deepseek-ai/dsh-plugins-scheduled-task`, and into
the external remotes assembly as `packages/scheduled-task/remotes/src/client/remote-client.{js,d.ts}`.
No external typert analysis/generation is required at all — the generator is bypassed
(`scripts/gen-typert.mjs` probes discovery only; `scripts/verify-remote.mjs` proves the vendored
surfaces still register).

This restores the full host `@Remote` Service + browser-UI client through a three-entry split:

- `packages/scheduled-task/host/` — host `Service extends TypertRemoteService`, `@Remote` methods,
  durability via `storage-domain` table, single-timer scheduler, cold-Session delivery.
- `packages/scheduled-task/remotes/` — browser assembly that mounts the vendored contribution via
  `ctx.remote.$mount(...)` (`inject = ['remote']`), the plugin-scoped counterpart of the in-repo
  `dsh-api-remotes` assembly.
- `packages/scheduled-task/client/` — browser UI registering the `sidebar.footer.action` entry;
  `tsdown` bundles to `lib/client.js` (served at `/plugins/<id>/client.js`).

## Cordis inject-isolation lesson

The first in-GUI attempt showed the sidebar entry missing while the app booted cleanly, with a
browser console error `cannot get property "remote.scheduledTasks" without inject` at the slot
render. Cordis grants `ctx.remote.<namespace>` reads only to a fiber that declares
`remote.<namespace>` in its `inject` list, AND a fiber cannot satisfy that declaration with a
service it provides itself (the namespace would pend forever and the boot sweep would fail
loudly). Namespaces must therefore be mounted by a **different, earlier-activated entry** — the
in-repo world uses the `dsh-api-remotes` assembly; an external plugin provides its own
`remotes` assembly entry instead of self-mounting inside its UI entry. This also matches the
in-repo consumer pattern (`dsh-client-ui-settings-plugin-inventory` declares
`remote.pluginInventory` the same way).

## Verification

Headless-browser boot against an isolated `dsh web` instance (temporary `$DSH_HOME` under `/tmp`,
same profile): the sidebar renders the 定时任务 trigger in `sidebar.footer.action`, clicking it
opens the panel (`0 条未读 / 还没有任何任务` + creation form) via the live `remote.list()` path,
and the console is clean. The three plugin rows are registered in
`$DSH_HOME/profiles/web/cordis.patch.yml` and symlinked under
`$DSH_HOME/profiles/node_modules/@deepseek-ai/` to
`packages/scheduled-task/{host,remotes,client}`, so the user's own `dsh web` restart picks up the
same composition.
