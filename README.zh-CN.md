# dsh-plugins

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的外部插件集合，通过 `dsh` profile 以普通插件方式加载 —— 不改动 DSH 本体。

[English](README.md)

## 插件

| 插件 | 功能 | 使用指南 |
| ---- | ---- | -------- |
| **定时任务** | 按调度执行任务 —— 每小时 / 每天 / 每周 / 每月整点预设、一次性延迟执行，支持按任务指定项目和模型 | [packages/scheduled-task/README.zh-CN.md](packages/scheduled-task/README.zh-CN.md) |
| **Token 追踪** | 会话级 token 归因 —— 看清每轮对话 token 花在哪（轮内瀑布图、跨会话看板、优化建议） | [packages/token-tracing/README.zh-CN.md](packages/token-tracing/README.zh-CN.md) |

## 安装

前置要求：Node.js ≥ 22、[pnpm](https://pnpm.io/)。**插件 ↔ dsh 版本对应**（用 `dsh --version` 查看自己的版本）：

| 插件版本 | 兼容的 dsh | dsh 安装方式 |
| -------- | ---------- | ------------ |
| **0.1.1-alpha.2** | `dsh-v0.1.2-alpha.2`（0.1.2-alpha 线，仅实测 alpha.2） | `npm i -g @deepseek-ai/dsh@0.1.2-alpha.2` —— alpha 线**不是** npm 的 `latest`，必须显式指定版本 |
| **0.1.0** | dsh ≤ `0.1.1-rc.2`（在 `dsh-v0.1.1-rc.2` 上验证） | `npm i -g @deepseek-ai/dsh`（`latest` dist-tag） |

从源码 checkout 跑 dsh？请让 checkout 的 tag 与上表对应——插件 `0.1.0` 在 0.1.2-alpha 线上无法启动（上游删除了 `dsh-client-runtime` / `ConnectionHandle.api`）；自 `dsh-v0.1.2-alpha.1` 起需要插件 `0.1.1-alpha.2`。

```sh
dsh plugin --profile web add @qihongmu/dsh-plugins-scheduled-task-bundle
```

一条命令拉齐三个半包（host 服务 / remotes 组装 / 浏览器 UI）并注册到 web profile。重启 `dsh web` 后，按上表中的使用指南开始使用。

**Token 追踪**尚未发布到 npm —— 从已构建的本仓库源码检出直接安装三个半包（构建前置见 [CONTRIBUTING.md](CONTRIBUTING.md)），重启 `dsh web`：

```sh
dsh plugin --profile web add ./packages/token-tracing/host ./packages/token-tracing/remotes ./packages/token-tracing/client
```

> **bundle 与逐个安装二选一，不要混用。** 三命令形式（`dsh plugin --profile web add ./packages/scheduled-task/host ./packages/scheduled-task/remotes ./packages/scheduled-task/client`）只适用于源码检出，且仅在需要精细控制时使用。

> **从手动安装升级？** 请删除 `~/.dsh/profiles/web/cordis.patch.yml` 中的 `plugins-scheduled-task` / `plugins-remotes-scheduled-task` / `plugins-ui-scheduled-task` 三行，以及 `~/.dsh/profiles/node_modules/@qihongmu/` 下的旧软链 —— 现在由 bundle 补丁提供。

## 开发

基于本地 DeepSeek Harness 源码检出构建：参见 [CONTRIBUTING.md](CONTRIBUTING.md)。
