# UI 定稿修正：养号主版与单元列表

- 日期：2026-10-03 ｜ 性质：只读设计追加，不改代码
- 底座：《设计定稿5：UI 定稿》及 B1/B2/B3B4、前几轮解剖与契约
- **方向修正（取代上一版的分支并立）**：
  1. **主功能 = 养号自动化**——上一版「分支 A（养号版）」即主线；**「分支 B（纯反代版）」全文作废**，本报告 §4 集中标注。
  2. **新增「独立调用单元」模式**：`渠道 × 账号 × 模型 = 一个单元`；每单元独立可调用、**绝对锁定单账号、不混用**。
  3. **CPA 内置 UI 全删**（不再引导用户去 `management.html`），唯一 UI = DSH 插件的配置页 / 状态页。

---

## 1) 配置页主结构 = 「单元列表」

### 1.1 单元是什么

一个单元是一条**可独立调用的配置+运行记录**：

```
单元 = { channel, authRef, model, enabled, reasoningEffortDefault }
```

| 字段 | 含义 | 示例 |
|---|---|---|
| `channel` | 渠道 id（workbuddy/trae/qoder/zcode，由已加载 .dll 决定） | `workbuddy` |
| `authRef` | 账号引用 = auth 文件 id / label（与 `/accounts[].auth_id`、`/auth-files[].name` 逐字对应，见 adapters.js:296-302） | `workbuddy-<uid>` |
| `model` | 该单元锁定调用的模型（从 `/models/groups` 目录选） | `some-model` |
| `enabled` | 单元总开关（= 该账号是否参与，底层写 `auth-files/status{disabled}`） | `true` |
| `reasoningEffortDefault` | 该单元默认思考强度（覆盖全局默认） | `medium` |

每行渲染：**渠道 / 账号 / 模型 / 启用开关 / 状态徽标（余额、签到状态、任务进度）**。

### 1.2 schema 示意（schemastery，宿主侧）

```ts
units: z.array(z.object({
  channel: z.union([z.const('workbuddy'), z.const('trae'),
                    z.const('qoder'),   z.const('zcode')]),
  authRef: z.string(),                 // auths 文件 id / label
  model:   z.string(),                 // 空 = 跟随渠道默认
  enabled: z.boolean().default(true),
  reasoningEffortDefault: z.union([
    z.const('auto'), z.const('off'), z.const('low'),
    z.const('medium'), z.const('high'),
  ]).default('auto'),
})).default([]).volatile(),

// 全局思考强度默认（单元可覆盖）
reasoningEffort: z.union([...同上]).default('auto').volatile(),
```

> 全字段 `.volatile()`（沿用现有 8 字段约定：volatile 才进表单、改值不重挂、使用点 `refs.x.get()`）。

### 1.3 单元表放哪：两方案与取舍（本题关键）

| | 方案一：单元 = schemastery 数组字段（配置数据，宿主自动渲染表） | 方案二：单元 = 详情槽自定义 React 表（手写 UI） |
|---|---|---|
| 存储/持久化 | 宿主托管，随配置 revision 保存，零手写保存逻辑 | 需自己写宿主路由持久化（重复造 schemastery 的轮子） |
| 配置语义 | ✅ 单元本质是**静态声明数据**（channel/authRef/model/enabled/effort），正该进 schema | 把配置数据塞进运行态 UI，违背"配置低频写一次"原则 |
| 运行态徽标（余额/签到/任务进度） | ❌ schemastery 字段是静态的，**无法渲染实时徽标** | ✅ 可轮询叠加 live badge |
| 与「简单配置页」共存 | 单元数组字段和连接/生命周期字段同属一个 Config，宿主表单里分节显示 | 单元表占详情槽，连接/生命周期另占设置槽，割裂 |
| 工程量 | 小（声明即表单） | 大（手写表 + 行内编辑 + 持久化路由） |

