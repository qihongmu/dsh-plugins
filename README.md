# dsh-plugins

External plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), loaded through a `dsh` profile as ordinary plugins — the DSH library itself is never modified.

[简体中文](README.zh-CN.md)

## Plugins

| Plugin | What it does | Guide |
| ------ | ------------ | ----- |
| **Scheduled Tasks** | Run a task on a schedule — hourly / daily / weekly / monthly wall-clock presets, one-shot delays, per-task project and model | [packages/scheduled-task/README.md](packages/scheduled-task/README.md) |

## Install

Requires Node.js ≥ 22 and pnpm. **Compatibility:** verified against DeepSeek Harness `v0.1.1-rc.2`; newer `dsh` releases may not work yet.

```sh
dsh plugin --profile web add @qihongmu/dsh-plugins-scheduled-task-bundle
```

One command pulls the three halves (host service, remotes assembly, browser UI) and registers them in the web profile. Restart `dsh web`, then open the plugin's guide (linked above) to start using it.

> Install the **bundle or the individual halves — not both**. The three-command form (`dsh plugin --profile web add ./packages/scheduled-task/host ./packages/scheduled-task/remotes ./packages/scheduled-task/client`) only applies to a source checkout, and needs fine-grained control.

> **Upgrading from a manual install?** Remove the three `plugins-scheduled-task` / `plugins-remotes-scheduled-task` / `plugins-ui-scheduled-task` rows from `~/.dsh/profiles/web/cordis.patch.yml` and the old symlinks under `~/.dsh/profiles/node_modules/@qihongmu/` — the bundle patches now provide them.

## Development

Build from source against a local DeepSeek Harness checkout: see [CONTRIBUTING.md](CONTRIBUTING.md).
