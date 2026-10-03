# UI/UX 专项设计（蓝图补充章节）

- 日期：2026-10-03 ｜ 性质：只读设计，不改代码
- **效力**：本专项为推倒重设计，与《产物 2-C》§2.3 及《设计定稿5/UI 定稿修正》冲突处**以本专项为准**，并在各处显式标注「覆盖 2-C §2.3」。
- 底座：bridge 源码实测（`dsh-workbuddy-bridge` @ `2b2992d`）+ 本仓 client.js 解剖 + B1/B3B4。
- 核心诉求：① 模块区分清晰、无重复；② 模型无缝进 DSH 对话直接选用；③ 渠道·账号·模型一眼可分。

---

## 0) 关键机制核查（"无缝接入"是否成立——源码事实，非臆测）

**结论：成立。DSH 模型选择器接受插件在宿主侧注册的模型，机制 = `inject:['llm']` + `ctx.llm.registerAdapter()`，不是 client 注入选择器、也不是 bundle patch。**

逐环证据（bridge 源码）：

| 环 | 事实 | 文件:行 |
|---|---|---|
| a) 模型从哪来 | `WorkBuddyCatalog`：降级链 `live`(上游抓)→`saved`(该账号上次成功)→`fallback`(编译进包的静态名单)。条目 `WorkBuddyModelInfo={id,name,contextWindow,maxTokens,supportsImages,reasoning{supportedEfforts,defaultEffort…},billing{credits,free}}` | `src/catalog/index.ts`（fallback 名单）；`docs/ARCHITECTURE.md` 降级链节 |
| b) 怎么进 DSH 模型列表 | **宿主侧 Cordis 服务**：`export const inject=['llm']`；`ctx.llm.registerAdapter([variant.id], adapter)`。adapter 由 `@earendil-works/pi-ai` 的 `createProvider({id,name,models,api})` + `@deepseek-ai/dsh-llm-pi-ai` 的 `PiAiAdapter` 组装。**刻意不注册 configurable-provider 目录项**（注释：模型分组标题来自 adapter 自己的 provider 元数据+目录，picker 不受影响） | `src/index.ts:181`(inject)、`:699`(registerAdapter)、`:688-698`(不注册目录项注释)；`src/llm/adapter.ts:252-307` |
| c) 用户在对话窗怎么选 | DSH 原生 ModelSelect / `/model` popup 读 `ctx.llm` 注册表；分组标题=provider 的 `name`；picker 提交 `{provider, model: id, reasoningEffort}`；目录变了发 `ctx.emit('llm/adapters-updated')` 让 picker 重读 | `src/llm/adapter.ts:104`（提交形状）、`src/index.ts:685`（invalidate→emit） |
| d) 选中后怎么路由回 bridge | `{provider,model:id}` → `PiAiAdapter.resolveModel` → pi-ai openai-completions → `POST ${shim.baseUrl}/v1/chat/completions`，`Authorization: Bearer <shim 共享密钥>` → loopback shim 按请求解析真实凭据 → 上游。**model.id 就是路由键** | `src/llm/adapter.ts:248`(baseUrl=`${shim}/v1`)、`:297`(resolveApiKey=shim.token) |
| e) 退路 | **不需要退路**：该 seam 已被 bridge 实证可用。cpa-panel 照抄即可 | — |

**对 cpa-panel 的可复制方法（关键）**：CPA 本身就是 OpenAI 兼容端点（`127.0.0.1:8317/v1`）。因此 cpa-panel 可照 bridge 注册 **每个渠道一个 pi-ai provider**（provider id = channel），`baseUrl = http://127.0.0.1:8317/v1`，`resolveApiKey = units[].apiKey`（DSH→CPA 的代理 key），模型条目 = 该渠道下各单元的模型。这样用户在 DSH 对话窗原生模型列表里直接看到「渠道分组 → 单元模型」，零手填地址/模型名。

> **唯一未决（标待验证）**：bridge 的 shim 在**插件进程内**按请求注入真实上游凭据；而 cpa-panel 的真实账号凭据在 **CPA 进程**里，CPA 默认按自己的 routing 策略选号。"单元=锁定单账号"能否由 CPA 按 model id 精确路由，取决于 CPA 是否支持 per-request 钉 auth——见 §6 待验证条目。

---

## 1) 信息架构（IA）重设计

**四模块，职责互不重叠（覆盖 2-C §2.3 的"状态条+Pill+账号卡"混排）：**

