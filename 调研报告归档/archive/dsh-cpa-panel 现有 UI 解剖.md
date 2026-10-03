# dsh-cpa-panel 现有 UI 解剖

- 对象：`client.js`（浏览器半端，1111 行），包名 `dsh-cpa-panel`，提交 `7da7da8`
- 运行形态：`window.__ModuleLoader__.load({id:'dsh-cpa-panel', factory:(require)=>{…}})`（client.js:16-18），内部手写 `module={exports:{}}`/`exports` shim（client.js:19-20），由 DSH 宿主浏览器加载器执行；`require('react')`（:22）与 `require('@deepseek-ai/dsh-client-ui-primitives')`（:34）由宿主冻结模块表注入
- 组件解构（client.js:35-39）：`Button`、`Switch`、`Tag`、`Pill`、`StateDot` —— 全部来自 primitives

---

## 1) UI 组件清单（结构 + 位置 + 数据来源）

### 1.0 整体视图结构

**不是表格、不是一级多页，是单页（Single Panel）+ 二级渠道 Pill 切换。** 挂载点有两个槽位（`apply(ctx)` client.js:1055-1105）：

| 槽位 | 注册处 | 说明 |
|---|---|---|
| `plugins.detail.section`（order 20） | client.js:1074-1089 | 插件详情页里的自定义区块；`isMine(seat.subject)`（:1067-1072）判断 `subject.pkg.name === 'dsh-cpa-panel'` 才渲染，否则返回 null |
| `settings.plugins.tab`（order 20） | client.js:1092-1104 | 设置页里的次要标签页（兜底入口） |

两个槽位渲染的是同一个 `<Panel>`（client.js:872-971）。Panel 内部自上而下：

```
<cpa-status>        状态条（StateDot + 端口 + [启动] + [无密钥警告] + [控制台链接]）
<cpa-tabs>          渠道 Pill 组（workbuddy/trae/qoder/zcode）
<PluginPanel>       当前渠道的面板（汇总条 + 工具栏 + 账号卡网格）
<RoutingSection>    账号使用顺序（拖拽卡片 + 保存按钮）
```

### 1.1 逐组件清单

| 组件/控件 | 类型 | 位置（函数:行号） | 数据来源路由 |
|---|---|---|---|
| `StateDot`（运行状态点） | 官方组件（done=绿/error=红） | Panel:913 | `GET /api/v1/cpa/status`（:888） |
| 端口/运行文案 | 纯文本 | Panel:914-915 | 同上（`status.port`/`status.running`） |
| **「启动」按钮** | Button outline sm | Panel:916-918，`start()`:900-903 | `POST /api/v1/cpa/start`（条件渲染：仅 stopped 时） |
| 「无管理密钥」警告 Tag | Tag tone=warning | Panel:919 | `status.hasAdminKey===false` 时 |
| 「打开 CPA 控制台」链接 | `<a>`（非按钮，外链 `http://127.0.0.1:<port>/management.html`） | Panel:928-934 | `status.running && status.port` |
| 渠道切换 `Pill` 组 | 官方分段标签 | Panel:941-946，state `active`（:876） | `GET /api/v1/cpa/plugins`（:889，拿 label/unit/capabilities） |
| **汇总条 cpa-sum**（可用/已用/额度池/单位 四格） | 自绘 div 卡片 | PluginPanel:477-493，前端本地累加（:408-416） | `GET /api/v1/cpa/accounts?plugin=`（:396） |
| **「刷新」按钮** | Button outline sm | PluginPanel toolbar:497-500 | 触发 `load()`（:394） |
| **「全部签到」按钮**（批量） | Button primary sm | PluginPanel:503-507，`runAll('checkin')`:438-451 | `POST /api/v1/cpa/action` body `{plugin,kind:'checkin'}` |
| **「全部任务」按钮**（批量，仅 workbuddy） | Button outline sm | PluginPanel:509-514，`runAll('tasks')` | 同上 `kind:'tasks'` |
| **自动签到 `Switch`**（含可见文字 label） | 官方 Switch（外层包 `<label class=cpa-switch>`） | PluginPanel:522-533，`toggleAuto`:453-470 | 读 `GET /api/v1/cpa/auto-checkin?plugin=`（:398）；写 `POST` 同路径 body `{enabled}`（:456） |
| 「使用中」提示行 cpa-active-note | 纯文本说明 | PluginPanel:543-555 | `accountsResponse.data.active`（宿主从 /auth-files 算好） |
| 账号卡网格 cpa-grid | CSS grid | PluginPanel:561-575 | accounts 数组 |
| **`AccountCard` 账号卡** | 自绘卡片组件 | AccountCard:223-383 | 单条 account 对象 |
| ├ 昵称 cpa-nick | 文本 | :355 | `account.nickname` |
| ├ 徽标组（Tag）：使用中 solid / 已禁用 danger / 已耗尽 warning / 已签到 success·未签到 outline / 连签 quiet | 官方 Tag | badges :269-295 | `account.disabled/exhausted/checkin.*` |
| ├ 可用/已用两个数字 cpa-num | 文本 | :362-371 | `account.credits.remain/used` |
| ├ 额度进度条 cpa-bar/cpa-fill | 自绘 div 宽度百分比 | :372-375（percent 算 :232-235） | `credits.used/size` |
| ├ meta 行（包数/plan/未知额度） | 文本 | :342-347, :376-378 | `credits.packCount/plan/remainKnown` |
| ├ **单账号「签到」按钮** | Button outline sm | :310-315，`run('checkin')`:237-250 | `POST /api/v1/cpa/action` body `{plugin,kind,authIndex}` |
| ├ **单账号「任务」按钮** | Button outline sm | :316-321，`run('tasks')` | 同上 |
| └ **启用/禁用切换按钮** | Button primary(禁用时)/ghost | :333-340，`toggleEnabled`:253-267 | `POST /api/v1/cpa/account-enabled` body `{plugin,authIndex,enabled}`（`setAccountEnabled`:208-214） |
| **`RoutingSection` 顺序区** | 自绘区块 | RoutingSection:615-869 | 见下 |
| ├ 当前策略只读提示 cpa-hint | 文本（round-robin 时带 ⚠️） | :811-823 | `GET /api/v1/cpa/routing`（:631） |
| ├ **可拖拽账号卡 cpa-prow** | 自绘方块卡（draggable） | `buildCard`:683-803，实时重排 onDragOver:708-732 | `GET /api/v1/cpa/priority?plugin=`（:635）+ 父级上报的 accounts 余额（:684） |
| ├ 位次徽标 cpa-card-rank（第1位实心） | 自绘 div | :744-748 | 数组 index |
| ├ 拖拽把手 `⠿` | 文本字符 | :770 | — |
| ├ **↑ / ↓ 微调按钮** | Button ghost sm（aria-label） | :776-801，`move`:645-653 | 本地顺序 state |
| └ **「保存顺序」按钮** | Button primary md | :854-864，`saveOrder`:655-672 | `POST /api/v1/cpa/priority?plugin=` body `{order:[昵称…]}` |
| 空态 cpa-empty（无账号/加载中/读取失败） | 自绘 div | noAccounts:557-559；loading:579-581；error:582-587 | `state.phase` 三态机（'loading'/'ready'/'error'，:389） |
| **toast 提示 cpa-toast** | 自绘 div（ok 绿/err 红） | PluginPanel:588-593，`setToast` state(:391) | 各动作返回 `{ok,error}` |
| —— 下拉/选择框/输入框 | **全 UI 没有** | —— | 模型目录 `/models`、`/school` 路由虽存在但 UI 未渲染 |

