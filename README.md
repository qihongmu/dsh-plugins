# dsh-plugins

External plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), loaded through a `dsh` profile as ordinary plugins — the DSH library itself is never modified.

[简体中文](README.zh-CN.md)

## Plugins

| Plugin | What it does | Guide |
| ------ | ------------ | ----- |
| **Scheduled Tasks** | Run a task on a schedule — hourly / daily / weekly / monthly wall-clock presets, one-shot delays, per-task project and model | [packages/scheduled-task/README.md](packages/scheduled-task/README.md) |

## Install

Requirements: Node.js ≥ 22, [pnpm](https://pnpm.io/), and a local, built checkout of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (clone it next to this repo, or point `DSH_ROOT` at it).

```sh
git clone https://github.com/qihongmu/dsh-plugins
cd dsh-plugins

# Build the plugin against your DSH checkout
npm run bootstrap
npm run build

# Install the plugin into the web profile
dsh plugin --profile web add \
  ./packages/scheduled-task/host \
  ./packages/scheduled-task/remotes \
  ./packages/scheduled-task/client
```

`dsh plugin` forwards the remaining arguments to pnpm inside the profile directory and registers each package as a profile bundle (its `cordis.patch.yml` is merged at boot), so no manual configuration is needed.

Restart `dsh web`, then open the plugin's guide (linked above) to start using it.

> **Upgrading from a manual install?** Remove the three `plugins-scheduled-task` / `plugins-remotes-scheduled-task` / `plugins-ui-scheduled-task` rows from `~/.dsh/profiles/web/cordis.patch.yml` and the old symlinks under `~/.dsh/profiles/node_modules/@deepseek-ai/` — the bundle patches now provide them.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