| 模块 | 一句话职责 | 落点槽 |
|---|---|---|
| **M1 总览/状态** | CPA 进程与全局健康，只读 | 详情槽 `plugins.detail.section` 顶部常驻条 |
| **M2 单元管理** | 单元（渠道·账号·模型）的增删改、启用、命名、思考强度默认 | 详情槽主体（自定义表）+ 声明落 schemastery `units[]` |
| **M3 养号** | 签到/任务/自动开关/进度，批量操作 | 详情槽 M2 下方，与单元表联动 |
| **M4 设置/连接** | exePath/port/adminKey/生命周期/全局思考强度 | 设置槽 schemastery 自动表单（零 JSX） |

**现有散乱功能归位**：状态条→M1；渠道 Pill→并入 M2 单元表的渠道分组；账号卡→M2 单元行；签到/任务按钮→M3；自动签到 Switch→M3；拖拽排序→**删**（顺序=units[] 声明序）；汇总条/进度条→**删**。

**ASCII 线框（详情槽，单页）**：

```
┌─ CPA 中转站 ────────────────────────────────────────────┐
│ ● 运行中 · 127.0.0.1:8317   [启动]  [⚠无密钥]  [控制台↗] │ M1 状态条
├─ 单元管理 ────────────────────────────────────────────────┤
│ 渠道分组: [WorkBuddy] [Trae] [Qoder] [ZCode]   [+ 新建单元]│ M2
│ ┌──────────────────────────────────────────────────────┐ │
│ │ WB · 陈盛泷 · claude-sonnet-4  [启用●]  余 12.4k ✓签到│ │ 单元行
│ │ WB · cherry · claude-sonnet-4  [启用○]  余 800  ✗未签 │ │
│ └──────────────────────────────────────────────────────┘ │
├─ 养号 ────────────────────────────────────────────────────┤
│ 自动签到[●] 自动任务[○]  [全部签到] [全部任务] [刷新]      │ M3
├─ 设置（宿主自动表单）─────────────────────────────────────┤
│ exePath / port / adminKey / 生命周期 / 全局思考强度        │ M4
└───────────────────────────────────────────────────────────┘
```

---

## 2) 单元标识系统

**三段式徽标 = `渠道 · 账号 · 模型`**，一眼分清。

| 段 | 标识规则 | 视觉 |
|---|---|---|
| 渠道 | workbuddy/trae/qoder/zcode → 固定 Tag tone + 自绘 16px 图标（`currentColor`，ic_ds_* 没有就按 B1 栅格自绘） | `Tag` tone：workbuddy=brand / trae=business / qoder=warning / zcode=neutral（色全走 `--dsw-*`，不写死） |
| 账号 | `authRef` 对应昵称（来自 `/accounts[].nickname`） | 文本 `label-primary` |
| 模型 | 模型短名 | 文本 `label-secondary` |
| 状态徽标 | 启用/禁用/冷却/签到中/任务中/余额低 | `Tag`：启用 solid / 禁用 danger / 冷却 outline / 签到中 ongoing / 任务中 ongoing / 余额低 warning |

**应用示例**：
- 单元行：`[WB] 陈盛泷 · claude-sonnet-4 · ●启用 · 余12.4k · ✓已签`
- DSH 模型下拉分组：分组标题=渠道 provider name（"WorkBuddy"），行=`<账号昵称> · <模型名>`（model.id 编码见 §3）。

---

## 3) "DSH 直接选用模型"体验

**模型名命名规则（单元级，与 key→unit 编码对齐）**：

- provider id = 渠道（`workbuddy`/`trae`/`qoder`/`zcode`）——一组一 provider。
- model id = **`<上游模型名>@<authRef>`**，如 `claude-sonnet-4@workbuddy-cherry`。选它 = 选"WB 渠道·cherry 账号·sonnet"这个单元。
- 显示名（picker 里看到的）= `<账号昵称> · <模型名>`，如 `cherry · claude-sonnet-4`（对照 bridge 把计费折进 name 的做法，`adapter.ts:124-127`）。
- 与后端 key→unit 映射：picker 提交 `{provider: channel, model: "<model>@<authRef>"}` → 宿主按 `(channel, authRef)` 反查 `units[]` → 取该单元 `apiKey` 作为 `Authorization: Bearer` 发往 CPA `/v1`。**units[].apiKey 字段名与产物 2-A 严格一致**。

**分组/排序**：按渠道分组（provider 天然分组）；组内按 units[] 声明序（=用户在 M2 排的序）。
**切换路径**：对话窗 ModelSelect → 选渠道分组 → 选单元行。
**默认/最近**：默认单元 = units[] 第一个 enabled；最近使用由 DSH 原生 ModelSelect 自带（若支持），插件不另造。

---

## 4) 关键交互流（每步控件+反馈）

