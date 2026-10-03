# dsh-cpa-panel — UI 层级与交互设计 + 复用清单（B3+B4）

- 调研/设计日期：2026-10-03
- 性质：**只读调研与设计，不改任何代码**。本文是「设计契约」，不是实现。
- 证据底座（均已通读，本文结论逐条可回溯）：
  - B1《DSH 官方风格与 bridge UI 贴合做法》（s_000cs1DCp1n）
  - B2《dsh-cpa-panel 现有 UI 解剖》（s_000cHCK2JBt，对象 client.js@7da7da8，1111 行）
  - A《全项目语言职责串接矩阵》（s_000cs1DCEK2，六层管道 + v0/v8 端点）
  - 《dsh-workbuddy-bridge 工程参考拆解》（s_000cHCFi6fT，commit 2b2992d）
- 代码复核新增事实（本文独家）：
  - cpa-panel `Config` 实测 **8 个全 volatile 字段**（index.js:57-72）：`adminKey`(secret)、`adminKeyRef`(credential-ref, 默认 `CPA_ADMIN_KEY`)、`port`(默认 8317)、`exePath`、`manageLifecycle`(true)、`autoCheckinOnStart`(true)、`openControlPanel`(false)、`startTimeoutSeconds`(30)。**当前 schema 里没有"模型/启用渠道"字段**。
  - 宿主路由实测 **12 条**（index.js:844-995），比 B2 多一条 **`GET /api/v1/cpa/scheduler-mode`**（index.js:919，对应上游 `PATCH /v0/management/plugins/:id/config` 的 `scheduler_mode`）。
  - 四渠道 capabilities（adapters.js:35-176）：workbuddy{checkin,tasks=true} / trae{checkin=true,tasks=false} / qoder{checkin=true,tasks=false} / zcode{checkin=false,tasks=false,unit=tokens}。
  - `cordis.patch.yml`：`id` 与 `name` **都是 `dsh-cpa-panel`**（entry id == 包名，与 bridge 的「两常量分开」不同——cpa-panel 恰好同名，无此坑，但设计上仍建议按 bridge 方式钉常量）。
  - `package.json` 的 `dsh.client.inject` **只列了** `dsh-client-ui-settings` + `dsh-client-ui-plugin-manager`，**没列 `dsh-client-ui-primitives`**——client.js 却 `require('@deepseek-ai/dsh-client-ui-primitives')`。这是当前一个潜在隐患（见 §2 路径 B 的工程项）。

---

## 0. TL;DR（压缩结论）

1. **信息架构**：两块内容不要挤在一个裸 Panel 里。建议「**简单配置页 = 宿主自动表单（schemastery/`plugins.bundle.config`）**」+「**账号面板 = 自定义区块（`plugins.detail.section`）**」，前者零前端、后者才是真 React。账号面板内部用**渠道 Pill 做一级分组 + 单页分层**（状态条→渠道→账号卡片列→（可选）排序区），不要上 SegmentedTabs 多页。
2. **两种删留形态都成立**：本文每个"复杂控件"都标 **【保留】/【可选保留·建议删除】**。最小形态（删批量按钮/拖拽/汇总条/进度条/活跃提示）与完整形态（全保留）共用同一套骨架与端点映射。
3. **交互改造是新增而非复用**：现状 client.js **无确认弹窗、无轮询、无节流、自绘 toast**（B2 §2 实锤）。本文逐项给建议，全部对照 bridge 的 useStatus 三策略 / 弹层皮肤 / 不擦屏哲学。
4. **实现路径推荐 = 路径 B（保留 client.js 单文件 JS，在现结构上补交互 + primitives + token）为主，路径 C（配置页零前端 schemastery）并行落地，路径 A（全 TS 化）仅作为「未来重写」选项**。理由见 §2：路径 B 与「client 留 JS」约束零冲突、工程量最小、能拿到 90% 官方贴合度；路径 A 的 TS 化恰恰违背该约束。
5. **复用清单（§3）**：primitives 直接补 import（`Modal`/`DisclosureRow`/`useAnchoredPosition`/`writeClipboard`…），token 照抄白名单，弹层皮肤三件套照抄，useStatus 三策略照抄，自绘 toast/拖拽/汇总条丢弃。

---

## 1. 信息架构设计

### 1.1 一级结构：两块怎么分（关键决策）

DSH 给插件的自定义 UI 落点有两个性质完全不同的槽，先把职责切干净：

