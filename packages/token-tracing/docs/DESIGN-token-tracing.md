# token-tracing 插件技术设计

> 状态:本地设计稿,未 commit、未发布。依据 [PRD-token-tracing.md](./PRD-token-tracing.md)、[PRD-token-tracing-m3.md](./PRD-token-tracing-m3.md) 与 2026-08/09 对 dsh `v0.1.2-alpha.2`(sibling checkout 即该 tag)的源码核实。里程碑切分沿用 PRD:M1 host 归账、M2 client waterfall、M3 跨会话看板(§10 已细化)。
>
> 用户已确认的三个决策:**设计深度 M1+M2+M3 详细**;**每插件独立版本线**;**M3 看板用整页视图**。

## 0. 决策摘要

| 决策 | 结论 | 依据 |
|---|---|---|
| 包结构 | 四包布局照抄 scheduled-task,namespace `tokenTracing` | 外部插件唯一已验证管线 |
| UI 入口 | `conversation.view` session tab(id `token-trace`) | trajectory 是完整先例 |
| 数据通道 | host 订阅 `session/event` + `ctx.sessionQuery` 按需重放;**不用** projection wire-view | projection 是整日志聚合形态,不匹配 per-turn trace;外部注册未验证。PRD 的 PoC-1 取消 |
| 实时推送 | 插件自己的 `@Remote({mode:'stream'})` | 外部插件首个 stream 工件,字段已从 session-controller 生成物逐项核实 |
| 归因方法 | 三层:exact(provider usage)/ 差分(相邻 attempt,总量精确)/ 校准估算(chars 密度 × exact 总量锚定) | provider 只给聚合 usage;差分在 series 内总量精确 |
| 复用 | import `@deepseek-ai/dsh-token-meter/client` 的 `deriveTurnTokenUsage` 作对账基准;其 estimate 启发式未公开导出,插件内重实现(常量对齐) | 已核实 `./client` 导出面 |
| 版本线 | 每插件独立:tag `<plugin>-vX.Y.Z`,publish.yml 按插件参数化 | 用户决策(2026-09-01) |

## 1. 包结构与命名

```
packages/token-tracing/
├── host/      @qihongmu/dsh-plugins-token-tracing          # 归账引擎 + 存储 + Remote
├── remotes/   @qihongmu/dsh-client-remotes-token-tracing   # $mount + vendored remote-client(含 stream)
├── client/    @qihongmu/dsh-client-ui-token-tracing        # conversation.view tab UI
└── bundle/    @qihongmu/dsh-plugins-token-tracing-bundle   # 聚合安装(dists 依赖三半)
```

- cordis patch ids:`plugins-token-tracing` / `plugins-remotes-token-tracing` / `plugins-ui-token-tracing`;bundle patch 三行,各带 scheduled-task 同款 `disabled: !!js` 重复守卫。
- manifest 结构、exports map、`dsh.client.inject`/`immediately`(remotes 包)逐一照抄 scheduled-task;版本号独立起线(`0.1.0`)。
- host peerDependencies(全 `*`):scheduled-task 现有集合中与本插件相关的子集 + 新增 `dsh-token-meter`、`dsh-session-query`。实际 inject 只声明用到的 service。

## 2. Host 设计(M1)

### 2.1 服务与生命周期

```ts
export class TokenTracingService extends TypertRemoteService {
  static inject = ['storageDomain', 'sessions', 'sessionQuery']
  constructor(ctx) { super(ctx, 'tokenTracing') }
  protected async [Service.init]() {
    this.domain = await this.ctx.storageDomain.open(tokenTracingDomainSpec)
    this.ctx.effect(() => () => this.domain.close(), 'token-tracing.domainClose')
    this.ctx.on('session/event', (session, event) => this.ingest(session, event))
    void this.backfill()   // 断点续算,见 2.6
  }
}
```

`ingest` 保持 fire-and-forget 语义(观察者失败被 cordis 容纳),内部 try/catch 后记 logger,绝不抛出影响宿主。

### 2.2 归因引擎(纯函数,`host/src/fold/`,零 ctx 依赖)

引擎是本插件的核心资产:`foldEvents(sessionId, seed, events) => FoldResult`,输入事件序列,输出 TurnTrace 与 rollup 增量;live 与 replay 共用同一条代码路径。

**基本模型**

