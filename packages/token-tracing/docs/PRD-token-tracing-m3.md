# PRD: token-tracing M3 — 跨会话看板与优化建议

> 状态:本地草稿,未 commit、未发布。
> 依据:[PRD-token-tracing.md](./PRD-token-tracing.md) 的里程碑切分(M3 = 跨会话聚合与优化建议)、[DESIGN-token-tracing.md](./DESIGN-token-tracing.md) §8.4(M3 概要:sidebar.footer.action 看板,数据面已就绪,无 host 新增),以及 `packages/token-tracing` 当前实现(host rollup/Remote 数据面与 client M2 tab 均已落地)。
> 前置:M1(host 归账 + Remote)、M2(conversation.view tab + waterfall)已实现。本 PRD 只定义 M3 增量,不动 M1/M2 既定行为。

## 1. Problem Statement

M1/M2 交付了"单会话、单轮"的 token 归因(waterfall、组件拆分、exact/estimated 徽标),但用户做周期性成本回顾时仍只能逐会话人工翻看,三个问题无解:

- **花在哪**:没有跨会话、跨天的聚合视图,回答不了"这周/这个月 token 花在哪了";
- **趋势如何**:系统提示词是否在膨胀、缓存命中率是否在恶化,逐轮看根本看不出来;
- **怎么优化**:工具排行、占比异常没有沉淀成可执行建议,更无法从异常点回到明细。

M3 用一个跨会话看板把已就绪的聚合数据面(host `days()` / `sessions()` / `summary()`,byComponent / byTool 口径)转成"回顾 → 发现 → 建议 → 定位 → 打开会话细看"的闭环。**全程客户端实现,不改 host**(沿 DESIGN 既定决策)。

## 2. Goals / Non-Goals

**Goals**

- 侧边栏入口 + 看板:近 N 天消耗总览、每日构成堆叠图、组件构成、Top 工具排行、优化建议、会话列表;
- 建议可追溯:每条建议带证据链接,点击定位到对应图表行 / 柱 / 会话;
- 看板 → 单会话闭环:展开会话摘要,或经 `ctx.sessions.open` 跳回会话页继续 M2 分析;
- basis 纪律延续:总量 exact、构成 estimated,全程徽标,不对齐不冒充。

**Non-Goals(本里程碑明确不做)**

- host 新增(Remote 方法 / 存储 / fold 变更)——DESIGN 既定"无 host 新增";
- story 5 工具结果裁剪标注:上游日志无裁剪元数据,继续推迟(记录在案);
- story 9 的完整形态(system-prompt 按 section 拆分膨胀归因):数据面只有聚合分量,section 级需 host fold 增强,列为后续候选;
- 金额换算、建议自动执行、阈值用户可配置(M3 用集中常量 + 单测锁定);
- live 实时看板:打开时拉快照 + 手动刷新,不订阅 `follow` stream;
- tokenizer 精度增强 / OTel 导出(仍属 M4)。

## 3. User Stories

| # | 故事 | 对应总 PRD |
|---|---|---|
| US-M3-1 | 作为 dsh 用户,我想在侧边栏一键打开 token 看板,看到近 N 天的总消耗与构成,这样我能做周期性成本回顾。 | 12 |
| US-M3-2 | 我想看每天的 token 消耗堆叠构成与趋势,这样我能定位成本突变发生在哪一天。 | 12 |
| US-M3-3 | 我想看工具成本排行(占比、触及会话数、环比),这样我能识别最烧 token 的工具。 | 4/12 |
| US-M3-4 | 我想看系统提示词在周期内的膨胀趋势,这样我能评估插件/skills 的固定成本。 | 9(聚合形态) |
| US-M3-5 | 我想得到按严重度排序的优化建议,且每条能点回证据位置,这样优化有抓手且数字可信。 | 13 |
| US-M3-6 | 我想从看板直接打开某会话(展开明细或跳回会话页),这样我能从聚合进入单会话分析。 | 18(跨会话扩展) |
| US-M3-7 | 我想在看板里明确区分 exact 总量与 estimated 构成,这样不会因"对不上账"困惑。 | 16 |
| US-M3-8 | 我想在无数据 / 加载失败时有明确空态与重试,这样看板行为可预期。 | 新增 |
| US-M3-9(P2) | 我想列出超过阈值的超长工具结果并定位到 turn,这样我能逐个治理大结果。 | 10 |
| US-M3-10(P2) | 我想折叠 waterfall 中过长的工具结果段,这样大 trace 仍然可读。 | 17(M2 推迟项) |