| 槽 | 性质 | 适合放什么 | cpa-panel 现状（B2 §1.0） | 本文建议 |
|---|---|---|---|---|
| `settings.plugins.tab` / bridge 用的 `plugins.bundle.config`（= schemastery 自动渲染的设置区） | **宿主托管表单**。读 `Config` schema 自动出输入框/开关/密码框，自带「保存」footer，零手写 JSX | **静态部署态**：端口、exe 路径、adminKey、生命周期开关、开机补签、超时——即那 8 个 Config 字段 | cpa-panel 现状把它当**兜底入口**（order 20），但它其实是 schemastery 自动表单 | **把"简单配置页"整块归这里，交给宿主自动渲染，client.js 不再手写配置表单**（= 路径 C 的配置侧） |
| `plugins.detail.section`（order 20，cpa-panel 现用，`isMine` 守门） | **自定义 React 区块**，渲染在插件详情页里，插件完全自控 | **实时运行态**：CPA 进程是否在跑、端口、账号余额、签到按钮、启停——这些要轮询/写后回读，schema 表达不了 | 现渲染 `<Panel>` 整块（状态条+Pill+账号网格+排序区） | **保留为"账号面板"唯一落点**，只放运行态；`isMine` 守门保留 |

**结论：一级结构 = 「宿主设置表单（配置页）」与「详情页自定义区块（账号面板）」两块，天然分居两个槽，不要在同一个 Panel 里再做一级 Tab 切换"配置/账号"。**

- 理由 1：配置是**低频写一次**（装完设好端口/key 就不动），账号是**高频看余额/点签到**——读者任务节奏不同，挤一个 Panel 会让每次看余额都背着一屏表单。
- 理由 2：bridge 已经验证这个分工（《拆解》§2.2"配置即设置文档……静态部署态走 Config，实时状态走只读路由，卡片只报告不编辑"）。
- 理由 3：`plugins.bundle.config`/settings 表单**自带保存 footer 与 volatile 热写**（改配置不重挂插件，A 报告 §1.3 / 《拆解》§2.2），自己手写表单等于重造轮子。

> 关于"模型/启用渠道/检查项"三个配置诉求的归属（重要，避免接不上）：
> - **检查项**：其中"开机自动补签"=`autoCheckinOnStart`（已在 Config）✅；"每渠道自动签到"是**运行态** `checkin_auto`，走 `GET/POST /api/v1/cpa/auto-checkin?plugin=` → 上游 `PATCH /v0/management/plugins/:id/config {checkin_auto}`（adapters.js:237-252 实锤，曾经误写 `POST /checkin/config` 是 404）——**这个 Switch 放账号面板内，不放 Config**；"调度模式"走 `GET /api/v1/cpa/scheduler-mode` → 上游 config `scheduler_mode`，可做下拉。
> - **模型**：`GET /api/v1/cpa/models?plugin=`（后端 modelsOf 存在，**前端未渲染**，B2 §4.1）。它是只读目录，建议做成账号面板里某个渠道卡下的**只读模型清单（HoverCard/折叠）**，而不是 Config 里的输入项。
> - **启用渠道**：渠道集合由"CPA 实际加载了哪些 .dll"决定，`GET /api/v1/cpa/plugins` 已返回 label/unit/capabilities。当前**没有**"隐藏某渠道"的 Config 字段。若要"启用渠道"配置，需新增一个 Config 多选型（数组，volatile），或直接用 Pill 组的"空即不显示"——**建议先用 Pill 组（现状），不新增 Config 字段**，因为渠道增删本质是投放/移除 .dll，不是用户偏置。

### 1.2 账号面板内部层级（单页分层，不上多页 Tab）

`<Panel>` 自上而下（两种删留形态共用骨架）：

```
[L0] 状态条 cpa-status          ← 进程级，跨渠道常驻
[L1] 渠道 Pill 组 cpa-tabs       ← 一级分组（workbuddy/trae/qoder/zcode），key=plugin 重挂载
[L2] 当前渠道区 PluginPanel:
       ├─ (可选) 汇总条 cpa-sum        【可选保留·建议删除】
       ├─ 工具栏：刷新 / [全部签到] / [全部任务] / 自动签到 Switch
       │              【建议删除批量】【保留单账号】
       ├─ (可选) 使用中提示 cpa-active-note  【可选保留·建议删除】
       └─ 账号卡网格 cpa-grid → AccountCard × N
[L3] (可选) 排序区 RoutingSection  【可选保留·建议删除：拖拽部分】
```

- **一级分组用 Pill（现状），不上 SegmentedTabs**：Pill 是官方分段标签，4 个渠道一屏放得下；SegmentedTabs 是为"一个卡片内分 credits/models/probe 三页"设计的（B1 §2.5），用于渠道会多加一层键盘/aria 负担。
- **切换渠道 = `key={activeMeta.id}` 重挂载 PluginPanel 级联刷新**（现状 B2 §2，保留这个做法，它天然实现了"换渠道重新拉 accounts/auto-checkin"）。

### 1.3 区块控件清单 ↔ 端点映射（逐控件，两种形态都列）

> 列含义：【保留】= 两种形态都要；【删留二选一】= 最小形态删、完整形态留；【新增】= 现状没有、设计补。

#### L0 状态条（插件详情页顶部，常驻）

