# dsh-plugins

External plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), loaded through a `dsh` profile as ordinary plugins — the DSH library itself is never modified.

[简体中文](README.zh-CN.md)

## Plugins

| Plugin | What it does | Guide |
| ------ | ------------ | ----- |
| **Scheduled Tasks** | Run a task on a schedule — hourly / daily / weekly / monthly wall-clock presets, one-shot delays, per-task project and model | [packages/scheduled-task/README.md](packages/scheduled-task/README.md) |
| **Token Tracing** | Token attribution — where the tokens went in every conversation (per-turn waterfall, cross-session dashboard, optimization hints) | [packages/token-tracing/README.md](packages/token-tracing/README.md) |

## Install

Requires Node.js ≥ 22 and pnpm. **Plugin ↔ dsh version mapping** — check yours with `dsh --version`:

| Plugin version | Compatible dsh | dsh install |
| -------------- | -------------- | ----------- |
| **Scheduled Tasks 0.1.1-alpha.3 / Token Tracing 0.1.2-alpha.1** | `dsh-v0.1.7-rc.2` (gates + isolated browser acceptance green, end-to-end fire → trace verified) | `npm i -g @deepseek-ai/dsh@0.1.7-rc.2` (npm `next` dist-tag); plugin side pin the bundle `@alpha` |
| dev (unreleased) | `dsh-v0.1.7-rc.2` | source checkout at tag `dsh-v0.1.7-rc.2` |
| **Token Tracing 0.1.1 / Scheduled Tasks 0.1.1-alpha.2** | `dsh-v0.1.2-rc.1` (verified on rc.1) | `npm i -g @deepseek-ai/dsh@0.1.2-rc.1` — the 0.1.1.x plugin line does **not** work on the 0.1.7 line |
| **Scheduled Tasks 0.1.0** | dsh ≤ `0.1.1-rc.2` (verified on `dsh-v0.1.1-rc.2`) | `npm i -g @deepseek-ai/dsh@0.1.1-rc.2` |

Running dsh from a source checkout? Match the checkout tag to the table above — plugin `0.1.0` fails to boot on the 0.1.2-alpha line (upstream removed `dsh-client-runtime` / `ConnectionHandle.api`), and plugin `0.1.1-alpha.2` is required from `dsh-v0.1.2-alpha.1` on. The dev tree re-certified against `dsh-v0.1.7-rc.2` on 2026-09-26 (Remote codecs moved to lazy `create()` factories, `assistant/chunk` events folded into `assistant/message.stream` + `assistant/attempt`, schedule builders gained a `title` parameter, `dsh-agent-presets` merged into `dsh-agent-preset-registry`, icons renamed from `…16`/`…14` to `…Regular`/`…Medium`, `ISessions.open` replaced by `uiWorkspace.openSession`, and `every_seconds` minimum lowered 300 → 60).

```sh
# Scheduled Tasks
dsh plugin --profile web add @qihongmu/dsh-plugins-scheduled-task-bundle

# Token Tracing
dsh plugin --profile web add @qihongmu/dsh-plugins-token-tracing-bundle
```

On a **prerelease dsh line** (e.g. `0.1.7-rc.2`), the matching plugin ships under the `alpha` dist-tag — pin it explicitly:

```sh
dsh plugin --profile web add @qihongmu/dsh-plugins-scheduled-task-bundle@alpha
dsh plugin --profile web add @qihongmu/dsh-plugins-token-tracing-bundle@alpha
```

One command pulls the plugin's three halves (host service, remotes assembly, browser UI) and registers them in the web profile. Restart `dsh web`, then open the plugin's guide (linked above) to start using it.

> Install the **bundle or the individual halves — not both**. The three-command form (`dsh plugin --profile web add ./packages/scheduled-task/host ./packages/scheduled-task/remotes ./packages/scheduled-task/client`) only applies to a source checkout, and needs fine-grained control.

> **Upgrading from a manual install?** Remove the three `plugins-scheduled-task` / `plugins-remotes-scheduled-task` / `plugins-ui-scheduled-task` rows from `~/.dsh/profiles/web/cordis.patch.yml` and the old symlinks under `~/.dsh/profiles/node_modules/@qihongmu/` — the bundle patches now provide them.

## Development

Build from source against a local DeepSeek Harness checkout: see [CONTRIBUTING.md](CONTRIBUTING.md).