## 4. 范围与优先级

**P1(看板主体,本里程碑验收对象)**:§5 全部面板 + FR-1…FR-12。

**P2(建议做,可独立交付,不影响 P1 验收)**:

- **超长工具结果列表**(US-M3-9):选中会话后按需调用 `traceBatch(sessionId, turns)` 分批扫描(每批 20 个 turn,单会话串行;host 侧 O(replay) 批量重放已就绪且已 vendored),tool-result 分量 tokens 超阈值(默认 8k)的行列出 turn/step/工具名/tokens,点击定位到会话页 trace 视图。阈值常量与建议阈值同文件。
- **waterfall 长段折叠**(US-M3-10):M2 TurnWaterfall 补丁,单段 tokens 超阈值的工具结果段折叠为占位块,hover 显示摘要、点击展开;与现有 `action.expandAll` / `action.collapse` 文案合并实现(这些 key 已在 locales 预留但未实现)。

## 5. UI 设计

### 5.1 入口

`sidebar.footer.action` 槽位注册(照 ui-cordis 内置注册与 ui-settings 触发先例):

- id `token-dashboard`,order 100;
- wide 态显示"Token 看板"行(图标 + 文案),rail(56px)态仅图标;
- 点击开关看板,按钮态反映开启中。

**依赖新增**:client peerDeps 补 `@deepseek-ai/dsh-api-session-controller`(`ctx.sessions.open` 服务与 Context 合并,先例 scheduled-task / ui-workflow-run)与 `@deepseek-ai/dsh-client-ui-sidebar`(`sidebar.footer.action` 槽位契约,type-only)。两者已在 bootstrap `SCOPED_PACKAGES` 中,接线仅限 client package.json(`dsh.client.inject` + peerDeps)与插件程序 `inject` 增 `'sessions'`;remotes / tsconfig 引用零变更。bootstrap 并非零变更:M1/M2 依赖使 `SCOPED_PACKAGES` 种子新增 8 项(含 `dsh-client-ui-renderer` 补种,2026-09-05 记实,原「零变更」说法不准)。

### 5.2 看板形态与整体布局

- **形态**:整页视图——footer 入口组件直接渲染全屏表面(backdrop `position: fixed; inset: 0; z-index: 40` + 面板 `z-index: 41`,照 scheduled-task 抽屉的 fixed 层级先例),盖过 sidebar / conversation / details 三栏;面板内部按 section 滚动;Esc / 头部关闭按钮关闭,关闭即卸载,重开恢复默认范围(7 天)。备选机制 `shell.overlay`(ui-layout 声明的 frame 级浮层)需跨 entry 状态共享与额外依赖,不取(见 §12)。
- **布局(自上而下)**:

```
┌ 头部 ──────────────────────────────────────────────────────┐
│ Token 看板  [7天|14天|30天|90天]  [刷新]  [exact|estimated 图例]  [关闭] │
├ 总览条 SummaryStrip ───────────────────────────────────────┤
│ 总token 输入 输出 推理 缓存命中 会话数 轮次数(每项带环比 Δ) │
├ 每日堆叠条 DailyBars(核心图) ──────────────────────────────┤
│ ▓▓░░▒▒  ▓▓▓░  ▒▒▓▓  …(每天一根,按组件着色;hover 明细;点击过滤) │
├ 双栏 ──────────────────────────────────────────────────────┤
│ 组件构成(占比条+列表+系统提示词趋势 sparkline) │ Top 工具表    │
├ 优化建议 Suggestions ──────────────────────────────────────┤
│ ⚠ 「read」工具结果占请求侧 41% → 考虑收窄调用范围 …        │
├ 会话列表 SessionList ──────────────────────────────────────┤
│ 会话行(展开 byDay 迷你图 / 专属建议;「打开会话」深链)      │
└───────────────────────────────────────────────────────────┘
```