| 控件 | 类型 | 形态 | 数据端点（宿主 `/api/v1/cpa/*`） | 上游 CPA v0/v8 |
|---|---|---|---|---|
| 运行状态点 | `StateDot`（done 绿 / ongoing 读中 / error 红） | 【保留】 | `GET /status`（`status.running`） | CPA `GET /healthz` 探活（A 报告 §2 边②'） |
| 端口/运行文案 | 文本 `--dsw-alias-label-secondary` | 【保留】 | `GET /status`（`status.port`） | 同上 |
| 「启动」按钮 | `Button` outline sm（仅 stopped 时条件渲染） | 【保留】 | `POST /start` | 宿主半端 `ensureRunning` spawn exe（index.js:301） |
| 「无管理密钥」警告 | `Tag` tone=warning | 【保留】 | `GET /status`（`status.hasAdminKey===false`） | adminKey 解析（index.js:234） |
| 「打开 CPA 控制台」链接 | `<a target=_blank>` | 【保留】 | `GET /status`（running&&port） | 外链 `http://127.0.0.1:<port>/management.html` |

**交互**：mount 时与 `/plugins` 并发拉（现状 :887-890，保留）；`StateDot` 用 `ongoing` 表示"还没探到"而非 `idle`（B1 §2.6：还没读过≠已登出）。

#### L1 渠道 Pill 组

| 控件 | 类型 | 形态 | 端点 | 上游 |
|---|---|---|---|---|
| 渠道切换 | `Pill` 组（受控 `active`） | 【保留】 | `GET /plugins`（label/unit/capabilities） | `GET /v0/management/plugins`（已加载插件列表） |

**交互**：切换即重挂载 PluginPanel（现状）。capabilities 决定按钮显隐（workbuddy 才显示"任务"，zcode 连签到都不显示——adapters.js:40-176）。

#### L2 当前渠道区

| 控件 | 类型 | 形态 | 端点 | 上游 |
|---|---|---|---|---|
| 汇总条四格（可用/已用/额度池/单位） | 自绘 div | 【可选保留·建议删除】 | `GET /accounts?plugin=` 前端本地累加（:408-416） | `/v0/management/plugins/:id/credits` |
| 「刷新」按钮 | `Button` outline sm | 【保留】（建议改为图标按钮或并入状态条） | 触发 `load()` 重拉 accounts+auto-checkin | — |
| 「全部签到」批量 | `Button` primary sm | 【可选保留·建议删除】 | `POST /action` body `{plugin,kind:'checkin'}` | `POST /v0/management/plugins/:id/checkin`（无 auth_index） |
| 「全部任务」批量（仅 workbuddy） | `Button` outline sm | 【可选保留·建议删除】 | `POST /action` `{plugin,kind:'tasks'}` | `POST /v0/management/plugins/workbuddy/tasks/run` |
| 自动签到开关 | `Switch`（外层 `<label class=cpa-switch>`） | 【保留】 | 读 `GET /auto-checkin?plugin=`；写 `POST /auto-checkin {enabled}` | `GET /accounts` 顶层 `checkin_auto`；写 `PATCH /v0/management/plugins/:id/config {checkin_auto}` |
| 使用中提示行 | 纯文本 | 【可选保留·建议删除】 | `GET /accounts` 响应里 `active.authId/since`（宿主侧算好） | — |
| 账号卡片 `AccountCard` | 卡片（建议改用 `DisclosureRow` 壳或保留自绘卡，见 §3） | 【保留】 | `GET /accounts?plugin=` 数组 | 同上 accounts+credits |
| ├ 昵称 | 文本 primary | 【保留】 | `account.nickname` | — |
| ├ 徽标组 | `Tag`（使用中 solid/禁用 danger/耗尽 warning/已签到 success/连签 quiet） | 【保留】 | `account.disabled/exhausted/checkin.*` | — |
| ├ 可用/已用数字 | 文本，`tabular-nums` | 【保留】 | `credits.remain/used` | `/credits` |
| ├ 额度进度条 | 自绘 div | 【可选保留·建议删除】 | `credits.used/size` | — |
| ├ meta（包数/plan/未知额度） | 文本 tertiary | 【保留】（未知额度走"未知渲染 null"） | `credits.packCount/plan/remainKnown` | — |
| ├ 单账号「签到」 | `Button` outline sm | 【保留】 | `POST /action` `{plugin,kind:'checkin',authIndex}` | `POST .../checkin {auth_index}` |
| ├ 单账号「任务」 | `Button` outline sm | 【保留】（仅 capabilities.tasks） | `POST /action` `{plugin,kind:'tasks',authIndex}` | `POST .../tasks/run` |
| ├ 启用/禁用切换 | `Button`（primary/ghost） | 【保留】 | `POST /account-enabled` `{plugin,authIndex,enabled}` | `PATCH /v0/management/auth-files/status {name,disabled}`（=v8 `PATCH /v8/management/credentials/status`） |
| └ （新增）删除账号 | `Button` ghost danger + `Modal` 确认 | 【新增，CRUD 的 D】 | **需新增宿主路由** `DELETE /api/v1/cpa/account` `{plugin,authIndex}` | `DELETE /v8/management/credentials`（v0 对应 `/v0/management/auth-files` 删除） |
| └ （新增）新增/导入账号 | 文件选择（auth json）+ 确认 | 【新增，CRUD 的 C】 | **需新增宿主路由** `POST /api/v1/cpa/account/import` | `POST /v8/management/credentials`（上传 auth json）/ 插件 `POST /import` |
| 只读模型清单 | 折叠/HoverCard | 【新增·轻量】 | `GET /models?plugin=`（现状未渲染） | 插件 `models.go` 自报目录 |

