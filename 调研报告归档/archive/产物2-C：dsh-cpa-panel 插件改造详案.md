# 产物 2-C：dsh-cpa-panel 插件改造详案

- 日期：2026-10-03 ｜ 性质：只读设计与文档，不改任何代码
- 地位：三份详案中最重要者——DSH 插件是**唯一 UI 与开箱即用载体**。本文可直接上手。
- 方向（已锁定，不可推翻）：主功能=养号自动化；独立调用单元 `units[]`；养号开关 autoCheckin 默认开 / autoTasks 默认关 / normalizeSchedulerMode 默认开；思考强度全局默认 medium、每单元可覆盖；CPA 内置 UI 全删、唯一 UI=插件页；宿主半端照 dsh-workbuddy-bridge 模板 TS 化、client.js 保留 JS 改造、schemastery 配置表单；进程托管 Job Object 父退子亡 + 退避重启 + 非 shell spawn；首启自动写最小 config.yaml（随机 secret-key）+ 拉取/校验 exe 与 dll（SHA-256）；DSH 宿主零改动。
- 一致性约定：管理端点前缀 `/v0/management/plugins/<provider>/{checkin,tasks,...}`；`units[].apiKey` 与产物 2-A 的 key→unit 映射同名字段；`config.yaml` 字段（`management.secret-key` / `plugins.enabled` / `oauth.auth-dir` / `checkin_auto` / `tasks_auto` / `disable-control-panel` 恒 true）与产物 2-A 一致。

---

## 1) 最终定位 + 目标目录树

**一句话定位**：dsh-cpa-panel 是 CPA（CLIProxyAPI）的**唯一控制台与养号自动化载体**——在 DSH 里托管 CPA 进程、按 `units[]` 声明的"渠道×账号×模型"独立单元自动签到/跑任务/锁定单账号，配置与状态全部走 DSH 插件页，CPA 自带 Web UI 弃用。

```
dsh-cpa-panel/
├── package.json                 # 重写（见 §5/§6）
├── tsconfig.json                # 宿主半端 TS 配置（ESM，NodeNext）
├── tsconfig.client.json         # 浏览器半端配置（仅语法检查 client.js，不产出）
├── tsdown.config.ts             # 双配置：宿主 ESM lib/index.js + lib/*.d.ts；浏览器 CJS bundle
├── vitest.config.ts             # 单测（units 校验/config 生成器/adapters 纯函数）
├── cordis.patch.yml             # 照旧：insert 一行 id=name=dsh-cpa-panel
├── icon.svg                     # 照旧
├── src/
│   ├── index.ts                 # 宿主入口：name/inject/Config/apply/路由注册（原 index.js→TS）
│   ├── adapters.ts              # 四渠道差异层（原 adapters.js→TS）
│   ├── units.ts                 # 【新】Unit 类型 + units[] 校验 + key→unit 映射
│   ├── process.ts               # 【新】进程托管：Job Object/非 shell spawn/退避重启/父退子亡
│   ├── bootstrap.ts             # 【新】首启：定位 exe/dll、SHA-256 校验、生成最小 config.yaml
│   ├── client/
│   │   └── client.js            # 浏览器半端：保留 JS 改造（不 TS 化，路径 B）
│   └── locale/
│       ├── zh.json              # 双层 locale：包元数据（卡片标题/描述）
│       └── en.json
└── README.md
```

**依赖清单（package.json）**：

| 类别 | 包 | 版本约束 | 说明 |
|---|---|---|---|
| peerDependencies | `@deepseek-ai/cordis` | `^4.0.1`（对齐宿主 fork，自带 .d.ts） | 宿主框架 |
| peerDependencies | `@deepseek-ai/dsh-credentials` | `>=0.1.7-rc.2`（沿用） | credentialRef |
| peerDependencies | `@deepseek-ai/schemastery` | `^3.18.4`（沿用） | Config schema |
| dependencies | `@deepseek-ai/dsh-client-ui-primitives` | 与宿主对齐 | client.js require 目标；同时补进 `dsh.client.inject` |
| dependencies | `@deepseek-ai/dsh-atomic-write` | 与宿主对齐 | config.yaml / stamp 文件原子写 |
| devDependencies | `typescript` / `tsdown` / `vitest` / `eslint` / `prettier` / `@types/node` | latest | 工具链 |

