---
name: dsh-plugin-lifecycle
description: >
  End-to-end workflow for this repo's dsh plugins — develop, build, test,
  verify, and release. Use whenever working on anything under packages/
  (scheduled-task or a new plugin), building client browser bundles, running
  tests or local CI, bumping versions, tagging, publishing to npm, debugging
  CI or publish failures, or onboarding a new plugin — even if the user only
  says 改一下插件 / build 挂了 / 发个版 / 帮我测试一下. For the full
  pre-release install & UI verification recipe, this skill hands off to the
  verify-release skill.
---

# dsh plugin lifecycle: dev → test → verify → release

## 0. Repo model (read this before touching anything)

This is an npm-scripts workspace (no root dependencies) of **external user
plugins** for DeepSeek Harness (dsh). Each plugin lives at
`packages/<plugin>/{host,client,remotes,bundle}` and ships as **four npm
packages** under the `@qihongmu` scope (the table shows scheduled-task's
names as the example):

| half | package | role |
|---|---|---|
| host | `@qihongmu/dsh-plugins-scheduled-task` | dsh server half: `/api/*` routes, durable store |
| client | `@qihongmu/dsh-client-ui-scheduled-task` | browser UI half: registers a `sidebar.footer.action` slot, self-mounts the remote |
| remotes | `@qihongmu/dsh-client-remotes-scheduled-task` | remotes assembly that calls `ctx.remote.$mount` |
| bundle | `@qihongmu/dsh-plugins-scheduled-task-bundle` | aggregate users install with one `dsh plugin add`; ships last |

Plugins with a browser UI need their own client + remotes halves (dsh
provides that wiring only for built-ins, so an external plugin must carry
its own remotes half), plus the bundle aggregate for one-command install; a
server-only plugin can stop at the host half.

**Hard sibling dependency:** builds run against a local dsh checkout
(`DSH_ROOT`, default `../deepseek-harness`). The harness provides the tsdown
binary, lightningcss, the tsconfig bases (absolute paths), and the dsh
protocol package types — so **external-plugin typecheck requires the harness
to be built**, and `npm run bootstrap` (re)links it all. Bootstrap seeds a
fixed link list (`SCOPED_PACKAGES`) plus the browser module-table externals;
when dsh adds a plugin-facing package, the seed in `scripts/bootstrap.mjs`
must gain it too (this bit CI once: `dsh-client-ui-renderer` was missing and
typecheck failed only on a clean runner).

**Version alignment.** CI (`ci.yml`, `publish.yml`, `verify-env.sh`) pins a
dsh ref, e.g. `dsh-v0.1.2-alpha.2` — the line this plugin release is
certified against. Check `git -C ../deepseek-harness describe --tags`. If the
sibling checkout is not at the pinned ref, build against a worktree of the
tag and point `DSH_ROOT` at it:

```sh
scripts/verify-env.sh worktree /tmp/dsh-verify/dsh-src   # worktree + install + build
export DSH_ROOT=/tmp/dsh-verify/dsh-src
```

Compatibility matrix (keep README's dual-track note in sync when it changes):
plugin `0.1.1-alpha.2` ↔ dsh `v0.1.2-alpha.2` (npm dist-tag `alpha`); plugin
`0.1.0` ↔ dsh ≤ `0.1.1-rc.2` (npm `latest`).

## 1. Development loop

```sh
npm run bootstrap        # after clone, after switching DSH_ROOT, after harness repin
npm run build            # tsc only: build:host + build:client → lib/ types+js
npm run build:web        # tsdown per package → lib/client.js browser bundles
npm run gen:typert       # DIAGNOSTICS ONLY: emits nothing for external repos.
```

The typert remote-client artifacts are **hand-vendored**, not generated:
`packages/<plugin>/host/lib/typert.remote-client.{js,d.ts}` and
`packages/<plugin>/remotes/src/client/remote-client.{js,d.ts}`. When the
remote surface changes, update them by hand and keep their zod schemas in
sync with `host/src/types.ts`.

- `npm run build` alone does **not** produce `lib/client.js`; published
  tarballs are broken without `build:web`. Any "it works locally but the
  installed plugin 404s its bundle" report: check build:web ran.
- **Harness checkout pulled? Clean-rebuild it** — `pnpm clean && pnpm install
  --frozen-lockfile && pnpm build` inside the harness. Stale `lib/` leftovers
  break the plugin build with confusing `MISSING_EXPORT` errors. `pnpm clean`
  only removes build output; it is safe.
- The client browser bundle has a loader contract (self-registration via
  `window.__ModuleLoader__.load`, banner/footer/intro wrapper, allowed
  externals). Before writing or changing any `tsdown.config.ts`, read
  [references/client-bundle-contract.md](references/client-bundle-contract.md).
  Missing wrapper symptom: page logs `loaded without registering "<pkg>" via
  __ModuleLoader__.load` while compile/start succeed.
- **New plugin onboarding:** copy the four-half layout from scheduled-task,
  keep the `__ModuleLoader__` wrapper, and add any new bare specifiers you
  import to the bootstrap seed (or inline them). Package renames/scope
  changes do NOT propagate to a real-environment profile — its
  `cordis.patch.yml` rows and `node_modules` keep the old names and boot
  fails with `ERR_MODULE_NOT_FOUND`; fix the profile rows and re-link.
- **The plugin README pair is part of delivery:** ship `README.md` +
  `README.zh-CN.md` (cross-linked; an existing plugin's pair is the
  template) and add the plugin to both root READMEs — a plugins-table row
  plus an install entry whose wording switches from the source-checkout
  form to the one-command bundle install once the npm release lands.
  Screenshots that ship inside the repo must redact private data first
  (session titles, paths, usernames — blur via injected CSS) and be viewed
  before saving.
- **Real profile, two mounting sources.** The launcher applies every
  `dsh.profile.bundles` package's own `dsh.bundle.patch`, then the profile's
  `cordis.patch.yml`: when a half joins the bundles list, its same-id
  hand-written row in the profile patch must go, or the next boot crashes
  with "duplicate loader entry id". The drift is silent (the two states age
  independently); diagnose and fix through the verify-release skill's
  [references/real-environment.md](../verify-release/references/real-environment.md)
  sandbox recipe — read-only.
- **Durable layout changes need a migration rehearsal.** After changing a
  host half's storage spec layout, boot the sandbox clone of the real profile
  with a COPY of the real storages before restarting the real environment;
  verify record count, an aggregate total, and that the legacy store file
  stays byte-identical.

## 2. Test & local CI gates

```sh
npm test            # unit tests (scripts/test.mjs)
npm run verify      # imports each host half, asserts its @Remote service
                    # registers and its methods are readable
npm run ci:local    # reproduces the GitHub gates job in a fresh temp copy
```

Run all three before pushing anything. `ci:local` matters because the dev
machine's root `node_modules` carries hand-made links (e.g. `@types/react`
from a profile build) that mask exactly the type-resolution gaps CI hits —
the temp copy starts empty and reproduces a clean runner. It needs a **built**
`DSH_ROOT`.