- **Attempt** = 一次 LLM 调用。以 `assistant/message` 事件为 authoritative record(键:`(turn, step, seq)`);同 step 内 `llm/retry` 标记的重复调用是独立 attempt(`retry: true`)。`assistant/chunk` 里的 usage chunk 在 message finalize 前只作 live 提前展示;当 attempt 以 `llm/retry` 或 `step/end` 收口(最终 message 未到达)时,该 sample 作为该次计费调用的 usage 入账。
- **promptTotal(attempt)** := `usage.totalTokens − usage.outputTokens`(DeepSeek 恒有 total_tokens);缺失时回退 `inputTokens + cacheReadTokens + cacheWriteTokens`(实现按 harness `llm/types` 的三桶 DISJOINT 不变式——初版设计文本称 cacheWrite 不计入,经源码核对为过时描述,以实现为准)。
- **SurfaceModel**(会话级增量状态):有序节点 `[{ seq, kind: 'user'|'assistant'|'tool-result', sourceKind?, toolName?, chars }]`。由 `user/message`(sourceKind 区分 direct/plugin 注入)、`assistant/message`、`tool/result` 构建;`surfaceOp: {op:'replace', start, end}` 删区间节点并插入替换节点(replace 后 start 可大于 end,按 harness 语义处理)。

**三层归因**

1. **exact 层**:每 attempt 的 usage 六桶(input / output / reasoning / cacheRead / cacheWrite / total)直记,`basis: 'exact'`。
2. **差分层(增量,总量精确)**:同一 header series 内(两 attempt 之间无 `reason ∈ {initial, resume, change}` 的 `request/header`、无 compaction replace),`Δprompt = promptTotal(k) − promptTotal(k−1)` 即该间隔新增内容(上一步 assistant 输出重序列化 + 本步 tool results + mid-turn steering 注入)的**精确 token 总量**。Δ 在间隔内新增 surface 节点间按 chars 估算占比分摊——总量精确、内部占比估算,节点级标 `estimated`。Δ < 0 或跨 series → 退化为第 3 层。
3. **校准估算层(构成)**:series 首个及 header 变更后的 request:组件大小 = `header.system` 字符数 + Σ tools schema 字符数 + 各 surface 节点字符数,密度 4 chars/token + 每块 ~4 token 结构开销;`scale = promptTotal / Σestimate`;每组件 = estimate × scale,全部 `basis: 'estimated'`。**自洽不变量:Σcomposition === promptTotal(±ε)**。

**边界处理**

| 情形 | 处理 |
|---|---|
| interrupted turn | turn 以 `interrupted` 收尾 → `status: 'incomplete'`,不跨它做差分 |
| usage 缺失(adapter 未上报) | `usage: null`,只记结构与时间,不参与差分链 |
| compaction | 伪 attempt(`kind: 'compaction'`);usage 取 `compaction/summary.usage`(exact);`shadowedTokenCount` 记被替换 tokens(估算);compaction 后的第一个 request 不做差分;其实测 Δprompt 为负时归因**精确** `context-shrink`(而非影子价),并与 `−shadowedTokenCount` 交叉验证——验证在对账脚本(replay-diagnose)中量化 |
| 辅助调用(session title / 压缩摘要自身) | 按 purpose 排除在 turn 账外;压缩摘要的成本记入 compaction 伪 attempt(真实成本) |
| mid-turn steering | turn 内 inbox 注入的 `user/message` 属于该 turn 的 additions,归因 `user-input` |
| 缓存失效 | attempt 标 `invalidated`,当 (a) 间隔内出现 `reason: 'change'` 的 header,或 (b) Δprompt > 0 且 `cacheReadTokens(k) < promptTotal(k−1) × 0.9` |

### 2.3 TurnTrace schema(`host/src/types.ts`,client-safe 纯类型)

```ts
interface TurnTrace {
  sessionId: SessionId
  turn: number
  status: 'active' | 'complete' | 'incomplete'
  attempts: AttemptTrace[]
  totals: TokenUsage | null          // exact,turn 内全部 attempt 直加
  cacheEvents: { atSeq: number; kind: 'invalidated' | 'compacted' }[]
}
interface AttemptTrace {
  seq: number
  turn: number
  step: number
  retry?: true
  kind: 'llm' | 'compaction'
  usage: TokenUsage | null           // exact
  promptTotal: number | null
  composition: ComponentSplit[] | null  // 整请求构成(校准估算)
  additions: ComponentSplit[] | null    // 相对前一 attempt 增量(差分或退化)
  cache: { read: number; write: number; hitRatio: number } | null
  invalidated?: true
}
interface ComponentSplit {
  kind: ComponentKind
  name?: string          // 工具名 / 注入来源名
  tokens: number
  basis: 'exact' | 'estimated'
}
type ComponentKind =
  | 'user-input' | 'injected-context' | 'runtime-context' | 'system-prompt'
  | 'tool-definitions' | 'tool-result' | 'assistant-output' | 'reasoning'
  | 'compaction' | 'context-shrink'
```