> client.js 不进 TS/打包工具链（路径 B）；`tsdown` 双配置只产出宿主 ESM + d.ts，浏览器半端 client.js 原样 `exports`，由 DSH `__ModuleLoader__` 加载。

---

## 2) 删 / 留 / 改逐项清单（文件级）

### 2.1 `index.js`（1017 行）→ `src/index.ts`

**留（按养号主线）的上游调用与函数**：

| 原函数/调用 | 处置 | 去向 |
|---|---|---|
| `Config` schema（57-72） | **改**（扩字段，见 §6） | `src/index.ts` Config |
| `cpaFetch`（168） | 留，TS 化 | `src/index.ts` |
| `probePort`/`waitForPort`（132/150） | 留，升级为 healthz/readyz 轮询 | `src/index.ts` + `process.ts` |
| `resolveExe`/`defaultExeCandidates`（265/84） | **改**：接入 `bootstrap.ts` 的校验链 | `bootstrap.ts` |
| `ensureRunning`/`stopIfOwned`（275/321） | **改**：迁入 `process.ts`，换 Job Object 托管 | `process.ts` |
| `runStartupCheckin`（340） | 留，作为 autoCheckin 首启补签 | `src/index.ts` |
| 路由 `GET /status`、`GET /plugins`、`GET /accounts`(含 credits join)、`POST /start`、`POST /action`(checkin/tasks/tasks-run)、`GET/POST /auto-checkin`、`POST /scheduler-mode`、`POST /account-enabled` | **留**（养号主线） | 路由表照旧 |
| `autoCheckin`（552） | 留 | 路由层 |

**删（与养号主线无关）**：

| 原路由/函数 | 处置 |
|---|---|
| `GET /api/v1/cpa/school` → `school()`（607） | **删**（开学季券码，养号主线外） |
| `modelsOf`（578）→ `/models/groups?refresh=1` | **留但降级**：仅用于单元 model 下拉选项，不再做面板模型清单 |
| `routingGet`/`routingSet`（624/698）→ `GET/PUT /routing/strategy` | **删**（路由策略全局设置收进 config.yaml，不再暴露 UI） |
| `priorityGet`/`prioritySet`（729/770）→ `/priority` 路由 | **删**（顺序由 units[] 声明决定，不再拖拽/手动排序） |
| `activeAuthOf`（485）→ 活跃检测 | **删**（养号主线不需要"谁在用"观测） |
| `refresh` 类 action（ACTION_PATHS.*.refresh） | **留端点但不暴露按钮** |

**新增（TS，新文件）**：

| 新能力 | 落点 |
|---|---|
| units[] 校验 + key→unit 映射 | `src/units.ts` |
| dll 拉取 + SHA-256 校验 | `src/bootstrap.ts` |
| config.yaml 生成器（随机 secret-key） | `src/bootstrap.ts` |
| 进程托管（Job Object / 非 shell spawn / 退避重启） | `src/process.ts` |
| healthz/readyz 轮询 | `src/process.ts` + `src/index.ts` |
| 新宿主路由 `GET /api/v1/cpa/units`：units[] 配置 × live accounts/credits join | `src/index.ts` 路由表 |

### 2.2 `adapters.js`（313 行）→ `src/adapters.ts`

- `PLUGIN_ADAPTERS`/`PLUGIN_ORDER`/`ACTION_PATHS`/`AUTO_CHECKIN_PATHS`/`PLUGIN_CONFIG_PATH`/`SCHEDULER_MODE`/`normalizeAccounts` 全部 TS 化。
- 补类型：`PluginAdapter`、`CreditEntry`、`NormalizedAccount`、`ChannelId`。
- 删：`school` 相关能力位（`capabilities.school`）；`import/trial/release/claim*` 等备用 action 若 UI 不用则**留但不导出路由**。

