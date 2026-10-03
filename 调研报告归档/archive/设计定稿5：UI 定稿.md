# 设计定稿 5：UI 定稿

- 日期：2026-10-03 ｜ 性质：只读设计，不改代码
- 底座：B3B4《UI 层级与交互设计+复用清单》、B1《DSH 官方风格与 bridge UI 贴合做法》、B2《现有 UI 解剖》、第二轮《简单配置页设计与集成契约》、第一轮《解剖》
- **已定前提（不再讨论）**：实现路径 = **B（client.js 保留单文件 JS 改造）+ C（配置页由宿主 schemastery 自动渲染，零手写 JSX）**；路径 A（client TS 化）已否；Windows only。
- **两个业务分支，UI 都给，差异显式标注**：
  - **分支 A（养号版）**：保留签到/任务；配置页加 `autoCheckin`/`autoTasks` 开关（**默认关**）；面板保留签到/任务操作。
  - **分支 B（纯反代版）**：无养号调度；面板只留账号/余额/启停；不碰 checkin/tasks/scheduler-mode 端点。

---

## 1) Tab / 页签结构定稿

**一级只有两个落点，分居两个槽，不再做"配置/账号"一级 Tab 切换**（理由：配置低频写一次、账号高频看运行态，节奏不同——B3B4 §1.1）。

### 1.1 落点一：宿主设置槽（`settings.plugins.tab` / `plugins.bundle.config`）——简单配置页

**渲染方式：宿主 schemastery 自动表单（路径 C），client.js 不写一行 JSX**。全部字段走 `Config` schema（index.js:57-72 现有 8 字段基础上新增），全 `.volatile()`，宿主自带保存 footer。

| 区块 | 字段 | 控件类型（宿主自动出） | 默认 | 数据/端点映射 | 分支差异 |
|---|---|---|---|---|---|
| **连接** | `adminKey` | password（`.role('secret')`） | `''` | 不打端点；所有上游 `Bearer` 来源 | A/B 同 |
| | `adminKeyRef` | credential-ref 选择 | `CPA_ADMIN_KEY` | `ctx.credentials.resolve` | A/B 同 |
| | `port` | number 1–65535 | `8317` | baseURL `http://127.0.0.1:<port>` | A/B 同 |
| | `exePath` | 文本/路径 | `''` | spawn 目标；空则按 `defaultExeCandidates()` 探测 | A/B 同 |
| **生命周期** | `manageLifecycle` | Switch | `true` | spawn/kill CPA | A/B 同 |
| | `startTimeoutSeconds` | number 3–180 | `30` | `waitForPort` | A/B 同 |
| | `openControlPanel` | Switch | `false` | 是否加 `-no-browser` | A/B 同 |
| **启用渠道（new-api 风格简化版）** | `channels[]` | 结构化行（见下） | 四渠道全启用 | 见 §1.1.1 | A/B 同 |
| **检查项勾选** | `autoCheckinOnStart` | Switch | `true` | 开机补签 → `POST /v0/management/plugins/:id/checkin` | A/B 同（B 视为"反代自恢复"的一部分） |
| | `autoCheckin` | Switch | **false** | 每渠道 `checkin_auto` → 读 `GET /accounts` 顶层 / 写 `PATCH /v0/management/plugins/:id/config{checkin_auto}` | **仅 A** |
| | `autoTasks` | Switch | **false** | 定时跑 `POST /workbuddy/tasks/run`（需新增宿主定时器） | **仅 A** |
| | `normalizeSchedulerMode` | Switch（或按钮） | `false` | 一键把各渠道 `scheduler_mode` 置 `off` → `PATCH /v0/management/plugins/:id/config{scheduler_mode:'off'}`（改完需重启 CPA） | **仅 A**（B 无 priority 调度诉求） |

#### 1.1.1 「启用渠道」字段的诚实映射（new-api 字段 → 本插件现实端点）

new-api 渠道对象字段做**简化裁剪**。逐条标注哪些有端点、哪些没有：

| new-api 字段（简化保留？） | 现实映射 | 结论 |
|---|---|---|
| 类型（workbuddy/trae/qoder/zcode） | 由 CPA 实际加载的 `.dll` 决定，`GET /v0/management/plugins` 返回 | **只读展示**，不让用户填 |
| **可见性（本插件新增的简化字段）** | 纯插件本地配置：决定详情 Pill 组里显示哪个渠道，**不打 CPA** | ✅ 可做（B3B4 §1.1 建议先用 Pill 空即不显示） |
| Priority（优先级） | `PATCH /v0/management/auth-files/fields {name,priority}`（=v8 `PATCH /v8/management/credentials/fields`） | ✅ 已有（原拖拽排序后端） |
| AutoDisable（禁用） | `PATCH /v0/management/auth-files/status {name,disabled}`（=v8 `PATCH /v8/management/credentials/status`） | ✅ 已有 |
| Models（模型清单） | `GET /v0/management/plugins/:id/models/groups?refresh=1` | ✅ **只读**展示 |
| BaseURL / Keys[] / Weight / ModelMapping | 属 CPA 全局 `/v0/management/config` 的 `openai-compatibility[]`（name/base-url/api-key-entries/models.alias） | ⚠️ **超出"简单配置页"**：涉及凭证数组与上游映射，建议**不进表单**，外链 CPA 控制台兜底 |

