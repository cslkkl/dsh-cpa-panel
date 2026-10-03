# DSH 官方风格与 dsh-workbuddy-bridge UI 贴合做法

- 调研日期：2026-10-03
- 调研对象：bridge 仓 `dsh-workbuddy-bridge`（commit `2b2992d`，包 `dsh-workbuddy-bridge@0.3.0`）
- 配套底座：《dsh-workbuddy-bridge 工程参考拆解.md》（同会话 s_000cHCFi6fT artifacts），本报告只补「UI/视觉贴合」这一维度
- 性质：只读。不改任何代码。

---

## ① 官方风格事实（带 URL，含公开可得性说明）

### 1.1 公开可得性的如实说明

DSH（DeepSeek Harness）**没有对外公开的独立设计规范站 / Figma / 设计 token 文档**。可作为"官方风格"依据的公开材料只有三类：

1. **npm 上的 `@deepseek-ai/dsh-client-ui-*` 包 README**（这些包本身就是官方 UI 源码的产物，README 即组件契约）；
2. **GitHub monorepo `deepseek-ai/deepseek-harness`**（一切皆插件，UI 也在 `packages/client/ui-*` 下，架构文档与 cookbook 公开）；
3. **社区插件源码**（dsh-speak、dsh-ds-balance 等引用官方 token/类名的实战注释）。

因此本节凡"设计 token 名"一律照抄 bridge 源码里实际用到的 `--dsw-*` 名字——**这就是当前唯一可验证的 ground truth**。下文同。

### 1.2 官方项目与架构事实

| 事实 | URL |
|---|---|
| DSH 官网（开源、preview、npx @deepseek-ai/dsh web） | https://deepseekharness.dev/ ；https://dshai.org/ ；https://www.deepseek.com/en/harness/ |
| 源码仓库（monorepo，UI 在 `packages/client/ui-*`） | https://github.com/deepseek-ai/deepseek-harness |
| 官方架构文档（"Where new behavior goes"扩展点表） | https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/architecture.md |
| 官方 cookbook（含 `adding-a-settings-card.md` 设置卡片教程） | 同上仓 `docs/cookbook/extension-cookbook.md` |

架构文档里与 UI 直接相关的两句：
- "Add UI or editor integration → drive `ctx.agents` and render from `session/event`"
- "Add a Web Client Chat node → register a `ConversationNodeDefinition` + keyed renderer"
- 一切皆插件：model adapter / tool registry / session log / agent loop **乃至 UI 本身**都是可替换插件；插件通过 Cordis slots 契约挂载，运行时由宿主注入 React 与 `@deepseek-ai/*`。

### 1.3 官方 UI 组件包谱系（`@deepseek-ai/dsh-client-ui-*`）

全部 BSD-3-Clause，仓库即 deepseek-harness。与 bridge 相关的实锤包（来自 bridge `package.json` 的 `dsh.client.inject` 与 peerDependencies）：

| 包 | 职责（据 README / bridge 用法） |
|---|---|
| `@deepseek-ai/dsh-client-ui-primitives` | **纯 React atoms，zero cordis**。这是贴合官方风格的主入口。URL: https://www.npmjs.com/package/@deepseek-ai/dsh-client-ui-primitives |
| `@deepseek-ai/dsh-client-ui-slots` | slot 类型契约：`InjectFace` / `PropsLocale` / `PropsRuntime` / `LocaleNamespaceMap` |
| `@deepseek-ai/dsh-client-ui-settings` | 设置页宿主（`SettingsForm` 由它服务） |
| `@deepseek-ai/dsh-client-ui-plugin-manager` | 插件页（`plugins.bundle.config` 槽的宿主） |
| `@deepseek-ai/dsh-client-ui-renderer` | 浏览器 React slot 绑定与应用根 |
| `@deepseek-ai/dsh-client-ui-conversation` / `-chat` / `-model-selection` / `-session` | 会话/消息/模型选择器/会话态 |
| `@deepseek-ai/dsh-client-locale` | `ctx.locale.register` 与 `ctx.locale.bind` |
| `@deepseek-ai/dsh-client-store` | `SnapshotStore` |