### 2.3 `client.js`（1111 行）→ `src/client/client.js`（保留 JS 改造）

**保留**：状态条（StateDot+端口+启动按钮+无密钥警告）、渠道 Pill 组、账号卡（昵称/余额数字/签到徽标/包数 meta）、单账号签到/任务按钮、启用/禁用按钮、**批量签到/任务按钮（配 Modal 确认）**、自动签到 Switch。

**删除**：拖拽排序（`buildCard` 的 DnD 段 697-741、`⠿` 把手、`RoutingSection` 615-869 整体）、汇总条 cpa-sum（477-493）、额度进度条 cpa-bar（372-375）、使用中提示行（543-555）、自绘 toast 硬编码色（588-593）。

**改造**：primitives import 补 `Modal`/`Checkbox`/`writeClipboard`（现仅解构 5 件，:35-39）；错误色 `#2ea043/#d1242f` → `--dsw-alias-state-error-primary` / `--dsw-alias-state-business-primary`；错误改"行内错误条 + role=status"，整屏 error 改"保留数据+顶部错误条"；账号卡壳可换 `DisclosureRow`；新增单元行渲染（channel/authRef/model/启用 Switch/状态徽标）。

### 2.4 locale 双层（照 bridge）

- `src/locale/{zh,en}.json` = 包元数据（卡片 title/description，现有内容保留）；
- UI 文案仍 `ctx.locale.register(NS,{zh,en})` 内联（现状 client.js:1057），不拆出 JSON。

---

## 3) 改名映射表（原 → 新）

| 原（client.js / index.js） | 新（TS） | 说明 |
|---|---|---|
| index.js `apply(ctx, refs)` | `src/index.ts` `apply(ctx, refs)` | 签名不变 |
| index.js `cpaFetch` | `src/index.ts` `cpaFetch(options, path, init)` | 加类型 |
| index.js `accountsOf` | `src/index.ts` `fetchAccounts(plugin)` | 重命名直白化 |
| index.js `action` | `src/index.ts` `runAction(plugin, kind, authIndex?)` | — |
| index.js `autoCheckin` | `src/index.ts` `getSetAutoCheckin(plugin, …)` | — |
| index.js `schedulerModeNormalize` | `src/index.ts` `normalizeSchedulerMode()` | — |
| index.js `accountEnabled` | `src/index.ts` `setAccountEnabled(plugin, authIndex, enabled)` | — |
| index.js `ensureRunning`/`stopIfOwned` | `src/process.ts` `startCpa()`/`stopCpa()`/`restartWithBackoff()` | 迁入进程托管 |
| index.js `resolveExe`/`defaultExeCandidates` | `src/bootstrap.ts` `locateExe()`/`verifyDll()`/`writeMinimalConfig()` | 首启链 |
| adapters.js `normalizeAccounts` | `src/adapters.ts` 同名 | 加返回类型 |
| adapters.js `PLUGIN_ADAPTERS` | `src/adapters.ts` 同名 + `PluginAdapter` 类型 | — |
| （新）— | `src/units.ts` `Unit` 类型、`validateUnits(raw)`、`keyToUnit(apiKey)`、`joinUnitsWithAccounts(units, live)` | key→unit 映射 |
| client.js `Panel`/`PluginPanel`/`AccountCard` | `src/client/client.js` 同名（JS 不改名） | — |
| client.js `RoutingSection` | **删** | 见 §4 |

---

## 4) 废接口 / 废函数清单