`TokenUsage` 直接复用 `@deepseek-ai/dsh-llm` 类型,不自造。zod schema 与本类型同步维护在 vendored remote-client 里(CONTRIBUTING 既有规则:types.ts 变更必须同步两处工件)。

### 2.4 存储(storageDomain,domain `token_tracing` v1)

| 表 | key | value(zod) |
|---|---|---|
| `sessions` | SessionId | SessionRollup `{ lastSeq, turns, incompleteTurns, totals(六桶 exact), byComponent(estimated 口径累计), byTool, byDay(逐日聚合,含天级 totals/byComponent/byToolTop), firstAt, lastAt }` |

- **单一 `sessions` 表**:初版设计的 `days`/`meta` 两表在 M1 实现时折叠——天级聚合即各 rollup 的 `byDay` 切片(客户端看板按日窗重排),backfill 进度由逐 session 的 `lastSeq` 覆盖点表达,无需全局 meta。
- **明细 trace 不落库**:按需从会话日志重算 + 进程内 LRU(key `(sessionId, turn, lastSeq)`,容量 32)。理由:trace 可从平台日志确定性重建,落库会复制会话内容(PRD user story 21)。
- rollup 在 `turn/end` 时增量 put(写链原子 `update`);days 按 UTC 日期归桶(实现口径,避免本地时区歧义;初版设计写"本地日期"已废弃)。
- **rc.1 韧性声明**(dsh-v0.1.2-rc.1 起):spec 声明 `layout: 'per-record'` + `invalidRecords: 'backup-and-skip'`——单条 rollup 文档损坏/过版即读作缺席,格式有效但 zod 失败的记录移至 `<key>.json.bak.<stamp>` 后跳过,绝不阻塞 boot(rollup 可经 `backfillAll` 全量重建,属可丢弃派生数据);旧整单元文件(布局切换前)按 legacy bootstrap 一次性迁入记录树且永不删除。集成测试见 `host/tests/domain.test.ts`。

### 2.5 Remote API(namespace `tokenTracing`)

| 方法 | 形态 | 签名要点 |
|---|---|---|
| `sessions(query?)` | unary | `{ limit?, sinceDays? }` → `SessionRollup[]`(新→旧) |
| `summary(sessionId)` | unary | → `SessionRollup` |
| `trace(sessionId, turn)` | unary | → `TurnTrace`(重放:`sessionQuery.listEvents` 一次拉全 + 内存截取 turn 区间,`readSurface()` 播种 SurfaceModel;`filterEvents` 过滤能力不足,采用退化路径并配 lastSeq 缓存) |
| `follow(sessionId, signal)` | **stream** | → `AsyncIterable<TokenTraceFrame>` |
| `days(sinceDays)` | unary | → `DayRollup[]`(M3 数据面,M1 顺带暴露) |
| `backfillAll()` | unary | → `{ processed }`(手动补算入口) |

```ts
type TokenTraceFrame =
  | { kind: 'snapshot'; summary: SessionRollup; activeTurn: TurnTrace | null }
  | { kind: 'turn'; trace: TurnTrace }            // turn/end 时发完整帧
  | { kind: 'attempt'; attempt: AttemptTrace }    // live 节流 ~500ms,仅摘要
```

follow 实现:per-session 订阅注册表;snapshot 立即推,后续 ingest 事件驱动增量帧;signal 取消时清理。

### 2.6 backfill

启动时 `listSessions()` → 对 `rollup.lastSeq` 落后于日志尾部的 session 逐个重放追平(写回 sessions/days/meta.backfillThrough,断点续算)。对存量会话实现 PRD user story 14(补算历史),不阻塞服务启动(后台分批)。

## 3. Client 设计(M2)

### 3.1 入口注册(照 trajectory 先例,`client/src/client/index.ts`)