---

## 2) 交互行为清单

| 交互 | 实现 | 位置 |
|---|---|---|
| 批量签到 | `runAll('checkin')` → `act(plugin,'checkin')`（无 authIndex，body 只有 plugin/kind）；成功后 `load()` 重载 | PluginPanel:438-451；act:192-200 |
| 批量任务 | 同上 `runAll('tasks')`（仅 capabilities.tasks=true 的 workbuddy 渲染按钮） | :438-451 |
| 刷新 | 无独立"刷新 CPA"概念；工具栏「刷新」= 重新 `load()` 拉 `/accounts` + `/auto-checkin` | load:394-432 |
| 单账号签到/任务 | `run(kind)` 带 `account.authIndex` 调 `/action` | AccountCard:237-250 |
| 启用/禁用 | `toggleEnabled()`：取反 `account.disabled` → `setAccountEnabled(...,next)` → 成功后 `onReload()` | :253-267 |
| 拖拽排序 | HTML5 DnD：onDragStart 记 index + 写 dataTransfer；**onDragOver 实时 splice 重排**（不等松手）；onDrop/onDragEnd 复位高亮；保存时把当前顺序的昵称数组 POST | buildCard:697-741；saveOrder:655-672 |
| 自动签到开关 | `toggleAuto(next)` → POST `/auto-checkin` body `{enabled}`；成功后本地同步 `setAuto(result.enabled)` | :453-470 |
| 活跃检测 | **无用户交互**：宿主在 `/accounts` 响应里直接算好 `active.authId/since`，前端只读展示 | activeAuthOf 宿主侧；前端 :421-422, :543 |
| 错误提示 | **自绘内联 toast div**（非组件库 toast、非弹窗）：`setToast({text,kind,detail})`，渲染在面板底部；动作失败 toast 带红 | :588-593, :241-245 |
| 加载态 | 每卡/每面板一个 `busy` 布尔；进行中所有按钮 `disabled`（防重复点）；非全局 spinner | busy state :227/:392；disabled 绑定 :312/:318/:337/:498 等 |
| **确认弹窗** | **完全没有**——启用/禁用、保存顺序、批量签到全部点击即执行，无二次确认 | （全文件无 confirm/Modal） |
| **防抖/节流** | **没有**；拖拽实时重排也不做节流（直接 setState） | — |
| **实时刷新机制** | **无轮询、无事件订阅、无 WebSocket**。仅：组件 mount 时 `useEffect(load)`（:434-436）+ 每次写动作成功后手动 `await load()`。路由切换靠 `key={activeMeta.id}` 重挂载 Panel 级联刷新 | :434-436, :246, :447, :463 |