`primitives` 包 README 明列的原子（即"官方风格"的全部可借组件）：`StateDot`、`DisclosureRow`、`ic_ds_*` 图标族、`Button` / `Pill` / `Menu` / `Modal` / `Input`、`OnboardingSurface`、markdown 族（`MessageText` / `MarkdownText` / `JsonBlock`）、`JsonTree`、`useAnchoredMaxHeight`、`TerminalBlock` / `DiffBlock` / `ReadBlock` / `SearchBlock` / `WebBlock`、`HoverCard`。README 自述"Pill and Input have no design source — both atoms are self-defined"，且 **glyph 级图标是"重绘近似"**（fish logo / sparkle 来自字体字形，矢量不可导出）。

### 1.4 官方设计 token（CSS 变量）命名

前缀为 **`--dsw-*`**（不是 `--ds-*`，也不是 `--color-*`），分三层：

| 层 | token（bridge 实测用到，照抄名字） | 用途 |
|---|---|---|
| 别名-文字 | `--dsw-alias-label-primary` / `-secondary` / `-tertiary` / `-dimmed` | 标题/正文/提示/禁用四档墨色 |
| 别名-边框 | `--dsw-alias-border-l1` / `-l2` / `-l3` | 卡片外框/分隔线/轨道底色 |
| 别名-状态 | `--dsw-alias-state-error-primary`、`--dsw-alias-state-business-primary` | 错误态、focus ring 兜底 |
| 别名-品牌 | `--dsw-alias-brand-primary` | 进度条填充等品牌色 |
| 别名-背景 | `--dsw-alias-bg-module-platform`、`--dsw-alias-bg-layer-3` | 浮起面/内凹井 |
| 别名-交互 | `--dsw-alias-interactive-bg-hover` | 图标按钮 hover 底 |
| 圆角 | `--dsw-radius-sm` / `-md` / `-lg` | 小井/卡片浮层/弹层 |
| 聚焦 | `--dsw-focus-ring-width`、`--dsw-focus-ring-color` | 键盘 focus 环 |
| 阴影/高程 | `--dsw-elevation-prominent`、`--dsw-elevation-stroke-color` | popover 阴影 |
| 弹层皮肤 | `--dsw-specific-menu` + `--dsw-menu-backdrop-filter` | **必须成对出现**（"translucent but not frosted"） |
| markdown | `--dsw-alias-markdown-*`、`--dsw-font-markdown-*` | 与 `@deepseek/md` 同源 |
| 字体大小 | `--dsh-content-font-size-secondary`（默认 13px） | caption 档 = 它 − 1px |

**两个已知"坑 token"**（bridge 注释实锤，照抄避免重蹈）：
- `--dsw-alias-label-error`：被宿主自己的 form CSS 引用但**从未定义**，用了静默无色 → 错误色一律用 `--dsw-alias-state-error-primary`。
- `--dsw-alias-label-quaternary`、`--dsw-alias-bg-layer-4`：**不存在**，写了等于没写。禁用态用 `--dsw-alias-label-dimmed`。

### 1.5 图标体系

- 官方图标命名 **`ic_ds_*`**，约 **188 个**，全部在 `dsh-client-ui-primitives` 内（bridge 注释实测核对："the host's 188 icons contain no coin, credit, wallet or currency shape"）。
- 官方栅格：**16×16 viewBox="0 0 16 16"**，墨线垂直占 2..14、水平占 3.5..12.5（host 自保持 6–9 inset）。
- 主题适配铁律：SVG 用 `currentColor`（fill 或 stroke），**不写任何色值、不写 `[data-ds-dark-theme]` 分支**——深浅色由按钮/行的 color token 决定。

---

## ② bridge 贴合做法的文件级清单

所有路径相对 `dsh-workbuddy-bridge@2b2992d/`。

### 2.1 组件：全部用官方 primitives，零手搓控件

bridge 的铁律（`src/client/panels.tsx:1-7` 注释原话）："Every control here is an official primitive (`Tag`, `Checkbox`, `Button`, `Pill`), so the panels inherit the host theme and keyboard behaviour without this plugin shipping a single hand-built widget."