> 定稿：渠道行只做五列——`类型(只读 Tag) / 可见性(本地 Switch) / Priority(数字或 ↑↓) / AutoDisable(Switch) / Models(只读折叠)`。BaseURL/Keys/Weight/ModelMapping **不进 UI**，文案注明"请到 CPA 控制台"。

### 1.2 落点二：插件详情槽（`plugins.detail.section`，order 20，`isMine` 守门保留）——账号面板

**自定义 React 区块（client.js 改造，路径 B）**。自上而下单页分层（不上多页 Tab）：

```
[L0] 状态条（进程级，跨渠道常驻）
[L1] 渠道 Pill 组（workbuddy/trae/qoder/zcode，key=plugin 重挂载）
[L2] 当前渠道区：工具栏 + 账号卡网格
[L3] （可选）排序区 —— 分支 A 保留 ↑↓ 微调；分支 B 整块删
```

#### L0 状态条控件清单

| 控件 | primitives 类型 | 状态/交互 | 数据端点 |
|---|---|---|---|
| 进程状态点 | `StateDot`（done=运行 / ongoing=启动中 / error=停止或崩溃） | mount 拉 + 轮询 | `GET /api/v1/cpa/status` |
| 状态文案 | 文本（`label-secondary`） | 四态：运行中 / 已停止 / **启动中** / **崩溃（退出码）** | `/status`（需宿主扩展返回 `starting`/`crashExitCode`——现状只返回 boolean running，见 §5） |
| 端口 | 文本 `127.0.0.1:<port>` | — | `/status.port` |
| 「启动」按钮 | `Button` outline sm（仅停止时渲染） | busy 锁；成功后回读 | `POST /api/v1/cpa/start` |
| 「无管理密钥」警告 | `Tag` tone=warning | `hasAdminKey===false` 时 | `/status` |
| 「打开 CPA 控制台」外链 | `<a target=_blank>` | running 才渲染 | `/management.html` |

#### L1 渠道 Pill 组