### 5.3 面板规格(数据源 / 渲染 / 交互 / 状态)

1. **头部**
   - 范围 chips:近 7 / 14 / 30 / 90 天,默认 7;切换即重拉并重算全部面板。
   - 刷新:重新拉取 days + sessions 快照(不做 live 订阅)。
   - 关闭:头部右侧关闭按钮或 Esc;关闭即卸载,重开恢复默认范围(7 天)。
   - legend:exact = provider 直报总量;estimated = 校准估算构成(复用 M2 徽标样式)。
2. **SummaryStrip(总览条)**
   - 数据:`days(rangeDays)` 各桶求和(exact 直出);会话数、轮次数同源;缓存命中率 = cacheRead / (total − output),复用 `format.cacheHitRatio` 口径。
   - 环比 Δ:一次拉取 `days(sinceDays × 2)` 按 day 切 当前/上一 两半,逐项显示 Δ%(涨跌配色与平台语义一致);无 cacheRead 上报显示 "—"(formatOptional 语义)。
3. **DailyBars(每日堆叠条)**
   - 数据:`days(rangeDays)`;x 轴按所选范围零填充(无数据的天显示空位,保证趋势形状连续);y 轴 max 归一。
   - 渲染:inline SVG 堆叠条,配色复用 `COMPONENT_COLORS`(与 waterfall 同源);hover → Tooltip 当日构成明细与总量。
   - 交互:点击某天 → 会话列表过滤到该天(`session.byDay[day]` 存在即命中),柱高亮;再点取消。建议面板不随天过滤(保持范围口径)。
4. **组件构成面板(双栏左)**
   - 数据:范围 byComponent 求和;占比 = 分量 / ΣbyComponent(请求侧口径,与 rollup.ts 注释一致)。
   - 渲染:横向占比条 + 列表(名称 / tokens / 占比);底部 system-prompt 逐日趋势 sparkline(每轮平均口径 = 当日 system-prompt 合计 ÷ 当日完成轮数,剔除调用量干扰;label 旁显示最新非零天数值,hover 逐日显示当日数值;回应 US-M3-4)。
   - 交互:列表行可高亮,作为建议证据的定位锚点。
5. **Top 工具表(双栏右)**
   - 数据:范围 byTool 求和排序;触及会话数 = `sessions()` 各行 byTool 含该工具的行数;环比 Δ 用上一周期半份同算。默认 Top 10。
   - 列:工具名 / tokens / 占请求侧比 / 触及会话 / 环比 Δ(排名隐含在行序,不设独立列)。
   - 交互偏差(2026-09-05 评审定案):行不支持主动点击,仅作为建议证据「定位」的被动高亮锚点——排名信息已由行序承载,主动点选无增量交互价值。
6. **Suggestions(优化建议面板)**
   - 数据:`deriveSuggestions()` 纯函数(规则见 §8),输入当前/上一周期的 days + sessions。
   - 渲染:按严重度(high → medium → info)排序;每条 = 严重度图标 + 标题 + 一句话建议 + 证据链接(如「read 工具占 41% →」)。
   - 交互:证据点击定位——tool → Top 工具表行高亮;component → 构成行高亮;day → DailyBars 柱高亮并过滤会话列表;session → 会话行展开。
7. **SessionList(会话列表)**
   - 数据:`sessions(rangeDays)`,lastAt 倒序;默认渲染前 50 行,底部「显示全部 N」展开(fetch 上限 10k——`sessions()` 无 fetch-all 语义);可被某天点选过滤(见 3)。
   - 行:sessionId 截断 + 首末时间 + turns + 总 token + 缓存命中率 + Top 1 组件/工具徽标。
   - 展开:该会话 byDay 迷你堆叠条 + 该会话专属建议(建议引擎的单会话输入变体)。
   - 「打开会话」按钮 → `ctx.sessions.open(sessionId)` 并关闭看板(深链闭环)。
   - 会话标题:rollup 无标题字段,首版显示 sessionId 截断 + 时间;标题化列入开放问题(§12)。