```ts
export const inject = ['slots', 'locale', 'remote', 'remote.tokenTracing']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-token-tracing: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'token-trace',
    order: 15,                      // trajectory 是 10
    locale: NS,
    label: () => t('view.tokenTrace'),
    inject: (sessionId: SessionId): TokenTraceInjected =>
      ({ remote: ctx.remote.tokenTracing, sessionId }),
  }, TokenTraceView))
}
```

类型行照抄 trajectory:`import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'`(拉入 SlotMap 行)等。remotes 包 `dsh.client: { inject: ['@deepseek-ai/dsh-api-gateway'], platform: 'web', immediately: true }` 照抄。

### 3.2 视图组件

```
TokenTraceView( session tab 主视图 )
├── SummaryBar        # exact 六桶 + cache hit%,来自 follow snapshot
├── TurnList          # 倒序,每行 turn 号 / 状态 / 总量;选中 → TurnWaterfall
└── TurnWaterfall( 选中 turn )
    ├── 视角切换:Increment(默认) / Composition
    ├── SVG 行 = attempt(含 compaction 伪行)
    ├── StepDetail( 点击行 → 锚定面板 )
    └── Legend( basis 徽标:exact / estimated )
```

- **TurnWaterfall(SVG,无图表库——平台无 charting 依赖,先例全是 inline SVG + CSS Modules)**:
  - 每行一段:左 = prompt 构成堆叠条(cacheRead 中性灰;uncached 按组件着色),右 = output(text vs reasoning 分色);x 轴 = tokens,行宽按 promptTotal 归一。
  - Increment 视角画 `additions`(本步新增),Composition 视角画整请求 `composition`。
  - `invalidated` 行加 ⚡ 标记;compaction 伪行画替换量(shadowed vs summary)。
  - hover → `Tooltip`(ui-primitives);点击行 → **StepDetail**:`useAnchoredPosition` 锚定面板,展示 exact 六桶、additions/composition 明细表、basis 图例。
  - 布局实现参照 TrajectoryTimeline 的 CSS 自定义属性定位法(`--span-left/--span-width`)。
- **live**:视图打开时 `for await (const frame of remote.tokenTracing.follow(sessionId, signal))`;active turn 的 attempt 帧驱动 waterfall 局部更新,turn 帧触发列表刷新;历史 turn 用 `trace()` 拉取。组件卸载时中断消费(AbortController)。
- **样式**:CSS Modules + `--dsw-*` tokens + `color-mix()`(照 ContextMeter / TrajectoryTimeline);组件着色表集中一处常量,保证 ComponentKind → 颜色稳定。

### 3.3 i18n

NS `token-tracing`,KEY_SET 模式 + zh/en 全量字典;`LocaleNamespaceMap` ambient 合并照 scheduled-task。文案涵盖:视图标签、组件名(含注入来源)、basis 徽标、缓存事件、建议文案占位(M3)。

## 4. 手工 vendored 工件(最高风险项)

外部包不能生成 typert 工件(gen:typert 仅诊断),两处手工维护:

1. **`remotes/src/client/remote-client.js`**:unary 方法照 scheduled-task 模板(zod inline + strict codec)。`follow` 是外部插件**首个 stream descriptor**,字段逐项照 session-controller 生成物(`packages/api/session-controller/lib/typert.remote-client.js` 的 `session/follow`):

```js
{
  id: '@qihongmu/dsh-plugins-token-tracing#tokenTracing/follow',
  service: 'tokenTracing', namespace: 'tokenTracing', method: 'follow',
  mode: 'stream',
  invocation: { kind: 'direct' },
  parameters: [ /* request codec */ ],
  cancellation: { parameter: 'signal' },
  result: { mode: 'strict', typeSymbol: '<pkg>/types#TokenTraceFrame', schema },
}
```

2. **`host/lib/typert.remote-client.d.ts`**:ambient 合并 `TypertRemoteNamespace` / `TypertRemoteMap` / `TypertRemoteNamespaceMap` 三接口;`follow` 签名 async-iterable 形态,照 session-controller d.ts 的 stream 方法签名。

冒烟策略:M1 先做最小 `follow` 链路(isolated DSH_HOME + `dsh web` 手测流式帧),验证通过后再铺开其余方法——stream 工件是全插件唯一无先例的手工件。

## 5. 仓库接线与发布(独立版本线)

### 5.1 接线清单(一次性)

