# dsh-plugins

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的外部插件集合，通过 `dsh` profile 以普通插件方式加载 —— 不改动 DSH 本体。

[English](README.md)

## 插件

| 插件 | 功能 | 使用指南 |
| ---- | ---- | -------- |
| **定时任务** | 按调度执行任务 —— 每小时 / 每天 / 每周 / 每月整点预设、一次性延迟执行，支持按任务指定项目和模型 | [packages/scheduled-task/README.zh-CN.md](packages/scheduled-task/README.zh-CN.md) |

## 安装

前置要求：Node.js ≥ 22、[pnpm](https://pnpm.io/)，以及一份本地构建好的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 源码检出（放在本仓库旁边，或用 `DSH_ROOT` 指向它）。

```sh
git clone https://github.com/qihongmu/dsh-plugins
cd dsh-plugins

# 针对你的 DSH 检出构建插件
npm run bootstrap
npm run build

# 一条命令把插件装进 web profile —— 聚合 bundle 一次性拉齐三个半包
# （host 服务 / remotes 组装 / 浏览器 UI）
dsh plugin --profile web add @deepseek-ai/dsh-plugins-scheduled-task-bundle
```

聚合 bundle 把三个半包列为自己的依赖；每个半包声明 `dsh.bundle.patch`，因此 `dsh plugin` 会把 bundle 注册为 profile bundle，启动时合并其 `cordis.patch.yml`（三条插件条目）。无需任何手动配置；若同名的包已以不同 id 挂载，bundle 的条目会自动禁用自身。

> **bundle 与逐个安装二选一，不要混用。** 只有需要精细控制时才用三命令形式：
>
> ```sh
> dsh plugin --profile web add \
>   ./packages/scheduled-task/host \
>   ./packages/scheduled-task/remotes \
>   ./packages/scheduled-task/client
> ```

重启 `dsh web` 后，按上表中的使用指南开始使用。

> **从手动安装升级？** 请删除 `~/.dsh/profiles/web/cordis.patch.yml` 中的 `plugins-scheduled-task` / `plugins-remotes-scheduled-task` / `plugins-ui-scheduled-task` 三行，以及 `~/.dsh/profiles/node_modules/@deepseek-ai/` 下的旧软链 —— 现在由 bundle 补丁提供。

## 贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.md)。