> **CRUD 诚实标注**：当前 12 条宿主路由只覆盖 R（accounts）、U（account-enabled 启停 + priority 排序 + auto-checkin），**没有 C（导入账号）和 D（删账号）的宿主路由**。任务书要求"账号 CRUD"，因此设计把 C/D 标为【新增】，并显式给出上游 v8 `POST/DELETE /v8/management/credentials` 落点——**若本轮不打算加宿主路由，则 C/D 在 UI 上不出现，文案注明"账号导入请到 CPA 控制台"**（状态条已有控制台外链兜底）。

#### L3 排序区（RoutingSection）

| 控件 | 类型 | 形态 | 端点 | 上游 |
|---|---|---|---|---|
| 当前策略只读提示 | 文本（round-robin 带 ⚠️） | 【保留】（降级为只读说明） | `GET /routing` | `GET /v0/management/routing/strategy`（value: round-robin/weighted/fill-first） |
| 顺序列表 | 行列表（昵称+位次） | 【可选保留·建议删除拖拽】 | `GET /priority?plugin=` | `GET /v0/management/auth-files/fields`（priority） |
| ↑/↓ 微调按钮 | `Button` ghost sm（aria-label） | 【可选保留】（比拖拽可访问性好） | 本地顺序 state | — |
| 拖拽把手 `⠿`/拖拽卡片 | HTML5 DnD | 【建议删除】 | `POST /priority?plugin=` `{order:[昵称]}` | `PATCH /v0/management/auth-files/fields {name,priority}`（=v8 `PATCH /v8/management/credentials/fields`） |
| 「保存顺序」 | `Button` primary md + `Modal` 确认 | 【可选保留】 | 同上 POST | 同上 |

**建议**：若按删留收缩，**整块 L3 可删**（账号启停已足够控制选号；排序是进阶）。保留时**优先 ↑/↓ 微调替代拖拽**（键盘可达、无需节流、无实时 splice 重排的 bug 面）。

#### 配置页（宿主 schemastery 自动表单，client.js 不写 JSX）

| 字段 | schema 现状 | 控件（宿主自动出） |
|---|---|---|
| adminKey | `z.string().role('secret')` | 密码/凭据框 |
| adminKeyRef | `role('credential-ref')` | 凭据引用选择 |
| port | `natural 1..65535` 默认 8317 | 数字输入 |
| exePath | string | 文本/路径 |
| manageLifecycle | bool true | Switch |
| autoCheckinOnStart | bool true | Switch |
| openControlPanel | bool false | Switch |
| startTimeoutSeconds | natural 3..180 默认 30 | 数字输入 |

全部 `.volatile()`（现状已满足，index.js:50-56 注释与《拆解》§2.2 三规则一致：`.default` 在 `.volatile` 前、全 volatile 才出表单、取值在使用点 `refs.x.get() ?? 默认`）。**配置页不需要 client.js 写一行控件**——这就是路径 C 的价值。

### 1.4 交互要点逐项（对照 B2 现状给建议）

#### (a) 刷新策略：轮询 vs 事件 / 间隔

- **现状**：无轮询、无事件、无 WS；只 mount 拉一次 + 每次写动作成功后 `await load()`（B2 §2 实锤）。问题：余额/签到状态在别的客户端改了，面板不更新。
- **建议**：
  1. **写后回读保留并强化为行级**（照抄 bridge useStatus：只锁正在写的那一行 `toggling:ReadonlySet<string>`，不全卡禁用）。
  2. **加低频轮询**：`accounts/auto-checkin` 每 **15–30s** 拉一次（参考 bridge 凭据轮询 30s，《拆解》§2.1）；**窗口不可见时停轮询**（`document.visibilitychange`，省 CPU）。
  3. **读编号最新赢**：每轮请求带递增 seq，回包 `seq < latest` 就丢弃，防旧 poll 覆盖新写（bridge use-status 三策略之二）。
  4. **失败不禁轮询**（三策略之三：一次失败不停后续轮询）。
  5. 不引入 WebSocket/SSE——CPA 管理面是请求-响应，轮询足够，别过度设计。