| 文件 | 变更 |
|---|---|
| `scripts/bootstrap.mjs` | SELF_LINKS += 3 个新包;SCOPED_PACKAGES += `dsh-token-meter`、`dsh-session-query`、`dsh-client-ui-conversation`(host 类型 import 前两个;ui-conversation 是 type-only,不进 runtime bundle,但 clean runner 的 tsc 需可解析——以 ci:local 实测为准) |
| `scripts/test.mjs` | testRoots += token-tracing 的 host/tests(及 client/tests) |
| `tsconfig.host.json` / `tsconfig.client.json` | references += 新包(verify-remote 与 build-web 由引用驱动,自动发现) |
| `.github/workflows/publish.yml` | **按插件参数化**:tag `<plugin>-vX.Y.Z` 前缀 → 插件目录映射;tag 校验 = 该插件 host manifest 版本;只发布该插件四包(host→remotes→client→bundle,prerelease `--tag alpha`);OIDC 探针按包名 |
| `scripts/verify-env.sh` | publish 循环与 probe 按插件参数化 |
| 根 README(.zh-CN) | 插件表新增一行;compat matrix 按插件分列 |
| lifecycle / verify-release skills | repo-model 表、onboarding 注意事项补第二个插件的事实 |

### 5.2 版本与 tag

- 两插件独立版本线:scheduled-task 维持现有 `v*` tag 不动;token-tracing 从 `<plugin>-v0.1.0` 起。
- publish.yml 逻辑:解析 tag 前缀得到插件目录,其余门(gate job、OIDC、dist-tag 纪律)不变。

## 6. 测试设计

- **fold 单测(golden fixtures,主 seam 唯一)**:合成事件序列 → 断言 TurnTrace 数值与 basis。必覆盖:多 step 工具循环 / retry / compaction replace / interrupted / usage 缺失 / mid-turn steering / header change 断 series。
- **自洽属性测试**:Σcomposition === promptTotal(±ε);同一 series 内 promptTotal 单调,除非 compaction / steering 介入。
- **service 测试**:fake ctx 模式照 scheduled-task `service.test.ts`;断言 rollup 增量、follow 注册清理。
- **对账脚本 `scripts/replay-diagnose.mjs`**:真实会话日志回放,`deriveTurnTokenUsage`(token-meter/client)vs 本引擎 totals 输出对账表,并量化差分/估算误差——PRD PoC-2 的落地形式。
- verify-remote 由 tsconfig 引用自动发现新 host 包;UI 按 verify-release browser checklist 手测截图;真实 LLM 端到端需 API key,报告明示未覆盖。

## 7. 风险与缓解

| 风险 | 缓解 |
|---|---|
| stream 手工工件无先例 | M1 最小 follow 冒烟先行(§4);字段已从生成物逐项核实 |
| `filterEvents` 过滤能力不足 | 已定退化路径(listEvents 一次拉全 + 内存截取 + lastSeq 缓存) |
| 差分内部占比误差 | basis 全程标注 + 对账脚本量化;UI 不冒充精确 |
| 大 session 重放成本 | readSurface 播种 + lastSeq 断点 + LRU;backfill 分批 |
| 上游 schema 演进 | 钉 `dsh-v0.1.2-alpha.2`;compat matrix 按插件维护 |
| SCOPED_PACKAGES 遗漏致 clean CI 挂 | ci:local(空临时副本)本地先跑 |

## 8. 实施顺序与验收

1. **M1**:fold(estimate → 差分 → compaction/边界)→ rollup/storage → Remote unary + follow → backfill → replay-diagnose 对账 → `ci:local` 三件套(bootstrap/build/test/verify)。
   验收:fixtures 全绿;对账脚本在真实日志上 totals 与 token-meter 一致、误差表产出。
2. **M1.5**:isolated DSH_HOME 冒烟:安装四包,`dsh web` 验证 follow 流式帧、trace 正确性、rollup 持久化。
3. **M2**:client tab → waterfall → live → i18n/css → verify-release checklist。
   验收:browser checklist 每项截图;estimated/exact 徽标可见;compaction/interrupted 行渲染正确。
4. **M3(数据面已就绪)**:`sidebar.footer.action` 看板——days 堆叠条 + top tools 表 + 优化建议文案(工具成本排行 / 缓存失效率 / 系统提示词膨胀趋势)。无 host 新增。细化 PRD:[PRD-token-tracing-m3.md](./PRD-token-tracing-m3.md);设计见 §10(整页视图,footer 入口组件渲染全屏表面)。

## 9. PRD story 覆盖状态(实现后回写)

