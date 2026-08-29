# Contributing

Thanks for your interest in improving the DSH external plugins!

## Prerequisites

- Node.js 22+
- A local clone of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness),
  installed and built (`pnpm install && pnpm build`). The workspace resolves
  toolchain and `@deepseek-ai/*` packages from that checkout. Published plugin
  packages live on npm under the `@qihongmu` scope; development always links
  against the local checkout.

## Development loop

```sh
npm run bootstrap   # link against the DSH checkout (idempotent)
npm run build       # tsc host + client faces
npm run build:web   # tsdown browser bundles (lib/client.js for the client + remotes halves)
npm test            # node:test unit suites
npm run verify      # remote-surface contract check
```

`DSH_ROOT` overrides where bootstrap looks for the checkout (defaults to a
`deepseek-harness/` sibling of this repository).

## Ground rules

- **Pure external plugin**: never modify the DSH library to make something fit.
  If an API is missing, document the constraint (see FEASIBILITY.md) and work
  within shipped APIs, as the scheduled-task plugin does.
- **Vendored typert artifacts** (`host/lib/typert.remote-client.*`,
  `remotes/src/client/remote-client.js`) are hand-maintained mirrors of the wire
  model. When you change `host/src/types.ts`, update their zod schemas in the
  same change and keep them covered by tests.
- **Tests for behavior changes**: domain math (occurrence computation,
  advancement, validation codes) lives in `packages/scheduled-task/host/tests/`.
- Keep personal paths/identifiers out of fixtures — use neutral demo values.

## Releasing

1. Bump the version in all four manifests (`host`, `remotes`, `client`, and
   `bundle` — the bundle's `dependencies` must match the three halves).
2. Run all five gates above (`build:web` output ships in the tarballs).
3. `npm pack` from each package directory, or rehearse against a local
   verdaccio first (`.agents/skills/verify-release/`).
4. Publish in order host → remotes → client → **bundle last** (it depends on
   the other three), each with `npm publish --access public`.

## Submitting

1. Fork / create a feature branch.
2. Make sure all four gates pass locally (`build`, `test`, `verify`, and a
   clean `git status` after builds).
3. Open a pull request with a short motivation + what changed.
