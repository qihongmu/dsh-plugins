# dsh-plugins

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的外部插件集合，通过 `dsh` profile 以普通插件方式加载 —— 不改动 DSH 本体。

[English](README.md)

## 插件

| 插件 | 功能 | 使用指南 |
| ---- | ---- | -------- |
| **定时任务** | 按调度执行任务 —— 每小时 / 每天 / 每周 / 每月整点预设、一次性延迟执行，支持按任务指定项目和模型 | [packages/scheduled-task/README.zh-CN.md](packages/scheduled-task/README.zh-CN.md) |

## 安装

前置要求：Node.js ≥ 22、[pnpm](https://pnpm.io/)。**兼容性**：已在 DeepSeek Harness `v0.1.1-rc.2` 上验证；更新的 `dsh` 版本尚不保证可用。

```sh
dsh plugin --profile web add @qihongmu/dsh-plugins-scheduled-task-bundle
```

一条命令拉齐三个半包（host 服务 / remotes 组装 / 浏览器 UI）并注册到 web profile。重启 `dsh web` 后，按上表中的使用指南开始使用。

> **bundle 与逐个安装二选一，不要混用。** 三命令形式（`dsh plugin --profile web add ./packages/scheduled-task/host ./packages/scheduled-task/remotes ./packages/scheduled-task/client`）只适用于源码检出，且仅在需要精细控制时使用。

> **从手动安装升级？** 请删除 `~/.dsh/profiles/web/cordis.patch.yml` 中的 `plugins-scheduled-task` / `plugins-remotes-scheduled-task` / `plugins-ui-scheduled-task` 三行，以及 `~/.dsh/profiles/node_modules/@qihongmu/` 下的旧软链 —— 现在由 bundle 补丁提供。

## 开发

基于本地 DeepSeek Harness 源码检出构建：参见 [CONTRIBUTING.md](CONTRIBUTING.md)。