- **story 19(导出 trace JSON)已实现**:client 选中轮次区「导出 JSON」按钮,下载 `{kind, version, sessionId, exportedAt, trace}` 文件(纯 client,无新 Remote)。
- **story 5(工具结果裁剪标注)/ 17(长段折叠缩放)在 M2 推迟处理**:17 现归 M3 P2(§10.8);5 继续推迟——harness 日志不记录工具结果的裁剪元数据,精确标注需上游配合;瀑布图按类聚合已缓解长 trace 可读性问题。
- story 9 / 12 / 13 属 M3(数据面 `days`/`byTool`/`byComponent` 已就绪)——M3 细化见 [PRD-token-tracing-m3.md](./PRD-token-tracing-m3.md),设计见 §10;story 10 / 17 为 M3 P2(§10.8);story 5(裁剪标注)继续推迟:上游无裁剪元数据。
- **M3 P1 已实现(2026-09-01,本地未提交)**:`dashboard/` 纯函数层(range/aggregate/suggest,45 项单测)+ 六面板整页看板 + footer 入口 + 深链;接线仅 client package.json / index.ts / locales(§10.6 预测兑现,bootstrap/tsconfig/remotes 零变更)。`npm run build` / `test`(198)/ `verify` / `build:web` / `ci:local` 全绿。浏览器 checklist(PRD §11)尚未执行。
- **M3 P2 已实现(2026-09-01)**:FR-13 超长结果扫描 + FR-14 瀑布折叠(§10.8),测试 216/216 全绿。M3 全部功能项交付完毕,余浏览器 checklist 取证。

## 10. Client 设计(M3 看板)

### 10.0 决策摘要

| 决策 | 结论 | 依据 |
|---|---|---|
| 看板形态 | 整页视图:footer 入口组件渲染全屏 fixed 表面(backdrop z-40 / 面板 z-41) | 用户决策(2026-09-01);scheduled-task 抽屉同款 fixed 层级已在浏览器验证 |
| 渲染落点 | 不注册 `shell.overlay`:入口组件内 `useState` 开关,单组件树渲染触发器 + 全屏表面 | 免跨 entry 状态共享与 ui-layout 依赖;slot-catalog 推荐的 shell.overlay 记录为备选 |
| 深链 | `ctx.sessions.open(sessionId)`(服务 `sessions` 由 api-session-controller 提供,Context 合并同包声明) | ui-workflow-run 先例;open 置 stage,内置会话 UI 跟随切换 |
| 数据 | 复用 days / sessions / summary / traceBatch,零 host 变更;环比 = `sinceDays 2R` 单拉切半 | PRD §7;traceBatch 已 vendored |
| 建议引擎 | `deriveSuggestions` 纯函数 + 集中阈值常量 | 与 fold 同哲学:纯数据进、纯数据出 |
| 状态共享 | 无跨组件外部状态:整页组件由 footer 入口组件内部渲染,普通 useState | 单 entry 组件树 |

### 10.1 入口与整页视图(`client/src/client/index.ts` 扩展)

`apply()` 增一个注册(现有 conversation.view 注册不动):

```ts
export const inject = ['slots', 'locale', 'remote', 'remote.tokenTracing', 'sessions']
// type-only 增两处:
// import type {} from '@deepseek-ai/dsh-api-session-controller/client'  // ctx.sessions Context 合并(该包 src/client/index.ts:69 声明)
// import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'       // sidebar.footer.action SlotMap 行

ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
  name: 'sidebar.footer.action',
  id: 'token-dashboard',      // 与 scheduled-task 的 id 并列,互不覆盖
  order: 100,
  locale: NS,
  label: () => t('dashboard.title'),
  inject: (): TokenDashboardFace => ({
    remote: ctx.remote.tokenTracing,
    openSession: (id: string) => { ctx.sessions.open(id) },
  }),
}, TokenDashboardEntry))
```

- `TokenDashboardEntry` 内 `useState open`;渲染触发器(wide/rail 双态,照 scheduled-task)与,open 时,全屏表面:
  - backdrop:`position: fixed; inset: 0; z-index: 40; background: rgb(0 0 0 / 32%)`(scheduled-task 抽屉同款);
  - 面板:`position: fixed; inset: 0; z-index: 41`,自滚动,`--dsw-alias-bg-base` 底色,`--dsh-scrollbar-*` 照抽屉写法;
  - Esc 关闭(keydown 监听,useEffect 清理)、头部关闭按钮;关闭即卸载数据子树,重开恢复默认范围;
  - 打开瞬间发数据拉取(与 scheduled-task `if (open) void refresh()` 同式)。