| import（照抄） | 来自包 | 用在哪 |
|---|---|---|
| `SettingsForm`, `SettingsValueField`, `Switch` | primitives | `src/client/WorkBuddyConfigPage.tsx:21` |
| `SettingsFormModel`, `settingsTextField`, `SettingsFieldSpec/State/Actions/Scope/Shell` | primitives | `src/client/config-controller.ts:12-20` |
| `DisclosureRow`, `StateDot`, `SegmentedTabs`, `SegmentedTab`, `StateDotState` | primitives | `src/client/WorkBuddyCard.tsx:13-19` |
| `Button`, `Checkbox`, `Tag`, `writeClipboard` | primitives | `src/client/panels.tsx:10` |
| `Tooltip`, `useAnchoredPosition`, `useDismissOnOutsidePointer` | primitives | `src/client/probe-control.tsx:51-56` |
| `InjectFace`, `PropsLocale`, `PropsRuntime` | dsh-client-ui-slots | `WorkBuddyConfigPage.tsx:22` |
| `ModelDirectory`（type） | dsh-client-ui-model-selection/client | `probe-control.tsx:57`、`credit-balance.tsx:47`、`credit-label.tsx:33` |
| `SnapshotStore`（type） | dsh-client-store | `config-controller.ts:11` |
| `SettingsFormLabels`（type） | primitives | `src/client/locales.ts:3` |

**卡片壳刻意复用宿主 `DisclosureRow`**（`WorkBuddyCard.tsx:1-10`）：插件不自己写可展开容器，直接继承宿主 Disclosure 的 chrome、键盘行为与主题，插件只填 body。

### 2.2 槽位：贴合宿主布局的三个挂载点（`src/client/index.tsx`）

| 槽 | kind/scope | 注册内容 | 为什么这么选 |
|---|---|---|---|
| `plugins.bundle.config` | — | `WorkBuddyConfigPage`，key = **包名** `dsh-workbuddy-bridge` | 插件页配置入口；`whileServed([ENTRY_ID])` 等宿主真在服务才注册 |
| `conversation.input.right` | list | `WorkBuddyProbeControl`（灯泡）+ `WorkBuddyCreditBalance`（`order:-10` 让余额靠左、灯泡居中、模型选择器靠右） | **故意不用 `conversation.input.model`**——那是 `kind:'single'`，已被宿主 ModelSelect 占用，再注册会抛错并顶掉宿主 UI |
| `conversation.chat.assistant-actions` | list / session / owner currency `{messageId}` | `WorkBuddyCreditLabel`（共消耗 X） | 宿主 Like/Dislike 同一行；由 `dsh-client-ui-chat` 声明 |

两个常量红线：`ENTRY_ID='llm-workbuddy'`（= `cordis.patch.yml` insert id = `configForms.get()` 的命名空间）与 `BUNDLE_NAME='dsh-workbuddy-bridge'`（= pkg.name = slots 的 key）必须分开钉死（`index.tsx:45-79`）。

### 2.3 CSS：零色值、零字体族，全部 `--dsw-*` token

样式文件四个：`workbuddy.module.css`（358 行，注释即设计规范）、`probe-control.module.css`、`credit-balance.module.css`、`credit-label.module.css`。

`workbuddy.module.css:1-21` 的总纲原话："Every value here is taken from the host's own settings surfaces rather than invented… the stylesheet declares no font family, no colour literal, and no line-height outside `1.5`/`1.6`."

**照抄自宿主的取值真源**（`src/client/README.md:36-41` 明列）：
- 字段/开关行/表单节奏 → 宿主 `ui-primitives/lib/settings-form/{fields,SettingsForm}.module.css`：label 13/1.5 w500 primary，hint 12/1.5 tertiary；
- 布尔开关整行 → 宿主 `dsh-client-ui-settings-subagent` 的 `.toggleRow/.toggleLabel`；
- 带边框列表块 → 官方 `dsh-experimental-client-ui-voice-input` 的 `.preparation/.models/.settingsCard`：`border:.5px solid border-l1; border-radius:10px; gap:10px; margin:12px 0; padding:14px; font-size:13px`。