8. **空态 / 错误态**
   - 空态:范围内无数据 → 引导文案(后台补算说明 + "从新会话开始积累");范围非空但某面板无数据 → 面板级占位。
   - 错误态:days/sessions 单请求并行拉取、同源同败 → 整页错误框 + 重试、不白屏(2026-09-05 评审定案:两者出自同一远端,分面板错误无现实触发场景,记偏差)。

### 5.4 视觉与一致性

- CSS Modules + `--dsw-*` tokens + `color-mix()`(照 M2 与 ContextMeter 先例);
- 组件配色唯一来源仍为 `COMPONENT_COLORS`(看板与 waterfall 同色,不另设色表);
- 数字格式复用 `formatTokens` / `formatRatio` / `formatOptional`;basis 徽标样式复用 M2。

## 6. 功能需求

| # | 需求 | 优先级 |
|---|---|---|
| FR-1 | 注册 `sidebar.footer.action` 入口(id `token-dashboard`),wide/rail 双态渲染,按钮反映看板开关状态。 | P1 |
| FR-2 | 看板以整页视图呈现(全屏 fixed 表面,盖过三栏),支持 Esc / 头部关闭;开关状态由入口组件持有,关闭即卸载、重开恢复默认范围。 | P1 |
| FR-3 | 范围切换(7/14/30/90,默认 7)触发全部面板重算;刷新按钮重拉快照。 | P1 |
| FR-4 | 打开/刷新/切范围时并行拉取 days + sessions;loading / error / empty 三态齐全,错误可重试。 | P1 |
| FR-5 | 总览条按 §5.3-2 口径渲染:总/输入/输出必显,推理与缓存原始桶按上报可选(原「六桶」措辞歧义,2026-09-05 按布局图改为分项口径),加会话数/轮次数,逐项显示环比 Δ;exact 徽标。 | P1 |
| FR-6 | DailyBars 按 §5.3-3 渲染;hover 明细;点击某天过滤会话列表并可取消。 | P1 |
| FR-7 | 组件构成面板按 §5.3-4 渲染;system-prompt 每轮平均趋势 sparkline(含最新值与逐日 hover);行可高亮锚定。 | P1 |
| FR-8 | Top 工具表按 §5.3-5 渲染(工具/tokens/占比/触及会话/环比;排名隐含在行序);行可被证据「定位」高亮锚定,不支持主动点击(2026-09-05 记偏差)。 | P1 |
| FR-9 | 建议面板按 §8 规则引擎输出排序渲染;证据链接点击定位到对应锚点。 | P1 |
| FR-10 | 会话列表按 §5.3-7 渲染;行展开 byDay 迷你图与专属建议;「打开会话」深链跳转并关闭看板;支持按天过滤。 | P1 |
| FR-11 | 看板全局展示 exact/estimated 图例,构成类数字均带 estimated 徽标。 | P1 |
| FR-12 | 空态引导与面板级错误/重试,行为符合 §5.3-8。 | P1 |
| FR-13 | 超长工具结果列表:选中会话按需 `traceBatch()` 分批重放扫描,列出超阈值结果并定位到 turn。 | P2 |
| FR-14 | waterfall 长段折叠:超阈值工具结果段折叠为占位块,hover 摘要、点击展开。 | P2 |

## 7. 数据面与实现决策

- **复用现有 Remote,零新增**:

| 方法 | 用途 |
|---|---|
| `days(query)` | 每日聚合(总览/堆叠条/构成/工具表/建议输入) |
| `sessions(query)` | 会话列表、触及会话数、单会话建议输入 |
| `summary(sessionId)` | 会话行展开的兜底刷新(可选) |
| `traceBatch(sessionId, turns)` | P2 超长结果扫描(分批重放,已 vendored) |