**定稿 = 混合（推荐）**：
- **静态声明走方案一**：`units[]` 作为 schemastery 数组字段，和「连接 / 生命周期 / 检查项」同属一个 Config，宿主自动表单里分两节：
  - 节 1「连接与生命周期」：adminKey/adminKeyRef/port/exePath/manageLifecycle/startTimeoutSeconds/openControlPanel；
  - 节 2「养号检查项」：autoCheckin/autoTasks/normalizeSchedulerMode/reasoningEffort；
  - 节 3「单元列表」：`units[]`（channel/authRef/model/enabled/reasoningEffortDefault）。
- **运行态视图走详情槽**：`plugins.detail.section` 渲染**只读状态页**——把 schema 里声明的 `units[]` 逐行取出，与轮询到的 live 数据（`/accounts` 余额签到 + `/credits` + 任务进度）**join 成一行**，叠上状态徽标。即：**配置写在 schema，状态看在详情槽**，两边靠 `(channel, authRef)` 主键对齐。

> 一句话：**单元是配置 → 进 schema；单元的实时余额/签到/任务进度 → 详情槽轮询叠加**。不要手写可编辑表（方案二）。

---

## 2) 养号开关与按钮：常驻（主线）

| 项 | 定稿 | 默认建议值 |
|---|---|---|
| `autoCheckin`（每渠道自动签到） | **常驻开关**（配置页检查项节） | **默认 `true`**（养号主线，签到是日常收益） |
| `autoTasks`（定时跑成长任务） | **常驻开关** | **默认 `false`**（任务行为重、误触/封号风险高，用户显式开） |
| `normalizeSchedulerMode` | **常驻开关/一键按钮**（把各渠道 `scheduler_mode` 归一 `off`，保证 priority 生效） | **默认 `true`**（单元锁定的前提就是调度器可控） |
| 开机补签 `autoCheckinOnStart` | 保留（既有） | `true` |
| 单账号签到 / 单账号任务按钮 | **保留为主功能**（账号卡上行级按钮） | — |
| 批量签到 / 批量任务按钮 | **保留为主功能**（带 Modal 确认"将对 N 个账号执行"） | — |
| 拖拽排序 | **删**（用 ↑/↓ 微调或直接由单元声明顺序决定） | — |
| 汇总条四格 | **删**（token/积分单位不同，且单元页已逐行显示余额） | — |
| 额度进度条 | **删**（数字已够） | — |

---

## 3) 思考强度默认值 + 状态展示

### 3.1 `reasoningEffortDefault`

- **两层**：全局 `reasoningEffort`（配置页）+ 每单元 `reasoningEffortDefault`（单元数组里覆盖全局）。
- **控件**：下拉（primitives 若有 Select/Input 下拉族；否则用一组 Pill/Menu）。选项按渠道能力裁剪：
  - 通用：`auto` / `off` / `low` / `medium` / `high`；
  - 不支持思考的渠道（如 zcode）只显示 `auto`（或置灰）。
- **写路径（诚实标注）**：`reasoningEffort` 如何透传到上游请求——CPA 当前 16 条调用里**没有**对应写端点；它应作用于"该单元发起请求时的默认参数"。**落点待定（依赖设计定稿修正）**：候选是 CPA 全局 `/v0/management/config` 的请求级设置，或单元调用时的请求注入；本轮不画接不上的饼。

### 3.2 状态徽标数据来源（补进单元行）

| 徽标 | 数据来源 |
|---|---|
| 余额（可用/已用） | `GET /v0/management/plugins/:id/credits`（宿主 `/api/v1/cpa/accounts` 已聚合） |
| 签到状态（今日已签/连签天数） | `GET /accounts` 顶层/账号 `checkin` 字段（workbuddy 部分可靠、trae `checked_in` 可靠，见 adapters.js:76-135）；签到动作 `POST .../checkin` 的返回 summary |
| 任务进度 | `POST .../tasks/run` 的返回 / 任务状态字段（当前宿主 `school/vouchers` 之外任务状态暴露有限，**细化进度待定**） |
| 单元启用/禁用 | `auth-files/status.disabled`（已有 `POST /account-enabled`） |