**两条不可破的惯例**（`workbuddy.module.css:16-21`）：
1. 中性实线边框一律 **0.5px**，只有状态色保持 1px；
2. 不写色值字面量，深浅主题全靠 `--dsw-alias-*`。

实测用到的 token 全表（grep 自四个 css）：
`--dsw-alias-label-primary/secondary/tertiary/dimmed`、`--dsw-alias-border-l1/l2/l3`、`--dsw-alias-state-error-primary`、`--dsw-alias-brand-primary`、`--dsw-alias-bg-module-platform`、`--dsw-alias-bg-layer-3`、`--dsw-alias-interactive-bg-hover`、`--dsw-alias-state-business-primary`、`--dsw-radius-sm/md/lg`、`--dsw-focus-ring-width/color`、`--dsw-elevation-prominent`、`--dsw-elevation-stroke-color`、`--dsw-specific-menu` + `--dsw-menu-backdrop-filter`、`--dsh-content-font-size-secondary`。

**圆角/超椭圆**：圆按钮用 `border-radius:999px; corner-shape:round`（全局超椭圆的 opt-out，与宿主 Switch 胶囊同款，`probe-control.module.css:30-33`）。

**Focus ring**（`probe-control.module.css:60-64`）：`outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset:1px`——不手写 2px 品牌描边。

### 2.4 图标：宿主 188 个 `ic_ds_*` 不够时按官方栅格自绘

- Composer 灯泡 `ProbeIcon`（`probe-control.tsx:554-598`）：手写 SVG，`viewBox="0 0 16 16"`、16px、`fill="currentColor" fillRule="evenodd"`，闪电为第二路径（evenodd 挖出玻璃洞，不用第二种色）。
- 硬币堆叠 `CoinGlyph`（`credit-balance.tsx:191-214`）：`fill="none" stroke="currentColor" strokeWidth="1"`，造型学宿主 `database` 图标语汇（上椭圆+直壁+前半弧），`ry=1.25` 读成硬币、`ry=1.6` 就读成数据库。
- 两者并排于同一 28px 行：同 16px、同 currentColor、同线宽 → "读起来像一套"（`credit-balance.tsx:185-189`）。

### 2.5 布局模式

| 布局 | 做法 | 证据 |
|---|---|---|
| 设置页总骨架 | `SettingsForm`（宿主自带 footer 保存）在上，下方 gap:12px 接 `DisclosureRow` 卡片列；页面不自设标题（宿主已画插件名+一句话） | `WorkBuddyConfigPage.tsx:44-127` |
| 卡片 | `DisclosureRow expandable expandOnRowClick`，`icon=<StateDot>`，右侧 `collapsedContent` 放状态行；整行可点 | `WorkBuddyCard.tsx:129-148` |
| 卡内分区 | `SegmentedTabs`（credits/models/probe 三页），tab 带 `id/panelId/aria-labelledby` | `WorkBuddyCard.tsx:95-117,208` |
| 带框列表 | `0.5px border-l1 + radius 10px + padding 14px + gap 6px + max-height 280px + overflow:auto` | `workbuddy.module.css:223-233` |
| 行 | 左名右值 `justify-content:space-between; gap:8px; padding:12px 0`；数字列 `font-variant-numeric:tabular-nums` | `workbuddy.module.css:118-125,267-277` |
| 进度条 | 高 8px、`border-radius:999px`、底 `border-l3`、填 `brand-primary`；`role="progressbar"`，未知总量时省略 range 属性只给 `aria-valuetext` | `workbuddy.module.css:200-212`、`panels.tsx:117-184` |
| Composer 图标按钮 | 28×28 圆、transparent、hover `interactive-bg-hover`、disabled 用 `label-dimmed` token（不用 opacity） | `probe-control.module.css:20-55` |
| 弹层 | `createPortal(..., document.body)` + `useAnchoredPosition` 定位 + `useDismissOnOutsidePointer` 关闭；`::before` 上放 `--dsw-specific-menu`+`backdrop-filter`；`isolation:isolate`；`z-index:1100`；`--dsw-elevation-prominent` | `probe-control.module.css:82-111`、`probe-control.tsx:472-548` |