- **拉取策略**:unary 快照,不订阅 follow;环比用 `days(sinceDays × 2)` 单拉切两半,避免二次 RPC;`days` 的 limit 显式传范围天数(默认 50 语义下 90 天范围需 ≥ 90,以 host 实际切片语义为准)。
- **全量计算客户端纯函数**:周期切分、跨天求和、占比、触及会话数、建议推导,各自独立、无副作用、可单测。
- **纯客户端实现**:不改 host types / fold / rollup;remotes vendored 工件零变更(无新方法、无 schema 变更)。
- **跨天归属口径**:day 桶为 UTC `'YYYY-MM-DD'`(DESIGN §2.4 既定),看板显示不再换算时区,仅轴标签标注 UTC。
- **建议引擎**:`deriveSuggestions(input) → Suggestion[]` 纯函数;阈值集中常量模块;文案走 i18n 参数插值;每个规则最多出 1 条(取最极端目标),避免刷屏。

## 8. 建议规则表(初版阈值,常量模块集中)

分母口径:占比一律 = 分量 / ΣbyComponent(请求侧校准估算);命中率 = cacheRead / (total − output)。分量按**家族口径**求和:裸 kind + `kind/name` 复合叶子键(如 `tool-result` + `tool-result/read`)——fold 只存叶子键,规则一律面向家族(2026-09-05 修复:原裸键查复合表,tool/injected 家族规则在生产数据上永不触发)。

| 规则 | 触发条件 | 严重度 | 建议文案要点 | 证据定位 |
|---|---|---|---|---|
| R1 工具结果主导 | 某工具 byTool 占比 ≥ 40% | high | 「{tool}」工具结果占请求侧 {pct}%,考虑收窄调用范围或限制结果长度 | tool 行 |
| R2a 缓存命中率低 | 范围命中率 < 50%(有 cacheRead 上报) | medium | 缓存命中率仅 {pct}%;请求侧多为未缓存输入,检查高频变动的系统提示词与工具集 | day 柱(范围内最差日;定位顺带按天过滤会话列表,2026-09-05 对齐实际行为) |
| R2b 缓存骤降 | 日命中率相邻下降 > 20pp | high | {day} 缓存命中率骤降 {pp}pp,疑似前缀缓存失效 | day 柱 |
| R3 系统提示词膨胀 | 当前周期 sys-prompt 每轮日均 ≥ 上一周期 1.2×(每轮平均 = 日合计 ÷ 完成轮数,剔除调用量干扰) | high | 系统提示词较上一周期增长 {pct}%;新插件/skills 是每轮固定成本 | component 行 |
| R4 注入内容占比高 | injected-context + runtime-context 占比 ≥ 15% | medium | 注入内容占 {pct}%,检查 context files / runtime snapshot 是否全量注入 | component 行 |
| R5 压缩开销 | compaction 占比 ≥ 10% | medium | 会话压缩摘要占 {pct}%,长会话考虑更早总结或拆分 | component 行 |
| R7 会话成本尖峰 | 离群门槛:某会话 totals ≥ 会话中位数 3×(且 ≥ 2 个会话);再按构成分类病灶,命中才提示,健康重会话(缓存健康且无可收敛构成,如纯输出驱动)不提示 | 病灶缓存<50% → high;工具≥40% / 压缩≥10% / 注入≥15% → medium(复用 R1/R5/R4/R2a 阈值) | 会话 {id} 成本 {tokens}(中位数 {factor}×)+ 具体病灶(缓存命中率仅 {pct}% / 工具结果占 {pct}% / 压缩占 {pct}% / 注入占 {pct}%)与对应处置 | session 行 |

- R7 中位数口径:只计入范围内有完成轮(totals > 0)的会话,且至少 2 个才比较(2026-09-05 补记);
- 单会话展开页复用同一引擎(输入收敛为单会话),同一批规则与阈值(R3/R7 因无基线/单会话自然不触发);
- **R6(天单轮成本离群指针)经 2026-09-05 评审移除**:它是纯离群提示——病灶场景已由 R7 病灶分类覆盖,健康重会话的天尖峰属工作量非问题;「哪天贵」的发现职能由每日构成图(堆叠柱 + hover 数值 + 点选筛选会话)直接承担,建议面板不再重复;
- 阈值/倍数均为初值,集中一个常量文件,单测锁定行为;用户可配置化留作后续;
- 不满足任何规则时面板显示"当前范围内没有发现明显问题"的正面空态。