- **为何不注册 `shell.overlay`**:该槽位是 frame 级浮层、click-through 层,适合徽标/toast;整页面经它注册需触发器与浮层两个 entry 共享开关状态(模块级 store)+ ui-layout 类型依赖;而 footer entry 直接 fixed 渲染已被 scheduled-task 验证。若未来需要与平台浮层统一次序,再迁移(改动局限于 DashboardEntry 的渲染方式)。

### 10.2 模块拆分(`client/src/client/dashboard/`)

```
dashboard/
├── range.ts          # splitRange(days, R) → { current, previous } / splitSessions(纯函数)
├── aggregate.ts      # sumBuckets / mergeComponents / mergeTools / toolReach / deltas(纯函数)
├── suggest.ts        # deriveSuggestions / deriveSessionSuggestions + SUGGESTION_THRESHOLDS
├── DashboardEntry.tsx    # footer 触发器 + 全屏表面(§10.1)
├── DashboardView.tsx     # 头部/范围/数据拉取编排 + 面板布局 + locate 联动
├── SummaryStrip.tsx
├── DailyBars.tsx
├── ComponentPanel.tsx    # 占比条 + 列表 + system-prompt sparkline
├── TopToolsTable.tsx
├── SuggestionsPanel.tsx
├── SessionList.tsx
└── Dashboard.module.css
```

合成 rollup 夹具构造器放 `client/tests/fixtures.ts`(不落源码目录)。

### 10.3 数据流

- **拉取参数**:`days({ sinceDays: 2R, limit: 2R + 2 })`(host days() 经 mergeDayRollups slice,默认 50 会截断 90 天范围);`sessions({ sinceDays: 2R, limit: 10_000 })`(sessions() 无"取全部"语义;10k 覆盖现实规模,触及会话数与中位数在超限时退化为可见样本口径,接受并记录)。
- **环比切分**:`splitRange(days, R)`:cutoff = 今天(UTC) − R 天;day ≥ cutoff → current,其余 previous;会话按 `lastAt ≥ cutoff` 切两半。同天、跨月、无数据、单边有数据边界由单测覆盖。
- **竞态**:unary 无 signal;每次拉取 `reqId++`,resolve 时非最新即丢弃(范围快速切换守卫)。
- **错误/空态**:任一 Promise reject → 面板级错误 + 重试;两拉全空 → 引导空态(PRD §5.3-8)。不订阅 follow;刷新按钮手动重拉。

### 10.4 面板与图表实现要点

- **DailyBars**:inline SVG(平台无 charting 依赖,先例 TurnWaterfall)。x = 范围天数(零填充,无数据天渲染空位细柱);每天一列,按 ComponentKind 自下而上堆 rect,色取 `COMPONENT_COLORS`;hover 用行级 state + ui-primitives Tooltip(与 M2 一致,不用原生 title);点击天 → `selectedDay` state → SessionList 过滤(按 `session.byDay[day]` 存在)。
- **ComponentPanel**:范围占比条与 M2 堆叠条同构(百分比列宽);system-prompt sparkline 为 polyline(每轮平均口径 = 日合计 ÷ 完成轮数,`dayAvgSystemPrompt`),缺数据天留断点;label 旁显示最新非零天值,hover 逐日 tooltip。
- **TopToolsTable / SessionList**:表格行,Δ 徽标复用 Pill;会话行展开 byDay 迷你条(DailyBars 窄版复用)。
- **SuggestionsPanel + locate 联动**:`locate` state(`{ kind: 'tool'|'component'|'day'|'session', key }`)由 DashboardView 持有;证据点击 → setLocate + 对应面板 scrollIntoView + 短暂高亮(定位后清除高亮,保留选中)。
- **数字与徽标**:`formatTokens` / `formatRatio` / `formatOptional` 与 M2 basis 徽标样式复用;构成类数字一律 estimated 徽标。

### 10.5 i18n

- `locales.ts` KEY_SET 增 `dashboard.*` 与 `rule.*` 两组(zh/en 全量):标题、关闭、范围 chips、刷新、图例、总览字段、面板标题、表头、建议模板(参数插值:{tool} {pct} {day} {tokens} {id})、空态、错误态、打开会话;
- LocaleNamespaceMap 合并已存在,零改动;label 传 thunk 跟随 locale(与既有注册一致);工具名不翻译。