### 2.6 交互细节（loading / 空态 / 错误）

- **Loading**：`StateDot state='ongoing'`（不是 `idle` 灰——"还没读过"≠"已登出"，`WorkBuddyCard.tsx:39-43`）；`aria-busy`；按钮文字变 "refreshing…"；**不转圈不脉冲**（28px 下 spinner 读起来像 glitch）。
- **空态/未知**：观测不到就渲染 `null`，绝不摆假 `0` 或假 `—`（"a fabricated zero is worse than a blank"，`credit-balance.tsx:23-27`、`credit-label.tsx:17-23`）；unlimited 额度不画满条（省略 range 属性）。
- **错误**：读失败**不擦屏**，错误文字 `.error`（12px tertiary 几何、只换 error 色）并排留在原文档下（`use-status.ts:1-22` 三策略：失败不擦屏/最新读编号防旧 poll 回写/失败不禁轮询）。
- **写后回读**：所有写动作（探测/显隐）写完必重新拉状态文档；只锁正在写的那一行（`toggling:ReadonlySet<string>`），不全卡禁用。
- **复制**：`writeClipboard()` + `role="status"` 宣布成败；文本 `user-select:text` 兜底手选（`panels.tsx:504-533`）。
- **禁用按钮文案**： settled 行的按钮写 "不需要/已声明" 而不是灰着写 "检测"（disabled 控制的文案要命名它不会做的事，`probe-control.tsx:533-543`）。

### 2.7 业务绑定 vs 通用

| 文件 | 性质 |
|---|---|
| `config-controller.ts`（SettingsFormModel staged 表单） | **通用**——任何 DSH 插件配置页都长这样 |
| `WorkBuddyCard.tsx` 的 DisclosureRow+StateDot+SegmentedTabs 骨架 | **通用壳**，内容业务 |
| `panels.tsx` 的 CreditBar（progressbar+aria）、ModelsPanel（Checkbox 行+Tag badge）、AssistBlock（复制 prompt+重检） | **结构通用**，数据业务 |
| `probe-control.tsx` 的 Tooltip+portal popover 骨架与 28px iconButton | **通用骨架**，灯泡 glyph 业务 |
| `credit-balance.tsx` / `credit-label.tsx` 的"读数不是控件"行 | **通用模式**，硬币 glyph 与余额语义业务 |
| `workbuddy/probe-control/credit-*.module.css` | **全部通用**（token 白名单，零业务色） |
| `locales.ts`、`variants.ts`、`status-document.ts`、`use-status.ts`、`use-session-credits.ts`、`format.ts` | 半通用（取数/格式化可借，键名业务） |

---

## ③ 可直接复用到 dsh-cpa-panel 的清单

### 3.1 可直接复用（照抄，不改）