| 控件 | 类型 | 状态/交互 | 端点 |
|---|---|---|---|
| 渠道切换 | `Pill` 组（受控 active） | 切换即 `key={active}`` 重挂载级联刷新；每 Pill 角标显示账号数（健康概览） | `GET /api/v1/cpa/plugins`（label/unit/capabilities） |
| 渠道健康角标 | `Tag` 或 Pill 后缀 | 每渠道账号数 / 全禁用灰显 | `GET /api/v1/cpa/accounts?plugin=`（懒加载当前渠道） |

#### L2 当前渠道区

| 控件 | primitives 类型 | 状态/交互 | 端点 | 分支差异 |
|---|---|---|---|---|
| 「刷新」 | `Button` outline sm（或图标按钮） | busy 锁、文案变"刷新中…" | 重拉 accounts+auto-checkin | A/B |
| 自动签到 Switch | `Switch` + 可见文字 label | 写后回读 | `GET/POST /api/v1/cpa/auto-checkin?plugin=` | **仅 A**（B 不渲染） |
| 「全部签到」批量 | `Button` primary sm + **Modal 确认** | 行级 busy | `POST /api/v1/cpa/action {plugin,kind:'checkin'}` | **仅 A**（建议默认删，见 §4） |
| 「全部任务」批量 | `Button` outline sm + Modal 确认 | 同上 | `POST /action {kind:'tasks'}` | **仅 A**（仅 workbuddy） |
| 账号卡 `AccountCard` | 建议壳换 `DisclosureRow`（继承宿主 chrome/键盘/主题） | — | `GET /accounts?plugin=` | A/B |
| ├ 昵称 | 文本 primary | — | `account.nickname` | A/B |
| ├ 徽标组 | `Tag`（禁用 danger/耗尽 warning/签到 success·未签 outline/连签 quiet） | **未知渲染 null**（无 checkin 信息不摆假徽标） | `account.*` | 签到徽标**仅 A** |
| ├ 可用/已用数字 | 文本 `tabular-nums` | 未知额度不画 `—`，写"额度未知" | `credits.remain/used` | A/B（B 只看这个） |
| ├ meta（包数/plan） | 文本 tertiary | — | `credits.*` | A/B |
| ├ 单账号签到 | `Button` outline sm | 行级 busy | `POST /action {kind:'checkin',authIndex}` | **仅 A** |
| ├ 单账号任务 | `Button` outline sm | 同上 | `POST /action {kind:'tasks',authIndex}` | **仅 A**（仅 workbuddy） |
| ├ 启用/禁用 | `Button`（primary/ghost）+ **Modal 二次确认** | 写后回读 | `POST /api/v1/cpa/account-enabled` | A/B |
| ├ （可选）删除账号 | `Button` ghost danger + **Modal 强确认** | 见 §5 两方案 | 需新增宿主路由 | A/B（可选） |
| └ （可选）导入账号 | 文件选择 + Modal | 见 §5 | 需新增宿主路由 | A/B（可选） |
| 只读模型清单 | 折叠/HoverCard | 展开拉一次 | `GET /api/v1/cpa/models?plugin=`（现状未渲染） | A/B（轻量） |

#### L3 排序区（可选）

- **分支 A**：保留，**用 ↑/↓ 微调按钮替代拖拽**（键盘可达、无需节流），`GET/POST /api/v1/cpa/priority?plugin=`，保存按钮加 dirty 高亮。
- **分支 B**：整块删除（纯反代无 priority 诉求）。

---

## 2) 状态卡定稿（显示项 + 数据来源 + 刷新策略）

### 2.1 状态条显示项

| 显示项 | 数据来源 | 备注 |
|---|---|---|
| CPA 进程状态（运行/停止/启动中/崩溃） | `/status.running` + **宿主需扩展** `starting`（life.starting）与 `crashExitCode`（child 退出码） | 现状 `/status` 只有 boolean running，**"启动中/崩溃"两态要宿主加字段**（§5） |
| 端口 | `/status.port` | — |
| 管理密钥就绪 | `/status.hasAdminKey` + `adminKeySource` | 缺失即 warning Tag |
| 插件就绪 | `GET /api/v1/cpa/plugins` 返回的 label/capabilities | 等价"CPA 已加载哪些渠道 dll" |
| 渠道健康（每渠道账号数与可用性） | 渠道 Pill 角标；当前渠道来自 `/accounts` | 全禁用渠道 Pill 灰显 |
| 余额概览 | 当前渠道账号卡数字（**不做跨渠道汇总条**——token 与积分单位不同，B2/B3B4 均建议删汇总条） | 分支 A 额外显示签到状态徽标 |

### 2.2 刷新策略（对照 B3B4 §1.4(a)，定稿）

1. **写后回读**：所有写动作成功后只重拉受影响资源（行级，不全屏重载）。
2. **低频轮询**：`accounts` / `auto-checkin` 每 **20s**（取 15–30s 中位）；`/status` 每 30s。
3. **可见性暂停**：`document.visibilityState==='hidden'` 时停轮询，visible 时立即补拉一次。
4. **读编号最新赢**：每轮请求带递增 seq，回包 `seq < latestSeq` 丢弃，防旧 poll 覆盖新写。
5. **失败不禁轮询**：单轮失败不停止后续轮询；连续失败 N 次才在状态条挂错误条。
6. **不引入 WS/SSE**（CPA 管理面是请求-响应，轮询足够）。

---

## 3) 交互要点定稿

| 项 | 定稿 | 证据/来源 |
|---|---|---|
| **确认弹窗** | 用 primitives `Modal`（不自绘）。**必须确认**：删除账号（不可逆）、禁用账号（立刻影响选号转发）；**二次确认**：批量签到/任务（"将对 N 个账号执行"一句）；**不确认**：启用账号、保存顺序、Switch 切换 | B3B4 §1.4(b)；现状无任何弹窗（B2 §2） |
| Modal 皮肤 | portal→`document.body` + `useAnchoredPosition` + `useDismissOnOutsidePointer`；浮起面 `--dsw-specific-menu`+`--dsw-menu-backdrop-filter` 成对写 `::before`、`isolation:isolate`、`--dsw-elevation-prominent`、`z-index:1100` | B1 §2.5/§3.1 |
| **错误提示** | **不擦屏**：读失败保留上一次成功数据，顶部/行内挂错误条；行内错误 12px、`--dsw-alias-label-tertiary` 几何、仅颜色换 `--dsw-alias-state-error-primary`；状态行 `role="status"`；**删掉自绘 toast 硬编码 `#2ea043/#d1242f`** | B1 §2.6；B2 §3 |
| **空态/加载态** | Loading=`StateDot ongoing` + `aria-busy` + 按钮文案"刷新中…"，**不转圈不脉冲**；空/未知**渲染 null**，不摆假 0/假 `—`（`remainKnown===false` 不画额度、无 checkin 信息不摆假徽标） | B1 §2.6 useStatus 三策略 |
| **防抖/节流** | 写按钮用**行级 busy 锁**（`ReadonlySet<authIndex+kind>`，不全卡禁用）；无搜索框故无防抖；**拖拽删→无需节流**；轮询本身即节流 | B3B4 §1.4(c) |
| **无障碍** | 全控件键盘可达；focus ring `outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset:1px`；↑↓ 按钮 `aria-label`；数字列 `tabular-nums`；进度条 `role="progressbar"` | B1 §2.3/§3.1 |
| **图标** | 优先宿主 `ic_ds_*`（188 个）；缺的按 16×16 viewBox、`currentColor`、线宽 1、不写色值/不写主题分支自绘；删除文本 glyph `⠿`（拖拽删后）、`✓/✗` 改由 `role="status"` 文本反馈 | B1 §2.4；B2 §3 |