| 项 | 处置 |
|---|---|
| `RoutingSection`（client.js:615-869，含拖拽 DnD `onDragStart/Over/Drop/End`、`buildCard`、`move`、`saveOrder`） | **删**（顺序改由 units[] 声明） |
| `POST /api/v1/cpa/priority` 路由 + `priorityGet/prioritySet` | **删** |
| `GET/PUT /api/v1/cpa/routing` 路由 + `routingGet/routingSet` | **删** |
| `GET /api/v1/cpa/school` + `school()` | **删** |
| `activeAuthOf`（活跃检测） | **删** |
| 自绘 toast div（client.js:588-593）+ 硬编码色 CSS（:1009-1010） | **删**（改行内错误条） |
| 汇总条 cpa-sum / 进度条 cpa-bar | **删** |
| `modelsOf` 面板模型清单 UI | **留函数，不渲染面板**（仅单元 model 下拉取选项） |
| `ACTION_PATHS.*.refresh / trial / import / release / claim*` | **留但不导出路由**（代码保留，UI 不暴露） |

---

## 5) 依赖处理与工程约束

- **peer/inject**：cordis 本体不进 dependencies（宿主注入）；`@deepseek-ai/dsh-client-ui-primitives` 既写 dependencies 又**补进 `package.json` 的 `dsh.client.inject`**（现漏列，client.js 却 require——必补）。
- **cordis.patch.yml 两常量**：照 bridge 红线——`ENTRY_ID`（=patch insert id = 设置命名空间）与 `BUNDLE_NAME`（=pkg.name = slots key）分开钉。本仓当前两者恰好都是 `dsh-cpa-panel`，仍按 bridge 方式显式分两常量，防日后改名踩坑。
- **lockfile 坑**：插件必须落在 profile `node_modules/` 真实目录、不用 `link:` 外指（README 实测坑）；TS 产物 `lib/*.js` + `*.d.ts` 随 `files` 发布；client.js 原样发布不打包。
- **DSH 宿主零改动**：`cordis.patch.yml` 机制照旧，不要求宿主侧任何补丁。

---

## 6) schemastery schema 全字段清单

> 全部 `.volatile()`；类型/默认/必填逐条标注。units[].apiKey 与产物 2-A 的 key→unit 映射同名字段对齐。

### 6.1 连接与生命周期

| 字段 | 类型 | 默认 | volatile | 说明 |
|---|---|---|---|---|
| `adminKey` | `z.string().role('secret')` | `''` | ✓ | CPA management 密钥（留空走凭据引用） |
| `adminKeyRef` | `z.string().role('credential-ref')` | `'CPA_ADMIN_KEY'` | ✓ | 凭据库引用名 |
| `port` | `z.natural().min(1).max(65535)` | `8317` | ✓ | CPA 监听端口 |
| `exePath` | `z.string()` | `''` | ✓ | 空=自动定位+校验 |
| `manageLifecycle` | `z.boolean()` | `true` | ✓ | 进程托管开关 |
| `startTimeoutSeconds` | `z.natural().min(3).max(180)` | `30` | ✓ | 探活超时 |
| `openControlPanel` | — | — | — | **删**（CPA 内置 UI 全弃） |

### 6.2 units[]（独立调用单元）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `units` | `z.array(z.object({…}))` | `[]` | 单元列表 |
| `units[].channel` | `z.union([workbuddy,trae,qoder,zcode])` | — | 渠道 |
| `units[].authRef` | `z.string()` | — | auth 文件 id/label（与 `/accounts[].auth_id` join） |
| `units[].model` | `z.string()` | `''` | 空=跟随渠道默认 |
| `units[].enabled` | `z.boolean()` | `true` | = auth-files/status.disabled 的反向 |
| `units[].apiKey` | `z.string().role('secret')` | `''` | **每单元独立 API key**（与产物 2-A key→unit 映射同名字段） |
| `units[].reasoningEffortDefault` | `z.union([auto,off,low,medium,high])` | `'auto'` | 覆盖全局默认 |

### 6.3 养号开关与检查项

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `autoCheckin` | `z.boolean()` | **`true`** | 自动签到（含首启补签） |
| `autoTasks` | `z.boolean()` | **`false`** | 定时跑成长任务 |
| `normalizeSchedulerMode` | `z.boolean()` | **`true`** | 启动时归一 scheduler_mode=off |
| `reasoningEffort`（全局） | `z.union([…同上])` | **`'medium'`** | 全局思考强度默认，单元可覆盖 |