1. **import 清单**：`import { SettingsForm, SettingsValueField, Switch, DisclosureRow, StateDot, SegmentedTabs, Button, Checkbox, Tag, Tooltip, writeClipboard, useAnchoredPosition, useDismissOnOutsidePointer, SettingsFormModel, settingsTextField } from '@deepseek-ai/dsh-client-ui-primitives'`；slot 类型 `InjectFace/PropsLocale/PropsRuntime` 来自 `dsh-client-ui-slots`。
2. **CSS token 白名单**（②2.3 全表）+ 两条铁律：中性边框 0.5px、零色值字面量、零字体族、line-height 只用 1.5/1.6、数字列 `tabular-nums`。
3. **弹层皮肤三件套**：`--dsw-specific-menu` + `--dsw-menu-backdrop-filter` 成对写在 `::before` 上、`isolation:isolate`、`--dsw-elevation-prominent`、`useAnchoredPosition`+`useDismissOnOutsidePointer`+portal to `document.body`。
4. **Focus ring**：`outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset:1px`。
5. **设置页骨架**：`whileServed([ENTRY_ID])` 等宿主服务 → `slots.register({name:'plugins.bundle.config', key:BUNDLE_NAME, locale:NS}, Page)`；`SettingsFormModel` staged 表单 + 一次 revision 保存；`ENTRY_ID`（=patch insert id）与 `BUNDLE_NAME`（=pkg.name）两常量分开。
6. **useStatus 三策略**：失败不擦屏 / 读编号最新赢 / 失败不禁轮询 / 写后回读 / 行级锁 Set。
7. **空态哲学**：观测不到渲染 null，不摆假 0/假 —。
8. **Disabled 用 `--dsw-alias-label-dimmed` token 变暗，不用 opacity**；绝不写不存在的 `label-quaternary` / `bg-layer-4` / `label-error`。
9. **locale 双层**：`locale/{en,zh}.json` 放包展示元数据；界面文案 `ctx.locale.register(NS,{zh,en})` + `declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap {...} }`。
10. **图标自绘规则**（宿主缺对应 `ic_ds_*` 时）：16×16 viewBox、16px、currentColor、线宽 1、不写主题分支。

### 3.2 需改造再用

1. **卡片壳**：`DisclosureRow`+`SegmentedTabs` 骨架照用，但 tab 分组按 CPA 面板自己的读者任务重排（bridge 是 积分/模型/探测 三页）。
2. **CreditBar 进度条**：`role="progressbar"` + indeterminate 省略 range 属性的写法照用；具体额度语义换成 CPA 的额度/用量模型。
3. **`conversation.input.right` 挂载**：若 CPA 也要在 composer 放控件，照用 list 槽 + `order` 排位置；**不要碰 `conversation.input.model`**。
4. **toggleRow / SettingsValueField 行**：按 CPA 实际字段（中转地址/密钥/超时等）改字段 id 与 label，行几何照抄。
5. **AssistBlock（可复制诊断 prompt + 重检按钮）**：若 CPA 有"配置错了怎么让 agent 帮查"的场景，结构照抄，prompt 文案与 reason code 换成 CPA 自己的。
6. **自绘图标**：灯泡/硬币的 path 不要抄；若 CPA 需要宿主 188 图标里没有的形状（如"中转/网关/钥匙"），按 ②2.4 规则新画。

### 3.3 丢弃（与 CPA 中转模式无关）

1. 整套 `credential/`（读桌面 App 登录文件、Electron 解密、自留副本、token 刷新）——本机凭证模式，CPA 中转不需要。
2. `probe/`（推理档位探测）、`llm/shim`、`catalog/` 的 live→saved→fallback 降级链业务逻辑（骨架思路可借，代码不搬）。
3. `panels.tsx` 里 WorkBuddy 专属 badge 映射（`限时免费`/`夜间折扣`/`Free now`）与 enterprise 套餐过滤。
4. `credit-label` 的"共消耗 X"逐消息成本标签（除非 CPA 也要做按消息计费观测）。
5. `AssisBlock` 的 `electron-binary-not-found` 等 5 个 reason code（本机凭证专有）。
6. 双变体（国内版/国际版）卡片 `CARD_VARIANTS` 结构。

---

## 附：一句话压缩结论

DSH 没有公开设计规范站，"官方风格" = `@deepseek-ai/dsh-client-ui-primitives` 这组零 cordis React atoms + 一套 `--dsw-alias-*` 语义化 CSS token（label 四档墨色 / border l1-l3 / radius sm-md-lg / focus-ring / elevation / menu 皮肤成对出现）+ `ic_ds_*` 188 个 16 栅格图标。bridge 的贴合策略可浓缩为一句：**壳全部借宿主（DisclosureRow 做卡片、SettingsForm 做表单、28px iconButton 做 composer 控件、portal+token 皮肤做 popover），样式只写 token 不写色值，图标只画 currentColor 自绘，错误不擦屏、未知不摆假值**——这套做法（②2.1-2.6 与 ③3.1 十条）对 dsh-cpa-panel 是近乎零成本的直接复用。