#### (b) 确认弹窗：哪些操作需要

- **现状**：**完全没有**，启用/禁用、保存顺序、批量签到全部点击即执行（B2 §2 实锤）。
- **建议**（用 primitives `Modal`，不自绘）：
  | 操作 | 是否要确认 | 理由 |
  |---|---|---|
  | 删除账号（新增 D） | **必须** | 不可逆、丢凭据 |
  | 禁用账号 | **建议要**（二次） | 会立刻影响 DSH 选号转发 |
  | 启用账号 | 不要 | 低风险可逆 |
  | 批量签到/批量任务 | **可选** | 只读动作，失败可重试；保留形态可加"将对 N 个账号执行"一句确认 |
  | 保存顺序 | 不要（↑/↓ 是本地可逆的） | 但加 dirty 态：有未保存改动时按钮高亮 |
  | 自动签到 Switch | 不要（写后回读即可） | — |
- Modal 皮肤照抄 §3 弹层三件套。

#### (c) 防抖 / 节流：哪类输入/按钮

- **现状**：无（B2 §2 实锤）；拖拽实时 splice 重排也不节流。
- **建议**：
  1. **所有写按钮（签到/任务/启停）用行级 busy 锁**（现状已有 `busy` 布尔，保留并收敛成 `ReadonlySet<authIndex+kind>`），重复点击在飞行中即忽略——这是"防连点"，不依赖节流。
  2. **搜索/过滤框（若账号多了加）**：`setTimeout` 150–250ms 防抖（现状无输入框，暂无）。
  3. **拖拽**：建议直接删（§1.3 L3），删了就无需节流；若保留则 onDragOver 重排 **rAF 节流**。
  4. **轮询**：本身即节流，不另加。

#### (d) 错误提示：toast vs 内联（对照自绘 toast 改进）

- **现状**：自绘 `<div class=cpa-toast>`（ok 绿/err 红），硬编码 `#2ea043/#d1242f`（B2 §3 实锤）。
- **问题**：硬编码色值违背"零色值"铁律；toast 与文档流抢视觉；与宿主错误样式脱节。
- **建议**（两条都做）：
  1. **失败不擦屏、错误文案留原处**（照抄 bridge use-status 三策略之一 + B1 §2.6）：写动作失败时，在**那一行卡片**下用 `.error`（12px、`--dsw-alias-label-tertiary` 几何、只把颜色换成 `--dsw-alias-state-error-primary`）显示原因，不清空已有余额读数。
  2. **全局成功反馈**用 primitives 体系：优先 `writeClipboard()`+`role="status"`（bridge 做法）；若确实需要 toast，**改用 primitives 提供的 Toast/通知**（若该版本 primitives 没有，则保留一个 toast 容器但颜色全走 `--dsw-alias-state-error-primary` / `--dsw-alias-state-business-primary`，删除 `#2ea043/#d1242f` 字面量）。**绝不**用不存在的 `--dsw-alias-label-error`（B1 §1.4 坑 token）。

#### (e) 加载态 / 空态（对照 useStatus 三策略 + "未知渲染 null"）

- **现状**：三态机 `phase: loading/ready/error` + 每卡 busy（B2 §1.1 空态行）。
- **建议**（照抄 bridge 哲学）：
  1. **Loading**：`StateDot state='ongoing'`，按钮文案变"刷新中…"，**不转圈不脉冲**（28px 下 spinner 像 glitch，B1 §2.6）；`aria-busy`。
  2. **空态/未知**：观测不到就**渲染 `null`**，绝不摆假 `0`/假 `—`（"a fabricated zero is worse than a blank"）。落地到本面板：
     - `credits.remainKnown===false` → 可用额度位置**不显示**（不画 `—`），meta 行注明"额度未知"；
     - 某账号没有 checkin 信息 → 不渲染"未签到"徽标，而不是摆一个假徽标；
     - `active` 没算出来 → 不渲染活跃提示行。
  3. **错误态**：读失败**不擦屏**——保留上一次成功的账号列表，顶部挂一条错误条；而不是整屏 error（现状 B2 :582-587 是整屏 error，建议改为"保留数据 + 顶部错误条"）。

#### (f) 键盘 / 无障碍 / token / 图标规则