What CI runs on GitHub = the same gates: bootstrap → build → test → verify,
with the harness cloned at the pinned ref.

Fixture fidelity matters as much as coverage: engines over stored maps
(attribution, ranking, suggestion rules) must be tested with fixtures whose
key shapes match production storage — dump a real record and copy its key
conventions. Hand-written family keys over leaf-shaped data (`kind/name`
composites) pass every test while never firing on real data; lock both shapes
with a mixed-key case.

## 3. Verification — hand off to the verify-release skill

For install & UI verification (isolated `$DSH_HOME`, source install vs
verdaccio release rehearsal, `dsh web` probe, browser checklist, cleanup,
report), invoke the **`verify-release`** skill — it is the detailed recipe
and this skill does not duplicate it. Rules that always apply, from every
release so far:

- `npm run build:web` before any pack/install — tarballs without browser
  bundles are broken.
- Everything runs in an isolated `$DSH_HOME`; `~/.dsh` is the user's real
  environment — never touch it, prove isolation with a snapshot diff.
- `dsh web` takes no `--profile`/`--patch`; it boots the profile named `web`.
- Prerelease plugin ↔ prerelease dsh: install `@deepseek-ai/dsh@<exact
  alpha>` — dist-tag `alpha`, not `latest`.

## 4. Release runbook

Steady state is fully automated by `.github/workflows/publish.yml` (tag
trigger, npm Trusted Publishing / OIDC). The human steps:

1. **Bump all four manifests** to the same version. CI guards: tag
   `vX.Y.Z` must equal the host manifest version.
2. **One commit** for the release (version bump + docs + any anchor bumps —
   ci.yml/publish.yml/verify-env.sh/README compat note move together).
3. **Ask the user before every outward action** — commit, branch name, tag,
   GitHub release, npm publish all require explicit confirmation. This is a
   standing user rule, not a formality.
4. `git tag vX.Y.Z && git push origin vX` → Publish workflow: harness at the
   pinned ref, `npm i -g npm@latest` (OIDC needs npm ≥ 11.5.1; Node 22 ships
   10.x), build gates, then publishes **host → remotes → client → bundle**
   with `--access public` (bundle last — it depends on the three halves).
5. **dist-tag discipline:** npm refuses to stamp a prerelease as `latest`;
   the workflow auto-publishes prereleases under `--tag alpha` (mirroring the
   dsh line). When a stable `0.1.1` ships, flip the dist-tag back to
   `latest` (`npm dist-tag add`).
6. **Hygiene:** author `qihong.m.u+dev@gmail.com`; zero debug artifacts in
   tarballs (sourcemap false, exclude `*.map`/`*.tsbuildinfo`); cssModules
   virtual ids stay package-relative.
7. **Post-publish proof:** npm's new-package view lags a few minutes — the
   PUT receipt is the truth, retry `npm view` later. Then run the
   verify-release skill's registry-rehearsal path against the real npm
   packages and report with the `~/.dsh` isolation diff.

## 5. Publish/CI failure triage

When Publish run goes red or `npm publish` fails, read
[references/publish-triage.md](references/publish-triage.md) **before**
guessing — the workflow already prints triage output (npm version,
`ACTIONS_ID_TOKEN_*`, OIDC exchange probe), and npm's own error text is
known to lie (a trusted-publishing misconfig surfaces as ENEEDAUTH; a
missing/mismatched Trusted Publisher config surfaces as a misleading 404
`package not found`).

## 6. Standing interaction rules

- Never push, tag, publish, or touch `~/.dsh` without explicit user
  confirmation; propose branch names and get them confirmed.
- One requirement = one commit; if history accumulates extra commits for one
  requirement, squash before delivering.
- Verification claims need evidence: screenshot per UI checklist item, probe
  output, test/verify counts. Report what was NOT covered (e.g. real LLM
  task runs need an API key) instead of implying full coverage.