### 10.6 依赖与接线变更清单

| 文件 | 变更 |
|---|---|
| `packages/token-tracing/client/package.json` | `dsh.client.inject` += `@deepseek-ai/dsh-api-session-controller`、`@deepseek-ai/dsh-client-ui-sidebar`;peerDependencies += 同两包(`*`) |
| `packages/token-tracing/client/src/client/index.ts` | inject += `'sessions'`;type-only import 两处;新增 footer.action 注册 |
| `packages/token-tracing/client/src/client/locales.ts` | KEY_SET + zh/en 增 dashboard/rule 组 |
| 其余 | **零变更**:bootstrap SCOPED_PACKAGES 已含两包(api-session-controller / ui-sidebar);tsconfig 引用不动;remotes / vendored 工件不动(无 Remote 面变更);tsdown externals 不动(无新运行时 import——sessions 服务为平台注入,其余类型级) |

### 10.7 样式

CSS Modules + `--dsw-*` tokens + `color-mix()`;z-index 常量(backdrop 40 / 面板 41)对齐 scheduled-task 抽屉;滚动条自定义属性照抽屉写法;组件配色唯一来源 `COMPONENT_COLORS`。

### 10.8 P2(独立交付,不动 P1 结构)

- **超长工具结果列表(FR-13,已实现 2026-09-01)**:SessionList 展开区"扫描超长工具结果"显式动作(traceBatch 按批重放会话日志,绝不自动触发)→ `batchTurnNumbers` 分批(20 turn/批,单会话串行,run-token 丢弃陈旧应答)→ `scanTurns` 纯函数扫描 tool-result 分量 tokens **严格大于** 8k 的行,按 (turn, tool) 去重取最大观测(缓存失效重发会在后续 series-start composition 里重复报告同一结果);行 = `#turn · s{step} · 工具 · tokens`(定位到会话页后手动选中 turn,选中态直传仍留待评估)。阈值常量 `LONG_RESULT_TOKENS` 与批大小 `SCAN_BATCH_TURNS` 同建议阈值文件(suggest.ts);纯函数测试 `client/tests/scan.test.ts`(阈值 ±1、compositions/additions 覆盖、去重、排序、批切分)。
- **waterfall 长段折叠(FR-14,已实现 2026-09-01)**:TurnWaterfall 段级折叠——tool-result 段 tokens 严格大于 `LONG_RESULT_TOKENS`(与 FR-13 扫描同一常量,单一语义源:看板标记的超长 = 瀑布折叠的段)默认折叠为 20px 虚线占位块(`»`,留白保持行内真实比例),hover 摘要 + 点击展开(不触发行选中);展开段左缘 12px `«` 手柄点击收起;折叠态按键 `kind/name`(即 `segmentKey`,与 `aggregateByKind` 合并键一致)全局于整张瀑布并在视图切换间保持。纯函数 `segmentKey`/`isFoldable` 落 component-meta.ts(无 react/css 依赖,可被 node:test 直测——教训:测试不可 import 带 .module.css 的组件文件);测试 `client/tests/waterfall-fold.test.ts`。

### 10.9 验收映射

PRD §11 九条 checklist 即 M3 验收;实现后按 verify-release skill 的 browser checklist 逐项截图取证,并跑 `npm test` / `npm run verify` / `npm run ci:local` 三件套(纯 client 变更,host/remotes 测试零预期变化)。

## 11. M3 测试设计

- **纯函数单测**(`client/tests/`,scripts/test.mjs 已含该目录,先例 trace-state.test.ts):
  - `range.test.ts`:splitRange / splitSessions 边界(同天、跨月、无数据、单边有数据);
  - `aggregate.test.ts`:跨天求和、占比合计 1、toolReach、环比 Δ 符号;
  - `suggest.test.ts`:八规则触发/不触发边界(阈值 ±1)、严重度排序、证据 payload、每规则上限 1 条、正面空态;
  - 夹具构造器置于 `client/tests/fixtures.ts`。
- **UI**:verify-release browser checklist(PRD §11)截图取证;合成 rollup 夹具即可驱动全部面板,无真实 LLM 依赖。
- host / remotes / vendored 零变更 → 既有测试不回退;`ci:local` 在干净副本确认 api-session-controller / ui-sidebar 类型解析无缺口(SCOPED_PACKAGES 已种子化,预期绿)。