- **Focus ring**（照抄）：`outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset:1px`，不手写 2px 品牌描边。
- **行级语义**：进度条 `role="progressbar"`，未知总量省略 range 只给 `aria-valuetext`；状态行 `role="status"`。
- **↑/↓ 微调按钮**带 `aria-label`（现状已有，保留）。
- **数字列**：`font-variant-numeric: tabular-nums`（余额数字不跳动）。
- **token 白名单**（照抄 B1 §2.3 全表，禁止硬编码）：文字四档 `--dsw-alias-label-primary/secondary/tertiary/dimmed`；边框 `border-l1/l2/l3`；错误 `state-error-primary`；品牌 `brand-primary`；浮起面 `bg-module-platform`/`bg-layer-3`；hover `interactive-bg-hover`；focus 兜底 `state-business-primary`；圆角 `radius-sm/md/lg`；超椭圆 opt-out 用 `border-radius:999px; corner-shape:round`。
- **两个坑 token 禁用**：`--dsw-alias-label-error`（未定义）、`label-quaternary`/`bg-layer-4`（不存在）；禁用态用 `label-dimmed`，**不用 opacity**。
- **中性边框 0.5px、状态色 1px**；line-height 只用 1.5/1.6；不写字体族。
- **图标 `ic_ds_*` 规则**：优先用宿主 188 个图标里有的；没有的（钥匙/网关/账号）按官方栅格自绘：`viewBox="0 0 16 16"`、16px、`currentColor`（fill 或 stroke）、线宽 1、**不写任何色值、不写 `[data-ds-dark-theme]` 分支**。现状 client.js 全用文本字符 `⠿ ↑ ↓ ✓ ✗`（B2 §3）——若删拖拽则 `⠿` 消失；建议把 `✓/✗` 结果反馈交给 `role="status"` 文本，不画 glyph。

---

## 2. 两条实现路径对比与推荐（+ 路径 C）

### 2.1 路径 A = 复用 bridge 浏览器半端打包产物形态（TS 化）

把 client 半端也改成 TS：tsdown 双配置（宿主 ESM / 浏览器 CJS）、双 tsconfig、`banner/intro/footer` 复现 `window.__ModuleLoader__.load({id, factory:(require)=>{…}})`、React+primitives、CSS Modules（lightningcss 哈希类名 + 虚拟 style 注入）。

### 2.2 路径 B = 保留现有 client.js（JS 单文件）在现结构上改造

client.js 仍是手写 `__ModuleLoader__` shim 的 JS（现状已是这个形态，B2 开头实锤），**不引入构建步骤**；改造点 = primitives import 补全（加 `Modal`/`DisclosureRow`/`writeClipboard`…）+ CSS token 去硬编码 + 补交互（轮询/确认/错误条/空态哲学）。

### 2.3 路径 C = 零前端配置页（schemastery 自动渲染）

配置侧完全交给宿主 `plugins.bundle.config` 自动表单；账号面板侧可保留 client.js（轻量形态）。若连账号面板也不要自定义，则 client.js 可删、全 TS 化（但账号 CRUD/余额可视化需求与"删 client.js"冲突，故 C 只解决配置侧）。

### 2.4 对比矩阵

| 维度 | 路径 A（TS 全量复用 bridge 打包） | 路径 B（client.js 留 JS 改造） | 路径 C（配置零前端） |
|---|---|---|---|
| 贴合官方风格程度 | **最高**（CSS Modules+token+primitives 全套，与 bridge 同构） | 高（primitives+token 全可拿到，仅少 CSS Modules 的哈希隔离，用一个 `<style data-plugin-css>` 命名空间隔离即可） | 配置页=100% 官方（宿主画）；账号面板不涉及 |
| 工程量 | **大**：要引入 tsdown/双 tsconfig/双 vitest/eslint、把 1111 行 JS 翻译成 TSX、配 neverBundle（漏一个 react-dom 就 80KB→1MB，《拆解》§5.2 事故） | **小**：在现 1111 行上增删，无工具链 | 极小（配置侧零代码） |
| 可维护性 | **高**（类型、typecheck、测试；但对单人小插件是杀鸡用牛刀） | 中（无类型，但现结构清晰、注释好；JS 单文件即读即改） | 配置侧=最高（schema 即文档） |
| 与「client 留 JS」约束兼容性 | **冲突**：TS 化 = client 半端不再是 JS 单文件，违背约束（任务书要求明示） | **完全兼容**（client.js 仍是 JS 单文件） | 配置侧无 client；账号侧若留 JS 仍兼容 |
| 风险 | 高（工具链/产物包装/neverBundle 哨兵） | 低（现状已在跑，增量改） | 低 |

### 2.5 明确推荐组合

> **推荐 = B（账号面板留 client.js 改造） + C（配置页交给 schemastery 自动表单）并行落地；路径 A 仅作为"未来若插件规模翻倍、要加测试/类型"时的重写选项，本轮不做。**

理由：
1. **约束兼容**：任务书明确「client 留 JS」，路径 A 直接违背；路径 B/C 零冲突。
2. **性价比**：官方贴合度的 90% 来自「primitives + `--dsw-*` token + useStatus 哲学 + 空态 null」，这些在纯 JS client.js 里**全部能用**（client.js 现在就已经 `require('@deepseek-ai/dsh-client-ui-primitives')` 解构了 5 个组件，B2 开头实锤）；剩下 10% 的 CSS Modules 哈希隔离，用现有的 `<style data-plugin-css="dsh-cpa-panel">` 命名空间注入（B2 §3，已幂等去重）即可等价解决，不必为此上 tsdown。
3. **路径 A 的唯一硬收益是类型与测试**，对一个单面板、单人维护的插件，收益不抵引入双工具链的成本。
4. **路径 C 白捡**：那 8 个 Config 字段已经全 volatile，宿主自动渲染表单已经成立——只需在注册时把"简单配置页"指向 `plugins.bundle.config`/settings 槽，client.js 不再手写配置表单。