## 9. i18n

- 复用 NS `token-tracing` 与 KEY_SET 模式(LocaleNamespaceMap 合并已就绪);新增 `dashboard.*` key 组:标题、范围 chips、总览字段、面板标题、表头、建议文案模板、证据链接文案、空态、错误态、打开会话、图例——zh/en 全量。
- 建议文案参数插值(工具名、百分比、天数、sessionId 截断);工具名不翻译;数字经既有 format 函数输出。

## 10. 测试决策

- **纯函数单测**(照 fold 测试哲学,好测试只测外部行为):
  - 周期切分:sinceDays×2 → 当前/上一两半,边界覆盖同天、跨月、无数据、单边有数据;
  - 范围聚合:跨天 byComponent/byTool 求和、占比合计 = 1、触及会话数、环比 Δ 符号;
  - `deriveSuggestions`:每规则触发/不触发边界(阈值 ±1)、严重度排序、证据 payload、每规则上限 1 条、无规则时正面空态;
- **UI**:按 verify-release browser checklist 手测截图(§11);合成 rollup 夹具驱动看板各面板,无真实 LLM 依赖;
- 不新增 host 测试面;fold/rollup 既有测试不回退。

## 11. 验收标准(浏览器 checklist)

1. 安装四包后,sidebar 底部 Settings 旁出现「Token 看板」入口;rail 收起态仅图标;点击开关看板,按钮态正确。
2. 默认范围近 7 天;总览 exact 桶与 days 数据求和一致;构成占比合计 100% ± 0.5%(取整容差)。
3. DailyBars:堆叠配色与 waterfall 一致;hover 显示当日构成;点击某天过滤会话列表,再点取消。
4. Top 工具表:占比、触及会话数、环比 Δ 与手算一致。
5. 建议面板:合成夹具触发各规则;证据点击定位到对应行/柱/会话;无规则时显示正面空态。
6. 会话行展开 byDay 迷你图;「打开会话」跳转至该会话且看板关闭。
7. 范围切换 / 刷新后全部面板按新范围重算;范围内无数据显示空态引导;拉取失败显示面板级错误 + 重试。
8. zh/en 切换全量文案正确,无缺 key。
9. P2(若交付):超长工具结果列表可定位到 turn;waterfall 长段折叠/展开正常。

## 12. 风险与开放问题

| 项 | 说明与决策 |
|---|---|
| 看板形态 | 已决策:整页视图(fixed 全屏表面,照 scheduled-task 抽屉层级)。`shell.overlay` 备选未取:需跨 entry 状态共享 + ui-layout 依赖;若后续需要与平台浮层统一次序再迁移。 |
| days limit 语义 | 90 天范围需显式传 limit ≥ 90;实现时以 host 实际切片语义为准,若 limit 未实现切片则按需取全部再截断。 |
| 会话标题缺失 | SessionRollupView 无标题;首版 sessionId 截断 + 时间。若用户强需,后续 host 增加标题字段(engine bump 触发 backfill,成本可控)或客户端查会话标题服务。 |
| 深链新依赖 | peerDeps 新增 `dsh-api-session-controller`(运行时服务 + Context 合并)/ `dsh-client-ui-sidebar`(槽位类型);两者已在 bootstrap SCOPED_PACKAGES;接线为 client package.json 与程序 inject;bootstrap 实际新增种子 8 项(记实),tsconfig 零变更;ci:local 仍须跑,防干净环境类型解析缺口(DESIGN §5.1 既有风险)。 |
| 环比口径 | sinceDays×2 单拉切半;跨期会话按 lastAt/byDay 所在半区归属,不重复计。 |
| 建议阈值未校准 | 初值常量 + 单测;真实使用后按反馈调参,可配置化后续。 |
| story 5 / section 拆分 | 上游无裁剪元数据;system-prompt section 级拆分需 host fold 增强——均记录为后续候选,不阻塞 M3。 |