---

## 3) 样式实现方式

| 维度 | 结论 | 证据 |
|---|---|---|
| CSS 组织 | **运行时内联注入**：一个 JS 字符串数组 `CSS=[...].join('')`，`injectCss()` 往 `document.head` 插一个 `<style data-plugin-css="dsh-cpa-panel">`，已存在则跳过（幂等） | CSS:979-1043；injectCss:1045-1053 |
| 主题 token | **用宿主 CSS 变量**（`--dsw-alias-label-tertiary / --dsw-alias-border-l2 / --dsw-alias-bg-base` 等），跟随 DSH 明暗主题；点缀硬编码色：成功绿 `#2ea043`、错误红 `#d1242f` | :981,986,997,1014,992,1000,1009-1010 |
| UI 库 | **混合**：结构/按钮/开关/标签/分段/状态点用官方 primitives（Button/Switch/Tag/Pill/StateDot，:34-39）；布局/卡片/进度条/网格/toast 自绘 CSS。注释明确：能用 primitives 的不自绘，避免与主题 token 脱节（:23-33, :973-978） | :35-39 |
| 图标 | **无图标库、无 SVG**：① 拖拽把手用文本字符 `⠿`（:770）；② 微调用 `↑`/`↓`（:787,799）；③ 结果反馈用文字 `✓`/`✗`（:242,259）；④ 仅外层 `icon.svg` 是包级卡片图标，不进 UI | :770,787,799,242 |
| 动画 | 纯 CSS transition（卡片让位滑动 `transform .18s`、拖拽浮起 scale+rotate+阴影） | :1021,1028 |

---

## 4) 数据 ↔ UI 映射（12 条路由逐条）+ 本地状态管理

### 4.1 路由 → 控件

| 路由 | 渲染成什么控件 |
|---|---|
| `GET /api/v1/cpa/status` | 状态条：StateDot + 端口文案 + 启动按钮 + 无密钥警告 Tag + 控制台链接（Panel mount 时并发拉，:887-890） |
| `GET /api/v1/cpa/plugins` | 渠道 Pill 组（label/unit/capabilities）；决定默认 active（:892-896） |
| `GET /api/v1/cpa/accounts?plugin=` | 汇总条四格 + 账号卡网格（昵称/徽标/可用已用数字/进度条/操作按钮）+ active 提示行 |
| `GET /api/v1/cpa/auto-checkin?plugin=` | 自动签到 Switch 的 checked 态 |
| `POST /api/v1/cpa/action` | 批量签到/任务、单账号签到/任务 按钮的统一出口 |
| `POST /api/v1/cpa/account-enabled` | 每卡启用/禁用按钮 |
| `GET /api/v1/cpa/routing` | RoutingSection 顶部"当前策略"只读文本 |
| `GET /api/v1/cpa/priority?plugin=` | 可拖拽顺序卡片列表（file/nickname/priority/disabled） |
| `POST /api/v1/cpa/priority?plugin=` | 「保存顺序」按钮 |
| `POST /api/v1/cpa/start` | 状态条「启动」按钮 |
| `GET /api/v1/cpa/models?plugin=` | **未渲染**（后端 modelsOf 存在，前端无对应控件） |
| `GET /api/v1/cpa/school` | **未渲染**（后端 school() 存在，前端无对应控件） |

### 4.2 本地状态管理

- **无全局 store、无 Redux/Zustand**；纯 React 内置：每组件各自 `useState`/`useCallback`/`useEffect`。
- 状态树：
  - `Panel`（:872）：`status`、`plugins[]`、`active`(当前渠道)、`pluginState{accounts,activeAuthId}`——通过 `onAccounts` 回调**从子级 PluginPanel 上报**，避免 RoutingSection 重复拉接口（注释 :877-883）。
  - `PluginPanel`（:386）：`state{phase,accounts,remain,used,size,activeAuthId,activeSince}` 三态机、`auto`(bool|null)、`toast`、`busy`。
  - `AccountCard`（:223）：仅 `busy`（当前动作名）。
  - `RoutingSection`（:615）：`strategy`、`order[]`、`dragIndex`、`dragOverIndex`、`busy`、`note`。
- 跨组件通信=props 向下 + 回调向上；数据请求全部收敛在 `api(path)` 薄封装（:177-189，`fetch(credentials:'include')`，异常吞成 `{ok:false}`）。

---

## 附：给 B3/B4/C 的速记

- **可复用控件**：官方 primitives 五件套（Button/Switch/Tag/Pill/StateDot）+ CSS token 体系已打通；自绘部分（卡片网格/进度条/拖拽卡/toast）可整体丢弃。
- **可删除面**：模型/学校两条路由前端本就没用；拖拽排序、汇总条、进度条、批量按钮、活跃提示是"复杂面板"主体。
- **保留面**：状态条（status）+ Switch（auto-checkin）模式已足够覆盖简单配置页的运行态展示。
- **无确认弹窗、无轮询、无节流**——若新设计需要这些，是新增而非复用。