---

## 4) 分支 B（纯反代版）作废声明

- 上一版《定稿5》中所有标注「分支 B」的表述（纯反代无养号、无 checkin/tasks/scheduler 端点、只留余额与启停）**全部作废**。
- 本插件现在只有一个形态 = 养号自动化主线（上一版分支 A 升级）。
- 仍保留的"收缩项"（删拖拽/汇总条/进度条）是**通用 UI 精简**，不代表退回纯反代。
- CPA 内置 `management.html` 控制台外链按新方向**取消引导**（内置 UI 全删，唯一 UI = 本插件）；账号导入等 CRUD 维持上一版"控制台兜底"两方案，但文案不再鼓励用户跳出去。

---

## 5) 与单元路由设计对齐（端点清单）

### 5.1 现有可复用端点（宿主 `/api/v1/cpa/*` + 上游 `/v0/management/...`）

| 单元视图需要 | 复用端点 |
|---|---|
| 渠道清单 + 能力 | `GET /api/v1/cpa/plugins`（上游 `GET /v0/management/plugins`） |
| 账号清单（与 units[] 的 authRef join） | `GET /api/v1/cpa/accounts?plugin=`（上游 `/plugins/:id/accounts` + `/credits`） |
| 模型下拉选项 | `GET /api/v1/cpa/models?plugin=`（上游 `/plugins/:id/models/groups?refresh=1`） |
| 单元启用/禁用 | `POST /api/v1/cpa/account-enabled`（上游 `PATCH /v0/management/auth-files/status`） |
| 单账号/批量签到、任务 | `POST /api/v1/cpa/action`（上游 `/plugins/:id/checkin`、`/workbuddy/tasks/run`） |
| 自动签到开关 | `GET/POST /api/v1/cpa/auto-checkin` |
| 调度模式归一 | `POST /api/v1/cpa/scheduler-mode` |
| 进程状态 | `GET /api/v1/cpa/status`、`POST /start` |

### 5.2 「独立调用单元」需要的新端点（标注待定）

「渠道×账号×模型=独立可调用单元、绝对锁定单账号」是**新语义**，现有 16 条调用**没有**直接支持。下列为新增需求，**标注「待定（依赖设计定稿修正）」**：

| 需求 | 候选端点 | 状态 |
|---|---|---|
| 每单元 key 校验 / 单元列表聚合端点 | （新）`GET /api/v1/cpa/units`：把 schema 声明的 units[] 与 live 账号/余额 join | **待定（依赖设计定稿修正）** |
| 单元级"锁定单账号"如何在 CPA 侧强制执行（选号永不跨单元） | 现有 lever：`scheduler_mode=off` + `fill-first` + per-auth `disabled`；**"按单元 key 精确路由到指定 auth"** 的接口不存在 | **待定**（依赖 CPA 是否暴露 per-credential 路由） |
| reasoningEffort 透传 | 见 §3.1 | **待定** |
| 任务进度细化 | 现有 tasks/run 只有返回 summary | **待定** |

> 落地原则：在"待定端点"补齐前，单元视图先用 §5.1 现有端点 join 出可用 UI；"绝对锁定单账号"的强保证先用 `enabled` 开关（禁用即不参与调度）+ `scheduler_mode=off` 兜底，精确单元路由待后端设计定稿。

---

## 附：一句话修正

主线 = 养号自动化（分支 B 作废）；单元 = `渠道×账号×模型` 的配置记录进 schemastery `units[]`（连接/生命周期/检查项同表单分节），详情槽只读状态页把 units 与轮询到的余额/签到/任务徽标按 `(channel,authRef)` join；autoCheckin 默认 true、autoTasks 默认 false、normalizeSchedulerMode 默认 true；思考强度全局+每单元下拉；CPA 内置 UI 全删；单元级精确锁定路由与 reasoningEffort 透传标为待定。
