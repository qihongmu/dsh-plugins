# AGENTS.md

External user plugins for DeepSeek Harness (`dsh`), loaded through a dsh profile — the DSH library itself is never modified. Plugins ship as npm packages under the `@qihongmu` scope.

## Read first

- [`.agents/skills/dsh-plugin-lifecycle/SKILL.md`](.agents/skills/dsh-plugin-lifecycle/SKILL.md) — end-to-end dev → test → verify → release workflow. Read before touching anything under `packages/` (including "just" building, testing, or bumping versions).
- [`.agents/skills/verify-release/SKILL.md`](.agents/skills/verify-release/SKILL.md) — install & UI verification recipe (isolated `$DSH_HOME`, verdaccio rehearsal, browser checklist).
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — ground rules and release steps; [`FEASIBILITY.md`](FEASIBILITY.md) — record of proven constraints.
- `packages/token-tracing/docs/` — the token-tracing plugin's own design/PRD (`DESIGN-token-tracing.md`, `PRD-token-tracing.md`, `PRD-token-tracing-m3.md`), maintained inside the plugin.

## Layout

Each plugin owns `packages/<plugin>/` with four halves (one npm package each):

| half | role |
|---|---|
| `host` | dsh server half: `@Remote` service, `/api/*` routes, durable store; domain tests in `host/tests/` |
| `client` | browser UI half, registered via a UI slot |
| `remotes` | remote assembly — external plugins must carry their own remotes half (dsh wires this only for built-ins) |
| `bundle` | aggregate users install with one `dsh plugin add`; ships last |

`scripts/` holds all workspace drivers (bootstrap, build-web, test, verify-remote, verify-env, ci-local). This is an npm-scripts workspace with no root dependencies; pnpm workspace glob is `packages/*/*`.

## Hard prerequisite: the sibling harness checkout

Builds resolve toolchain (tsc/tsdown), tsconfig bases, and `@deepseek-ai/*` types from a **built local DeepSeek Harness checkout** — `DSH_ROOT`, default sibling `../deepseek-harness`. After clone, harness repin, or `DSH_ROOT` switch, run `npm run bootstrap`. After pulling the harness, clean-rebuild it (`pnpm clean && pnpm install --frozen-lockfile && pnpm build`) — stale `lib/` breaks the plugin build with misleading `MISSING_EXPORT` errors.

Plugin ↔ dsh compatibility is certified per release against a pinned dsh ref (see the README table and `scripts/verify-env.sh`); CI clones the harness at that ref.

## Commands

```sh
npm run bootstrap   # link against the harness checkout (idempotent)
npm run build       # tsc host + client faces → lib/ types+js (NOT the browser bundle)
npm run build:web   # tsdown browser bundles lib/client.js — tarballs are broken without it
npm test            # node:test unit suites
npm run verify      # host @Remote service registration contract check
npm run ci:local    # GitHub gates job reproduced in a fresh temp copy — run before pushing
npm run gen:typert  # diagnostics only; emits nothing for external repos
```

Run `build`, `test`, `verify` (and `ci:local` before pushing) as a set. `npm run build` alone does not produce `lib/client.js` — any "works locally but the installed plugin 404s its bundle" report means `build:web` didn't run.

## Non-negotiable rules

- **Pure external plugin**: never modify the DSH library to make something fit. If an API is missing, document the constraint (FEASIBILITY.md) and work within shipped APIs.
- **Vendored typert artifacts** (`host/lib/typert.remote-client.*`, `remotes/src/client/remote-client.*`) are hand-maintained mirrors of the wire model, not generated. When the remote surface changes, update them and their zod schemas together with `host/src/types.ts` in the same change, covered by tests.
- **Client bundle loader contract**: browser bundles must self-register via `window.__ModuleLoader__.load` with the banner/footer wrapper and allowed externals. Read [`.agents/skills/dsh-plugin-lifecycle/references/client-bundle-contract.md`](.agents/skills/dsh-plugin-lifecycle/references/client-bundle-contract.md) before writing or changing any `tsdown.config.ts`. Broken-wrapper symptom: page logs `loaded without registering "<pkg>" via __ModuleLoader__.load` while compile succeeds.
- **Releases**: bump all four manifests (host/remotes/client/bundle) to the same version in one commit; publish order host → remotes → client → bundle (bundle last); prereleases go under the `alpha` dist-tag. Publishing is automated by `.github/workflows/publish.yml` (tag trigger, npm Trusted Publishing) — see the lifecycle skill's release runbook and `references/publish-triage.md` before debugging a red publish.
- **Never push, tag, publish, or touch `~/.dsh` without explicit user confirmation.** `~/.dsh` is the user's real environment; verification always uses an isolated `$DSH_HOME`.
- **One requirement = one commit**; squash stray commits before delivering.
- Keep personal paths/identifiers out of fixtures — use neutral demo values.
