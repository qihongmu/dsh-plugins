# dsh-plugins

External plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), loaded through a `dsh` profile as ordinary plugins — the DSH library itself is never modified.

[简体中文](README.zh-CN.md)

## Plugins

| Plugin | What it does | Guide |
| ------ | ------------ | ----- |
| **Scheduled Tasks** | Run a task on a schedule — hourly / daily / weekly / monthly wall-clock presets, one-shot delays, per-task project and model | [packages/scheduled-task/README.md](packages/scheduled-task/README.md) |

## Install

Requires Node.js ≥ 22 and pnpm. **Plugin ↔ dsh version mapping** — check yours with `dsh --version`:

| Plugin version | Compatible dsh | dsh install |
| -------------- | -------------- | ----------- |
| dev (unreleased, incl. token-tracing M3) | `dsh-v0.1.2-rc.1` (gates + real-data browser acceptance green) | source checkout at tag `dsh-v0.1.2-rc.1` |
| **0.1.1-alpha.2** | `dsh-v0.1.2-alpha.2` (the 0.1.2-alpha line; only alpha.2 is verified) | `npm i -g @deepseek-ai/dsh@0.1.2-alpha.2` — the alpha line is **not** npm `latest`, pin it explicitly |
| **0.1.0** | dsh ≤ `0.1.1-rc.2` (verified on `dsh-v0.1.1-rc.2`) | `npm i -g @deepseek-ai/dsh` (`latest` dist-tag) |

Running dsh from a source checkout? Match the checkout tag to the table above — plugin `0.1.0` fails to boot on the 0.1.2-alpha line (upstream removed `dsh-client-runtime` / `ConnectionHandle.api`), and plugin `0.1.1-alpha.2` is required from `dsh-v0.1.2-alpha.1` on. The dev tree re-certified against `dsh-v0.1.2-rc.1` on 2026-09-01: every plugin-facing package (ui-slots / ui-sidebar / ui-conversation / ui-primitives / locale / api-remotes / session-controller / core-session / storage-domain) is source-identical from alpha.4 to rc.1, and rc.1's storage changes are additive-only (`DomainSpec.compatibleVersions` / `invalidRecords`, both optional with the old loud path as default).

```sh
dsh plugin --profile web add @qihongmu/dsh-plugins-scheduled-task-bundle
```

One command pulls the three halves (host service, remotes assembly, browser UI) and registers them in the web profile. Restart `dsh web`, then open the plugin's guide (linked above) to start using it.

> Install the **bundle or the individual halves — not both**. The three-command form (`dsh plugin --profile web add ./packages/scheduled-task/host ./packages/scheduled-task/remotes ./packages/scheduled-task/client`) only applies to a source checkout, and needs fine-grained control.

> **Upgrading from a manual install?** Remove the three `plugins-scheduled-task` / `plugins-remotes-scheduled-task` / `plugins-ui-scheduled-task` rows from `~/.dsh/profiles/web/cordis.patch.yml` and the old symlinks under `~/.dsh/profiles/node_modules/@qihongmu/` — the bundle patches now provide them.

## Development

Build from source against a local DeepSeek Harness checkout: see [CONTRIBUTING.md](CONTRIBUTING.md).