---

## 4) 分支 A / B 差异表（逐行）

| 维度 | 分支 A（养号版） | 分支 B（纯反代版） |
|---|---|---|
| **配置页字段** | 在基础 8 字段上 **+ `autoCheckin`(默认关) + `autoTasks`(默认关) + `normalizeSchedulerMode`** | 只保留基础 8 字段 + 渠道可见性；无 autoCheckin/autoTasks/scheduler 字段 |
| **面板控件** | 状态条 + Pill + 账号卡（余额 + 签到徽标）+ 单账号签到/任务 + 批量签到/任务(可选 Modal) + 自动签到 Switch + L3 ↑↓ 排序区 | 状态条 + Pill + 账号卡（仅余额数字 + 启用/禁用）；**无签到/任务/Switch/排序区** |
| **端点使用** | 额外用：`POST .../checkin`、`POST .../tasks/run`、`GET/POST /auto-checkin`、`PATCH .../config{checkin_auto,scheduler_mode}`、`GET/POST /routing`、`GET/POST /priority` | **只用**：`GET /status`、`GET /plugins`、`GET /accounts`(+`/credits`)、`POST /start`、`POST /account-enabled`、`GET /models`(只读) |
| **scheduler-mode 路由** | 用（一键归一 scheduler_mode=off） | 不用（从 12 条里删 `/api/v1/cpa/scheduler-mode`） |
| **余额概览** | 含签到状态徽标 | 纯余额，无徽标 |
| **开机补签** | `autoCheckinOnStart` 生效 | 同（视为反代自恢复，可保留） |

---

## 5) 工程修正项（两方案并列）

### 5.1 `package.json` 必补

`dsh.client.inject` 当前只列 `dsh-client-ui-settings` + `dsh-client-ui-plugin-manager`，**漏了 `dsh-client-ui-primitives`**，而 client.js:34 却 `require('@deepseek-ai/dsh-client-ui-primitives')`。→ **必须补进 inject 清单**（照 bridge 的 dsh-client-ui-* 列法），否则新增 Modal/Checkbox/writeClipboard 后注入不全。

### 5.2 账号 CRUD（导入/删除）——两方案

现状 12 条宿主路由**只有 R/U，没有 C/D**。

| 方案 | 做法 | 代价 |
|---|---|---|
| **方案一（推荐，本轮）** | **UI 不出"导入/删除账号"两控件**；状态条已有 CPA 控制台外链兜底，文案注明"账号导入/删除请到 CPA 控制台" | 零新后端路由；诚实可用 |
| **方案二（若产品坚持面板内 CRUD）** | **需新增宿主路由**：`POST /api/v1/cpa/account/import`（包装 `POST /v8/management/credentials`，即 v0 侧 auth 文件导入/`POST /plugins/:id/import`）、`DELETE /api/v1/cpa/account` `{plugin,authIndex}`（包装 `DELETE /v8/management/credentials`）；UI 配 Modal 确认 + 文件选择 | 新增 2 条宿主路由 + 前端 CRUD 控件；管理密钥仍留宿主半边 |

> 路径版本说明：任务书按 v8（`/v8/management/credentials`）表述；本插件现有实测调用均在 `/v0/management/...`（auth-files 系列）。落地时以实际 CPA 版本的管理面为准，路由包装层做版本归一。

### 5.3 状态条两态需宿主扩展

`/api/v1/cpa/status` 现只返回 boolean `running`。要支持"启动中/崩溃"两态，宿主需补返回：`starting`（=life.starting）与 `crashExitCode`（子进程退出码），前端 StateDot 才能三/四态显示。

---

## 附：一句话定稿

配置页 = 宿主 schemastery 自动表单（连接/生命周期/渠道五列简化/检查项勾选，零 JSX）；账号面板 = client.js 单文件改造（状态条→Pill→DisclosureRow 账号卡→可选 ↑↓ 排序），primitives+`--dsw-*` token 贴合官方；交互按 useStatus 三策略（不擦屏/最新赢/行级锁）+ Modal 确认 + 空态 null；分支 A 多养号控件与 checkin/tasks/scheduler 端点，分支 B 纯反代只留余额与启停。