**落地前必补的一个工程项（无论 B/C）**：`package.json` 的 `dsh.client.inject` 目前只列了 settings + plugin-manager，**没列 `dsh-client-ui-primitives`**，而 client.js 却 require 它——需补进 `dsh.client.inject`（照 bridge 的 9 个 dsh-client-ui-* 列法），否则换 primitives 新组件后加载器可能不报或注入不全。

---

## 3. 复用清单（B4）

### 3.1 从 bridge UI 直接搬（照抄，标注来源文件）

| 复用项 | 来源（bridge 仓内相对路径） | 在 cpa-panel 的用法 |
|---|---|---|
| **primitives import 清单**：`Button, Switch, Tag, Pill, StateDot`（现已有）+ 新增 `Modal`（确认弹窗）、`DisclosureRow`（账号卡壳可选）、`Checkbox`（导入账号多选）、`Tooltip`、`writeClipboard`（复制/成功反馈）、`useAnchoredPosition` + `useDismissOnOutsidePointer`（弹层定位/关闭） | `src/client/panels.tsx:10`、`WorkBuddyCard.tsx:13-19`、`probe-control.tsx:51-56`；包=`@deepseek-ai/dsh-client-ui-primitives` | 补 Modal 做删除/禁用确认；补 writeClipboard 做签到结果复制与成功宣布 |
| **slot 类型** `InjectFace/PropsLocale/PropsRuntime` | `WorkBuddyConfigPage.tsx:22`，包 `dsh-client-ui-slots` | 路径 B 下 client.js 不强需类型，可不引；若将来 TS 化再用 |
| **CSS token 白名单全表** | `src/client/workbuddy.module.css:1-21`（总纲：零字体族/零色值/line-height 1.5-1.6）+ grep 自四个 module.css | 替换 client.js CSS 里的 `#2ea043/#d1242f` 硬编码；中性边框 0.5px、数字列 tabular-nums |
| **弹层皮肤三件套**：`--dsw-specific-menu` + `--dsw-menu-backdrop-filter` 成对写 `::before`、`isolation:isolate`、`--dsw-elevation-prominent`，配 `useAnchoredPosition`+`useDismissOnOutsidePointer`+`createPortal(...,document.body)`、`z-index:1100` | `src/client/probe-control.module.css:82-111`、`probe-control.tsx:472-548` | Modal/下拉/确认框的浮起面皮肤 |
| **Focus ring 一行式** | `probe-control.module.css:60-64` | 所有可聚焦控件，不手写品牌描边 |
| **StateDot/useStatus 交互模式（三策略）**：失败不擦屏 / 读编号最新赢 / 失败不禁轮询 / 写后回读 / 行级锁 `ReadonlySet<string>` | `src/client/use-status.ts:1-22`、`WorkBuddyCard.tsx:39-43` | 落地 §1.4(a)(b)(e)；把整屏 error 改成"保留数据+顶部错误条" |
| **空态哲学**：观测不到渲染 null，不摆假 0/假 —；unlimited 不画满条 | `credit-balance.tsx:23-27`、`credit-label.tsx:17-23` | 落地"未知额度不显示、无 checkin 信息不摆假徽标" |
| **DisclosureRow + SegmentedTabs 壳（需改造）**：`DisclosureRow expandable expandOnRowClick` + `icon=<StateDot>` + `collapsedContent` 状态行 | `WorkBuddyCard.tsx:129-148, 95-117` | 可选：把账号卡换成 DisclosureRow 壳（继承宿主 chrome/键盘/主题）；SegmentedTabs **不用于渠道**（渠道用 Pill），仅当某渠道卡内要分"余额/模型/签到记录"多页时才用 |
| **图标自绘规则**：16×16 viewBox、16px、`currentColor`、线宽 1、不写主题分支；同 glyph 并排要同线宽"读起来像一套" | `probe-control.tsx:554-598`（灯泡）、`credit-balance.tsx:191-214`（硬币） | 若需"钥匙/网关/账号"图标（宿主 188 个 ic_ds_* 里没有），按此规则新画；灯泡/硬币 path 不抄 |
| **whileServed 两常量红线**：`ENTRY_ID`（=patch insert id=configForms 命名空间）与 `BUNDLE_NAME`（=pkg.name=slots key）分开钉死 | `src/client/index.tsx:45-79`、《拆解》§2.4 | cpa-panel 当前 id==name 都是 `dsh-cpa-panel`（cordis.patch.yml），无此坑；但配置页若改走 `plugins.bundle.config`，需照此钉 key |
| **设置页骨架**：`whileServed([ENTRY_ID])` → `slots.register({name:'plugins.bundle.config', key:BUNDLE_NAME, locale:NS}, Page)`；SettingsFormModel staged 表单一次 revision 保存 | `WorkBuddyConfigPage.tsx:44-127`、`config-controller.ts:12-20` | 路径 C 配置侧：把 8 个 Config 字段交给宿主自动表单即可，不必手写 staged 表单（schemastery 自动渲染已含保存） |

