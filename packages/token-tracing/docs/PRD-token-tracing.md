# PRD: token-tracing 插件 — 会话级 token 归因与可视化

> 状态:本地草稿,未提交、未发布(2026-08-31 用户决策:当前阶段不 commit/publish)。
> 依据:同日对 dsh `v0.1.2-alpha.2` 的可行性调研(sibling checkout 即该 tag,结论已对照发布版核实)。

## Problem Statement

dsh 的重度用户在长会话与 agentic 工作流中,token 消耗增长快且不透明。内置 UI(TurnUsagePanel / StatsLine / ContextMeter)只给 per-turn 总量与当前上下文占用,回答不了"token 具体花在了哪":哪个工具返回的结果最贵、系统提示词随插件与 skills 膨胀了多少、前缀缓存在哪一步失效、注入的 context files 占比多少。缺乏归因,用户想优化 token 使用效率(收窄大工具结果、控制提示词膨胀、保持缓存命中)时无从下手。

## Solution

一个借鉴可观测性 tracing 思路的 token-tracing 插件:以用户输入为起点,把一轮对话(turn)中每次 LLM 调用(step)作为链路上的一个 span,归账每个环节的 token 增量——用户输入、系统提示词、工具定义、每个工具的结果、推理、缓存读/写。精确项直接采用 provider 上报的 usage;组件级拆分用"密度估算 + 精确总量锚定"得到,并在 UI 中显式区分 exact / estimated。client 半以 waterfall 图形化展示链路上每段的 token 增量,并叠加跨会话聚合与可操作的优化建议。

## User Stories

1. 作为 dsh 用户,我想在一轮对话结束后看到该轮的 token trace(waterfall 视图),这样我能直观看到链路中每一部分贡献了多少 token。
2. 作为 dsh 用户,我想看到 turn 内每个 step 的增量明细(推理输出、工具调用、工具结果各自新增多少),这样我能理解 agentic 循环的成本结构。
3. 作为 dsh 用户,我想按组件分类查看占比(用户输入 / 系统提示词 / 工具定义 / 各工具结果 / 推理),这样我知道从哪里下手优化。
4. 作为 dsh 用户,我想看到各工具的 token 成本排行,这样我能识别最烧 token 的工具。
5. 作为 dsh 用户,我想点开某个工具结果查看其大小与是否已被裁剪,这样我能判断是否调整工具参数(如 readLimit)或裁剪阈值。
6. 作为 dsh 用户,我想看到每一步的缓存命中 / 未命中 / 写入 token 数,这样我能理解前缀缓存效率。
7. 作为 dsh 用户,我想在缓存命中率骤降处看到失效点标注(系统提示词或工具集变更导致),这样我能避免破坏前缀缓存的变更。
8. 作为 dsh 用户,我想区分"用户直接输入"与"注入内容"(context files、skills、runtime context snapshot),这样我知道隐性 prompt 的规模。
9. 作为 dsh 用户,我想查看系统提示词随时间的膨胀趋势(按 section 拆分贡献),这样我能评估每个插件 / skill 带来的固定 token 成本。
10. 作为 dsh 用户,我想列出超过阈值的超长工具结果,这样我能配合裁剪策略压低上下文占用。
11. 作为 dsh 用户,我想看到会话级累计统计(总 token、构成、缓存命中率),这样不需要逐轮手动相加。
12. 作为 dsh 用户,我想跨会话聚合查看 token 都花在哪(按天 / 按会话 / 按工具 / 按组件),这样我能做周期性成本回顾。
13. 作为 dsh 用户,我想得到可操作的优化建议(如"此会话中 X 工具的结果占 40%,考虑收窄调用范围"),这样优化有明确抓手。
14. 作为 dsh 用户,我想在插件安装后对历史会话补算 trace,这样不必从安装之日起等待数据积累。
15. 作为 dsh 用户,我想在长任务运行时实时看到当前 turn 的 token 累积,这样成本在发生时即可感知。
16. 作为 dsh 用户,我想让 UI 明确区分 exact(provider 上报)与 estimated(估算)数字,这样不会因"对不上账"产生困惑。
17. 作为 dsh 用户,我想折叠 / 缩放 waterfall 中过长的工具结果段,这样大 trace 仍然可读。
18. 作为 dsh 用户,我想从当前会话界面一键打开对应 turn 的 trace 视图,这样不用手动定位。
19. 作为插件用户,我想导出某会话的 trace 数据(JSON),这样我能离线分析或归档上报。
20. 作为插件用户,我想在多会话并行时按 session 归组查看数据,这样不同会话的成本不会混在一起。
21. 作为插件用户,我希望插件不把会话内容复制进自己的存储(明细按需从会话日志重算),这样不放大磁盘占用、不引入额外的隐私副本。
22. 作为插件维护者,我想让归账引擎作为纯函数独立于 dsh 运行时被测试,这样能用合成事件夹具快速回归。
23. 作为插件维护者,我想让发布继续钉住 dsh 版本并维护 compat matrix,这样用户不会装到不兼容的组合。
24. 作为插件维护者,我想让 compaction 的 replace 语义不破坏归账正确性,这样长会话压缩后历史归因仍然准确。
25. 作为插件维护者,我想让聚合统计增量维护而非全量重算,这样长期使用不拖慢宿主。