| 流 | 步骤 | 控件 | 反馈 |
|---|---|---|---|
| 导入账号 auths | 点"导入"→选 auth json 文件→确认 | 文件选择 + `Modal` | 行内错误条 `role=status`，成功 toast `role=status` |
| 建单元 | 选渠道(Pill)→选账号(下拉，来自 `/accounts`)→选模型(下拉，来自 `/models/groups`)→命名+选思考强度(下拉 auto/off/low/medium/high) | Dropdown×3 + Select + Switch | 写后回读单元表 |
| 一键签到/任务 | 单账号=行内 Button；批量=工具栏按钮→**Modal 确认"N 个账号"** | Button + Modal | 行级 busy 锁；成功行内 ✓（role=status），失败行内错误条 `--dsw-alias-state-error-primary` 不擦屏 |
| 状态刷新 | 20s 轮询 accounts + 30s status；`visibilitychange` 隐藏即停；读编号 latest-read-wins | — | 失败保留上次数据+顶部错误条 |
| 错误/冷却/余额不足 | 行内错误条（12px tertiary 几何、仅换 error 色）；冷却/余额低用 Tag | — | 不整屏 error |

---

## 5) 组件与视觉（落到 primitives + token）

| 用途 | 组件 | 来源 |
|---|---|---|
| 状态点 | `StateDot`（done/ongoing/error） | primitives（现已有） |
| 单元行壳 | `DisclosureRow`（expandable，icon=StateDot） | bridge `WorkBuddyCard.tsx:129-148`，照抄 |
| 渠道分组 | `Pill`（不做 SegmentedTabs） | primitives |
| 确认 | `Modal` + portal 皮肤三件套 | primitives 新增 import；皮肤照 bridge `probe-control.module.css:82-111` |
| 徽标 | `Tag`（多 tone） | primitives |
| 开关 | `Switch` | primitives |
| 思考强度/模型/账号选择 | `Dropdown`/`Menu`（primitives 有 Input/Menu） | 新用 |
| 按钮 | `Button` | primitives |
| token | `--dsw-alias-label-*/border-l1-l3/state-error-primary/brand-primary/radius-*/focus-ring-*`；中性边框 0.5px、数字 tabular-nums、禁用用 `label-dimmed` 不用 opacity | B1 §2.3 全表 |

**复用 bridge**：DisclosureRow 卡壳、useStatus 三策略、focus ring 一行式、空态 null 哲学、`writeClipboard`。**新写**：单元行的三段式徽标组合、渠道图标（16px currentColor 自绘）。
**空/加载/响应式**：加载=StateDot ongoing 不转圈；未知渲染 null 不摆假 0；卡片 grid 自适应 `minmax(260px,1fr)`（沿用现 CSS）。

---

## 6) 待验证条目（实施时实测回填）

| # | 现象 | 预期 | 验证方法 | 通过标准 |
|---|---|---|---|---|
| V1 | DSH 模型选择器是否接受 `ctx.llm.registerAdapter` 注册的模型 | 接受，picker 出现渠道分组 | 照 bridge 写一个最小 adapter 注册 stub provider | 对话窗 ModelSelect 里看到分组+模型行，可选可发 |
| V2 | `ctx.llm` / `llm/adapters-updated` 接口名在当前 DSH 版本是否有效 | 有效 | grep 宿主包 `@deepseek-ai/dsh-llm` 导出 | registerAdapter/emit 不报错 |
| V3 | **CPA 是否支持按 model id 精确钉到某 auth（单元锁定单账号）** | 支持或可绕过 | 向 CPA `/v1/chat/completions` 发 `model=<m>@<authRef>` 观察落在哪个号 | 请求落在指定 auth，不混用 |
| V4 | 单元级 apiKey（units[].apiKey）与 CPA `api-keys` 的对应 | 每单元独立 key 可鉴权 | 用不同单元 key 发请求 | 各 key 独立鉴权、互不通用 |
| V5 | reasoningEffort 透传 | picker 选 effort → CPA 请求带对参数 | 发请求抓 wire | reasoning_effort 正确到上游 |
| V6 | provider 注册后 `listProviders` 立刻带模型（无 UNKNOWN_MODEL 空窗） | 无空窗 | 照 bridge"先采纳身份再注册"三相顺序 | 注册即带模型，历史会话恢复不首条失败 |

---

## 附：与蓝图一致性
- 「在 DSH 对话里直接选模型」= §0/§3 的 `inject:['llm']`+registerAdapter 机制，已 bridge 实证；
- 单元命名 `<model>@<authRef>` 与 units[].apiKey 路由编码和产物 2-A/2-C 对齐；
- 本专项覆盖 2-C §2.3 的"状态条+渠道 Pill+账号卡"混排，改为 M1-M4 四模块。