### 3.2 从 cpa-panel 现有 UI 留什么

| 保留项 | 来源（client.js 行号） | 用法 |
|---|---|---|
| primitives 五件套解构（Button/Switch/Tag/Pill/StateDot） | client.js:35-39 | 继续用，缺哪个补哪个（Modal/Checkbox/Tooltip/writeClipboard） |
| CSS token 用法（已用 `--dsw-alias-label-tertiary/border-l2/bg-base` 等） | client.js:981,986,997,1014 等 | 保留 token 部分，**删掉 `#2ea043/#d1242f` 硬编码**，换 `state-error-primary`/`brand-primary` |
| 状态条范式（StateDot+端口+条件启动按钮+无密钥警告 Tag+控制台外链） | client.js:913-934 | 原样保留，是运行态展示的最佳载体 |
| Switch 范式（外层 `<label class=cpa-switch>` + 可见文字 label） | client.js:522-533 | 自动签到开关照留；配置页开关交给宿主 |
| 路由/渠道 Pill + `key={activeMeta.id}` 重挂载级联刷新 | client.js:941-946, :434-436 | 保留，天然实现换渠道重拉 |
| `api(path)` 薄封装（fetch credentials:include，异常吞成 `{ok:false}`） | client.js:177-189 | 保留；在此之上加读编号 seq |
| `<style data-plugin-css="dsh-cpa-panel">` 幂等注入 | client.js:1045-1053 | 作为 CSS Modules 哈希隔离的平替（路径 B 不引入 tsdown） |
| 行级 busy 锁（每卡 `busy`） | client.js:227,:392 | 收敛成 `ReadonlySet<authIndex+kind>` 行级锁，不全卡禁用 |

### 3.3 丢什么（按删留收缩；标【建议删除】的可整组丢弃）

| 丢弃项 | 来源（client.js 行号） | 理由 |
|---|---|---|
| 拖拽排序（HTML5 DnD、onDragOver 实时 splice、`⠿` 把手） | buildCard:697-741, :770 | 无键盘可达、需节流、bug 面大；要排序用 ↑/↓ 微调替代 |
| 汇总条 cpa-sum 四格 | PluginPanel:477-493, 累加 :408-416 | 账号卡已有余额数字，汇总条是冗余概览；收缩形态删 |
| 额度进度条 cpa-bar/cpa-fill | :372-375, percent :232-235 | 自绘 div 进度条；若保留改用 bridge `role=progressbar` 写法，否则删（数字已够） |
| 批量按钮（全部签到/全部任务） | :503-514, runAll:438-451 | 运营向、误触风险；收缩形态删，保留单账号签到 |
| 使用中提示行 cpa-active-note | :543-555 | 只读信息、视觉噪音；收缩形态删（或并入某账号徽标） |
| 自绘 toast 硬编码色 | :588-593, CSS 色值 :1009-1010 | 换成"行内错误条 + role=status"，删 `#2ea043/#d1242f` |
| 整屏 error 态 | :582-587 | 换成"保留上次数据 + 顶部错误条"（useStatus 哲学） |

> **两种形态一句话**：【保留形态】= §1.3 全部控件 + 上述"丢什么"里只删硬编码 toast 色与整屏 error；【收缩形态】= 再额外删掉拖拽/汇总条/进度条/批量按钮/活跃提示五组，面板只剩「状态条 + 渠道 Pill + 账号卡（余额数字 + 单账号签到/任务/启停）+ 自动签到 Switch」——这是建议的默认形态。

---

## 附：本文与验收要点的对照

1. **可落地**：§1.3 每个控件都标了宿主 `/api/v1/cpa/*` 路由 + 上游 v0/v8 端点；CRUD 的 C/D 诚实标注为"需新增宿主路由"，不画接不上的饼。
2. **两路径对比 + 推荐**：§2.4 五维矩阵（贴合度/工程量/可维护性/约束兼容/风险），§2.5 明确推荐 B+C、A 仅作未来选项，并显式标注路径 A 与「client 留 JS」约束冲突。
3. **对照现状逐项给建议**：§1.4 逐条对照 B2 的无确认弹窗/无轮询/无节流/自绘 toast/整屏 error/未知摆假值。
4. **复用清单标来源**：§3 每项带 bridge 源文件行号 或 cpa-panel client.js 行号 + 用法。
5. 中文报告。
