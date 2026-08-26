# dsh-plugins

External plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), loaded through a `dsh` profile as ordinary plugins — the DSH library itself is never modified.

## Plugins

| Plugin | What it does | Guide |
| ------ | ------------ | ----- |
| **Scheduled Tasks** | Run a task on a schedule — hourly / daily / weekly / monthly wall-clock presets, one-shot delays, per-task project and model | [packages/scheduled-task/README.md](packages/scheduled-task/README.md) |

## Install

Requirements: Node.js ≥ 22 and a local, built checkout of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (clone it next to this repo, or point `DSH_ROOT` at it).

```sh
git clone https://github.com/qihongmu/dsh-plugins
cd dsh-plugins

# Build the plugin against your DSH checkout
npm run bootstrap
npm run build

# 1) Link the plugin halves into the DSH profile
mkdir -p ~/.dsh/profiles/node_modules/@deepseek-ai
ln -s "$PWD/packages/scheduled-task/host"     ~/.dsh/profiles/node_modules/@deepseek-ai/dsh-plugins-scheduled-task
ln -s "$PWD/packages/scheduled-task/remotes"  ~/.dsh/profiles/node_modules/@deepseek-ai/dsh-client-remotes-scheduled-task
ln -s "$PWD/packages/scheduled-task/client"   ~/.dsh/profiles/node_modules/@deepseek-ai/dsh-client-ui-scheduled-task

# 2) Register the three plugin ids in the profile's cordis patch
cat >> ~/.dsh/profiles/web/cordis.patch.yml <<'EOF'
- insert:
    - id: plugins-scheduled-task
      name: '@deepseek-ai/dsh-plugins-scheduled-task'
    - id: plugins-ui-scheduled-task
      name: '@deepseek-ai/dsh-client-ui-scheduled-task'
    - id: plugins-remotes-scheduled-task
      name: '@deepseek-ai/dsh-client-remotes-scheduled-task'
EOF
```

Restart `dsh web`, then open the plugin's guide (linked above) to start using it.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