## Implementation Decisions

- **包结构**:沿用本 repo 的四包布局(`@qihongmu` scope:host / client / remotes / bundle),server 半归账、浏览器半可视化,注册模式与 client bundle loader contract 照抄 scheduled-task 先例。
- **数据通道**:host 半订阅宿主的 session 事件流实时归账;历史会话经宿主统一查询服务按需重放补算。不自建采集、不 hook agent loop 内部。
- **归账引擎 = 纯函数 fold**:输入会话事件序列,输出 trace。精确层(provider usage、相邻 step 的 prompt 总量差分)与估算层(字符密度,以精确总量锚定校准)分离;每个输出条目携带 exact / estimated 标记。
- **核心 schema**(来自调研的决策性形状,实现时以此为准):

  ```
  TurnTrace  = { sessionId, turn, steps: StepTrace[], totals: TokenUsage /* exact */ }
  StepTrace  = { step, usage /* exact */, additions: ComponentSplit[] }
  ComponentSplit = {
    kind: 'user-input' | 'injected-context' | 'runtime-context' | 'system-prompt'
        | 'tool-definitions' | 'tool-result:<name>' | 'assistant-output' | 'reasoning',
    tokens, basis: 'exact' | 'estimated'
  }
  ```

- **实时推送**:client 半经插件自己的 stream 型 Remote 方法(async iterable)接收更新——外部插件无法扩宿主的事件转发白名单(已核实的负结果);session projection wire-view 作为更轻的候选通道,立项前需 PoC 验证外部插件可行性。
- **typert / remote-client 工件手写 vendored**(既有外部插件约束,gen:typert 对外部包不产出)。
- **存储策略**:插件自有 durable KV 只存聚合统计(增量维护);明细 trace 不落插件库,由会话日志按需重算。
- **compaction**:fold 正确处理 surface replace 语义,被压缩区间的 token 归因到 compaction 事件本身(压缩摘要的成本也是真实成本)。
- **缓存失效检测**:利用请求 envelope 变更原因序列 + 相邻请求 cacheRead 骤降定位失效点,并在 waterfall 上标注。
- **组件归因的精度边界**(产品承诺):provider 只给整请求聚合 usage,"按组件精确拆分"不存在;唯一例外是 turn 内相邻 step 的差分可精确得出"本步新增内容的总量"。UI 必须始终展示 basis 标记。
- **版本**:钉住当前 dsh alpha 线发布,compat matrix 与 README 双轨说明照旧维护。

## Testing Decisions

- **好测试只测外部行为**:给定一段(合成的)会话事件序列,断言归账输出的数字与分类;不测 fold 的内部结构。
- **主 seam 只有一个**:归账引擎纯函数(事件序列 → TurnTrace / 聚合)。这是最高且最便宜的 seam——纯数据进、纯数据出,无需起 dsh 运行时。参照 dsh 内置 token-meter 的 turn-usage fold 用合成事件日志驱动的测试方式。
- **边界 fixture 必须覆盖**:多 step 工具循环、retry 重试、compaction replace、interrupted turn、adapter 未上报 usage(字段缺席)、辅助调用(session 标题 / 压缩摘要,按 purpose 标记排除在 turn 账外)。
- **Remote 面**:沿用本 repo 的 verify 模式(服务注册 + 方法可读),补 API 合同断言(查询返回结构、stream 帧类型)。
- **UI**:按 verify-release skill 的 browser checklist 手动验证并截图取证。
- **差分精度验收**:用真实会话日志回放,断言差分推算的"新增 token"与 provider 数字自洽(误差带内);真实 LLM 端到端需要 API key,报告中明示未覆盖项。

## Out of Scope(首版)

- vendored tokenizer 精度增强(chars/4 + 锚定已满足 v1,M4 候选)。
- OTel / OTLP 导出(M4 候选,平台已有 telemetry-otel 先例可参照)。
- 金额成本换算(需维护价格表)。
- 非 DeepSeek provider 的 usage 语义差异适配(仅 best effort 展示已有字段)。
- 对内置 TurnUsagePanel / StatsLine / ContextMeter 的修改或替代。
- 优化建议的自动执行(只提示,不自动改配置)。

## Further Notes

- **精度预期管理是产品体验的一部分**:estimated 与 exact 混排时 UI 必须显式标注,否则"对不上账"会摧毁信任。
- **上游吸收风险**:dsh 若增强内置 usage UI,本插件的差异化守住"归因 + 跨会话分析 + 优化建议",总量展示可随时弃守。
- **两个开工前 PoC**:(1) 外部插件注册 projection wire-view 是否可行,决定实时通道是否有更轻路线;(2) 相邻 step 差分 vs chars/4 的实际误差范围,决定估算层默认密度。
- **里程碑切分**:M1 host 归账服务 + Remote 查询/推送 → M2 client waterfall → M3 跨会话聚合与优化建议(M3 细化 PRD:[PRD-token-tracing-m3.md](./PRD-token-tracing-m3.md))→ M4(tokenizer / OTel 导出,可选)。