### 6.4 首启生成的 config.yaml 字段（与产物 2-A 一致）

`management.secret-key`（随机生成）/ `plugins.enabled`（按 units[].channel）/ `oauth.auth-dir` / `checkin_auto`（随 autoCheckin）/ `tasks_auto`（随 autoTasks）/ `disable-control-panel: true`（恒 true，内置 UI 弃）。

---

## 7) 验证点条目清单

1. **TS 编译与 dts**：`tsc --noEmit` 零错；`tsdown` 产出 `lib/index.js`(ESM)+`lib/index.d.ts`；client.js 不参与编译，原样落在 `lib/client/client.js`。
2. **schema 表单自动渲染**：`Config` 全 volatile，宿主设置页自动出全部字段（含 units[] 数组行），改值不重挂插件，`refs.x.get()` 现读。
3. **首启状态机**：定位 exe→SHA-256 校验→写最小 config.yaml（随机 secret-key）→spawn 拉起→healthz/readyz 探活→状态条回显"运行中"，任一步失败状态条挂对应原因。
4. **Job Object 父退子亡**：DSH 退出后 CPA 子进程被回收（不残留 cli-proxy-api.exe），非 shell spawn、`windowsHide`、代理变量清空。
5. **dll SHA-256 失败路径**：校验不过则不拉起，状态条报"dll 校验失败"，不静默用旧文件。
6. **探活退避**：拉起后按 400ms 间隔轮询端口直到 startTimeout；启动失败退避重启不打死循环。
7. **单元列表 join**：`GET /api/v1/cpa/units` 返回 units[] 配置与 live accounts/credits 按 (channel,authRef) join，余额/签到徽标正确落行。
8. **批量签到 Modal**：点"全部签到"先弹 Modal 确认"N 个账号"，确认后逐账号 POST checkin，行级 busy 锁，失败行内错误条不擦屏。

---

## 8) 风险与回滚（按阶段）

| 阶段 | 风险 | 回滚 |
|---|---|---|
| **TS 迁移期** | tsdown 双配置产物形态不对 / neverBundle 漏打 react 导致体积爆炸；`client.js` require 的 primitives 注入不全 | git 回到 7da7da8；宿主半端先维持 JS 再分批 TS 化；primitives 注入靠 `dsh.client.inject` 补列兜底 |
| **首启初始化期** | 自动写 config.yaml 覆盖用户已有配置；随机 secret-key 与用户 CPA 原 key 不符导致 401；SHA-256 源不可达 | 生成前备份原 config.yaml（`.bak`）；`manageLifecycle=false` 关掉进程托管即退化为纯 UI；secret-key 写入后回读并回显到 status 供用户配 adminKeyRef |
| **UI 改造期** | 删拖拽/汇总条后用户找不到原功能；Modal/错误条样式与宿主脱节 | 旧 client.js 保留为 `client.legacy.js` 随时切回；删项分批开关（feature flag），不一次全切 |

---

## 附：一句话压缩

dsh-cpa-panel 改造 = 宿主半端 `index.ts/adapters.ts/units.ts/process.ts/bootstrap.ts` 照 bridge 模板 TS 化（Job Object 托管+首启校验+config 生成），client.js 保留 JS 改造（养号面板+Modal+token 化，删拖拽/汇总/进度条/路由/学校/活跃检测），配置走 schemastery（连接/units[]/养号开关/思考强度），CPA 内置 UI 全弃、DSH 宿主零改动；验证聚焦首启状态机、父退子亡、SHA-256 失败路径、单元 join 与批量签到 Modal。

注：R13 已并入——宿主内置 provider 族删除为宿主侧动作（见《产物2-融合》§11 R13），本插件无影响；bridge 工程骨架照搬但依赖清单不抄（cpa-panel 只需 cordis/credentials/schemastery + primitives + atomic-write，见融合 §11 主代理核查 4）。
