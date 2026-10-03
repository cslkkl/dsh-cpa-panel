# dsh-cpa-panel 解剖与 TS 迁移评估

- 仓库：`dsh-cpa-panel` @ `7da7da8`（https://github.com/cslkkl/dsh-cpa-panel）
- 分支 / 提交：`main` @ `7da7da8`（"feat: DSH 插件 —— 在 DSH 里管理 CLIProxyAPI 账号"），工作区即该提交，无未提交改动
- 包名：`dsh-cpa-panel@0.1.0`（MIT，ESM）
- 性质：DeepSeek Harness（DSH，一个 Cordis 应用）插件，充当 CLIProxyAPI（下称 CPA）的**管理界面**；不含 CPA 本体
- 调研方式：纯只读（未改任何文件，未跑任何会改变仓库状态的命令）；TS 框架侧结论来自 npm registry 实时元数据

---

## 0. 一句话架构

插件分**两半**：

| 半端 | 文件 | 运行环境 | 职责 |
|---|---|---|---|
| 宿主半端 | `index.js` + `adapters.js` | DSH 主进程（Node ESM） | 持有 CPA 管理密钥、启停 CPA 子进程、把 `/api/v1/cpa/*` 请求转发到 `127.0.0.1:<port>` 的 CPA |
| 浏览器半端 | `client.js` | DSH 内置 webview（自定义 CJS 加载器） | 面板 UI；只调宿主自己的 `/api/v1/cpa/*`，**永远拿不到管理密钥** |

---

## 1. 文件级解剖

### 1.1 逐文件职责

| 文件 | 行数 | 职责 |
|---|---|---|
| `package.json` | 51 | 包元信息；`"type":"module"`；`exports` 暴露 `./index.js`、`./client`、`./locale/*.json`；DSH 专用字段 `dsh`（见 1.2）；**没有 `scripts`、没有 `dependencies`**，只有两个 `peerDependencies` |
| `index.js` | 1017 | **宿主半端全部逻辑**：生命周期（随 DSH 启停 CPA）、开机补签、12 条 HTTP 路由、密钥解析。导出 Cordis 插件契约：`ENTRY_ID`、`name='cpa-panel'`、`inject=['credentials']`、`Config`（schemastery schema）、`apply(ctx, refs)` |
| `adapters.js` | 313 | **四渠道差异收敛层**：`PLUGIN_ADAPTERS`（workbuddy/trae/qoder/zcode 的能力声明 + 余额/签到解析器）、`ACTION_PATHS`（写操作路径表）、`AUTO_CHECKIN_PATHS`、`normalizeAccounts()`（把各家返回合并成统一形状）。纯数据 + 纯函数，无副作用 |
| `client.js` | 1111 | **浏览器半端 UI**。不是普通 ESM，而是 `window.__ModuleLoader__.load({id, factory:(require)=>{…}})` 包起来的**单文件 CJS bundle**；内部手写 `module/exports` shim，`require('react')` 与 `require('@deepseek-ai/dsh-client-ui-primitives')` 由宿主冻结的 `PLATFORM_MODULES` 注入。导出 `apply(ctx)` 与 `inject=['slots','locale']` |
| `cordis.patch.yml` | 9 | DSH bundle patch：往 profile 的 loader 行里插入一行 `{id: dsh-cpa-panel, name: dsh-cpa-panel}`（见 1.2） |
| `locale/zh.json` / `locale/en.json` | 各 6 行 | 仅 `meta.title` / `meta.description`，供插件卡片显示。**注意：UI 内文案并不读这两个文件**——`client.js:52-174` 把 zh/en 字典硬编码在 bundle 里，再经 `ctx.locale.register(NS,{zh,en})` 注册；JSON 文件只喂宿主卡片 |
| `icon.svg` | 6 | 64×64 圆角蓝底 "CPA" 图标 |
| `README.md` / `LICENSE` | — | 文档与 MIT 许可 |
| `.gitignore` | — | 忽略 `node_modules/`（本地 junction）、`AGENTS.md`、编辑器噪音 |

### 1.2 Cordis 生命周期接入点

**package.json 里没有 `"cordis"` 或 `"koishi"` 字段**；DSH 的接入约定是自定义字段 `dsh`（`package.json:35-46`）：

```jsonc
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },          // 宿主半边：加载哪个 patch
  "client": {
    "platform": "web",
    "inject": ["@deepseek-ai/dsh-client-ui-settings",
               "@deepseek-ai/dsh-client-ui-plugin-manager"] // 浏览器半边挂载点
  }
}
```

- **main 入口**：`exports["."] = ./index.js`（`package.json:19-24`）。DSH loader 加载 index.js 后，按 Cordis 约定读取具名导出：
  - `name`（`index.js:36`）= `'cpa-panel'`（loader 诊断名）
  - `inject`（`index.js:45`）= `['credentials']`——声明依赖凭据服务；缺它插件不挂
  - `Config`（`index.js:57-72`）——schemastery schema，DSH 据此生成设置表单
  - `apply(ctx, refs)`（`index.js:209`）——主安装函数
- **`cordis.patch.yml` 是什么**：DSH 的 **bundle patch 配置**。DSH 把每个插件当作 profile loader 里的一行；这个 yml 顶层是 patch 条目数组，这里只有一条 `insert`：把 `id/name: dsh-cpa-panel` 追加进 profile 的 loader 行。`name` 必须能从 profile 的 `node_modules` 解析到本包（README:47-49 解释了为什么必须是真实目录、不能 `link:`）。
- **设置命名空间**：`ENTRY_ID='dsh-cpa-panel'`（`index.js:33`）。注释（`index.js:32`）说明 0.1.7 起这行 loader id 同时就是设置节名。

### 1.3 用到的 Cordis / DSH API（穷尽核对）

宿主半端（`index.js`）：

| API | 位置 | 用途 |
|---|---|---|
| `ctx.effect(fn, traceId)` | `index.js:377`、`398` | 注册生命周期 effect；返回清理函数做卸载 |
| `ctx.inject(['connection'], cb)` | `index.js:397` | 按需注入 HTTP 服务（与 `credentials` 解耦：缺 connection 只丢 HTTP 半边，不连累生命周期） |
| `connectionCtx.connection.fetch.register({path, methods, requestBody:'buffered', fetch})` | `index.js:997-1004` | 注册浏览器路由；返回 disposer 数组，卸载时逐个调 |
| `ctx.credentials.resolve(credentialRef(name))` | `index.js:240` | 从凭据库解析 `CPA_ADMIN_KEY`（`credentialRef` 来自 `@deepseek-ai/dsh-credentials`） |
| `ctx.logger?.info/warn` | `index.js:384,386` | 日志 |

浏览器半端（`client.js`）：

| API | 位置 | 用途 |
|---|---|---|
| `ctx.locale.register(ns,{zh,en})` / `ctx.locale.bind(ns)` | `client.js:1057-1058` | 注册并绑定文案字典 |
| `ctx.slots.inject(slotName, factory)` | `client.js:1074,1092` | 往两个槽位注入内容 |
| `ctx.slots.register({name,id,order,locale}, render)` | `client.js:1075,1093` | 具体注册一个区块；`seat.subject.pkg.name` 判断是不是本插件详情页（`client.js:1067-1072`） |

**明确没有用到**：`ctx.command`（无 CLI 命令）、`ctx.http`（宿主直接用全局 `fetch`）、数据库（无）、中间件/`ctx.on('middleware')`（无）。路由全部走 `connection.fetch.register`。

### 1.4 依赖与版本

`package.json:47-50` —— **无 `dependencies`**，只有两个 `peerDependencies`：

| 包 | 版本约束 | 来源 |
|---|---|---|
| `@deepseek-ai/dsh-credentials` | `>=0.1.7-rc.2` | package.json:48 |
| `@deepseek-ai/schemastery` | `^3.18.4` | package.json:49 |

其余运行时依赖（`react`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/cordis` 本体、node 内置模块）全部由 **DSH 宿主运行时注入**，不在本包声明——这也是为什么 `node_modules/` 是指向 DSH profile 的 junction（`.gitignore` 注释）。

> **关于 cordis 版本号**：本包**不直接依赖 cordis**，因此 package.json 里没有 cordis 版本。宿主侧实际承载者是 DSH fork `@deepseek-ai/cordis`。npm registry 最新版为 **4.0.4**（`{"types":"lib/types/index.d.ts"}`，`type:module`，仓库 deepseek-ai/deepseek-harness 的 `vendor/cordis`）["https://registry.npmjs.org/@deepseek-ai%2fcordis/latest"]；上游框架 `cordis@4.0.0-rc.10`（cordiverse）同样自带 `lib/index.d.ts`["https://registry.npmjs.org/cordis/latest"]。社区其它 DSH 插件（如 `@vongostev/dsh-cross-session`）把 `@deepseek-ai/cordis@^4.0.1` 列为 peerDependency["https://www.npmjs.com/package/@vongostev/dsh-cross-session"]，可作版本对齐参考。

---

## 2. 功能 → 代码 → HTTP 调用映射

### 2.0 公共约定（所有宿主→CPA 请求）

- **baseURL**：`http://127.0.0.1:<port>`，在 `cpaFetch()`（`index.js:168-169`）里拼；`port` 来自配置项（默认 8317）。
- **认证头**：`authorization: Bearer <adminKey>`（`index.js:171`）。
  - token 类型：CPA 管理密钥的 Bearer token；
  - 获取优先级（`resolveAdminKey`，`index.js:234-246`）：配置项 `adminKey` 显式值 → 凭据库引用 `adminKeyRef`（默认名 `CPA_ADMIN_KEY`）→ 空（空密钥时写操作一律 `no-admin-key` 报错，不静默失败）；
  - **无硬编码密钥**；仅在启动时解析一次缓存（`index.js:249`），凭据轮换下次 apply/重启生效。
- **其余头**：有 body 时加 `content-type: application/json`（`index.js:172`）；`AbortSignal.timeout(20000)`（`index.js:178`）。
- **写操作 body 形状**：无账号维度时 `'{}'`；指定账号时 `{"auth_index": <n>}`（`index.js:458-461`）。

### 2.1 宿主→CPA 请求全清单（可直接拿去 Go 仓库定位 handler）

| # | Method | 完整 path | 触发位置（文件:函数:行） | query / body | 用途 |
|---|---|---|---|---|---|
| 1 | GET | `/v0/management/plugins/{plugin}/accounts` | index.js `accountsOf`:414；另被 `autoCheckin`:560、`priorityGet`:733、`prioritySet`:775 复用 | — | 账号名单（不含余额）；顺带读顶层 `checkin_auto`、`schedule`、`server_time` |
| 2 | GET | `/v0/management/plugins/{plugin}/credits` | adapters.js `creditsPath()`:49/99/149/181，调用处 index.js:418 | 不带 auth_index，一次返回全部 | 余额（积分或 token） |
| 3 | GET | `/v0/management/auth-files` | index.js `activeAuthOf`:487；`priorityGet`:732；`prioritySet`:774；`accountEnabled`:826 | — | 凭据文件表：`priority`、`disabled`、`recent_requests`、`success` |
| 4 | GET | `/v0/management/plugins/zcode/models`（zcode）<br>其它：`/v0/management/plugins/{plugin}/models/groups?refresh=1` | index.js `modelsOf`:583-586 | zcode 无 query；其余**必须带 `?refresh=1`** | 模型目录展示 |
| 5 | GET | `/v0/management/plugins/workbuddy/school/vouchers` | index.js `school`:611 | — | 开学季券码（仅 workbuddy） |
| 6 | GET | `/v0/management/routing/strategy` | index.js `routingGet`:628；`routingSet` 回读:709 | — | 读路由策略 |
| 7 | GET | `/v0/management/plugins/{plugin}/config` | index.js `routingGet`:640、`schedulerModeNormalize`:669 | — | 读 `scheduler_mode` |
| 8 | POST | `/v0/management/plugins/{plugin}/checkin` | index.js `action`:463（路径表 ACTION_PATHS adapters.js:207/214/219）；开机补签 index.js:360 | body `{}`（全部）或 `{"auth_index":n}`（单账号） | 签到 |
| 9 | POST | `/v0/management/plugins/workbuddy/tasks/run` | 同上（adapters.js:208） | 同上 | 一键任务（仅 workbuddy） |
| 10 | POST | `/v0/management/plugins/{plugin}/refresh` | adapters.js:209/215/220/225 | body `{}` 或 `{"auth_index":n}` | 刷新（四渠道都有） |
| 11 | POST | 其它白名单动作：`/workbuddy/trial`、`/workbuddy/import`、`/trae/release`、`/qoder/import`、`/qoder/claim-pro`、`/zcode/claim` | adapters.js `ACTION_PATHS`:205-228，统一经 index.js `action`:450 | 同上 | 预留/备用动作（面板主 UI 未直接暴露） |
| 12 | PATCH | `/v0/management/plugins/{plugin}/config` | index.js `autoCheckin`:565 | body `{"checkin_auto":bool}` | 写自动签到开关（workbuddy/qoder） |
| 13 | PATCH | `/v0/management/plugins/{plugin}/config` | index.js `schedulerModeNormalize`:676 | body `{"scheduler_mode":"off"}` | 归一调度模式（改完需重启 CPA） |
| 14 | PUT | `/v0/management/routing/strategy` | index.js `routingSet`:705 | body `{"value":"fill-first"\|"round-robin"\|"weighted-round-robin"}` | 写路由策略 |
| 15 | PATCH | `/v0/management/auth-files/fields` | index.js `prioritySet`:795 | body `{"name":<凭据文件名>, "priority":<100/90/…>}` | 写账号优先级（**必须走接口，改 JSON 文件不生效**，注释 index.js:756-769） |
| 16 | PATCH | `/v0/management/auth-files/status` | index.js `accountEnabled`:832 | body `{"name":<凭据文件名>, "disabled":bool}` | 启用/禁用账号（`enabled=true` ⇒ `disabled=false`） |

> 禁用/启用实现细节（`accountEnabled`，index.js:821-840）：先 GET `/auth-files` 按 `auth_index` 反查出凭据文件名 `name`，再 PATCH status。`{plugin}` 取值即渠道 id：`workbuddy` / `trae` / `qoder` / `zcode`（顺序表 `PLUGIN_ORDER`，adapters.js:202）。

### 2.2 浏览器→宿主路由（相对路径，`credentials:'include'`，无 Authorization 头）

注册处：`routes` 数组 `index.js:842-995`，统一经 `connection.fetch.register`（`index.js:997`）。

| Method | path | 宿主处理函数 | 浏览器侧调用点（client.js） |
|---|---|---|---|
| GET | `/api/v1/cpa/status` | index.js:844 | Panel:888 |
| GET | `/api/v1/cpa/plugins` | index.js:863 | Panel:889 |
| GET | `/api/v1/cpa/accounts?plugin=` | index.js:878 → `accountsOf` | PluginPanel.load:396 |
| GET | `/api/v1/cpa/models?plugin=` | index.js:886 → `modelsOf` | （面板未调用，预留） |
| GET | `/api/v1/cpa/school` | index.js:894 → `school` | （面板未调用，预留） |
| GET/POST | `/api/v1/cpa/routing`（POST body `{strategy}`） | index.js:899 → `routingGet`/`routingSet` | RoutingSection.load:631 |
| POST | `/api/v1/cpa/scheduler-mode` | index.js:919 → `schedulerModeNormalize` | （面板未直接调用，预留） |
| GET/POST | `/api/v1/cpa/priority?plugin=`（POST body `{order:[昵称…]}`） | index.js:924 → `priorityGet`/`prioritySet` | RoutingSection:635/658 |
| POST | `/api/v1/cpa/action` body `{plugin,kind,authIndex?}` | index.js:940 → `action` | `act()`:192（签到/任务/刷新/单账号操作统一走这里） |
| POST | `/api/v1/cpa/account-enabled` body `{plugin,authIndex,enabled}` | index.js:959 → `accountEnabled` | `setAccountEnabled()`:208 |
| GET/POST | `/api/v1/cpa/auto-checkin?plugin=`（POST body `{enabled}`） | index.js:972 → `autoCheckin` | PluginPanel:398/456 |
| POST | `/api/v1/cpa/start` | index.js:988 → `ensureRunning` | Panel.start:901 |

### 2.3 功能对照速查

| 功能 | 宿主函数 | 落到 CPA 的请求 |
|---|---|---|
| 账号列表 + 余额（可用/已用/额度池/套餐包数，token 与积分分算） | `accountsOf` index.js:408 + `normalizeAccounts` adapters.js:280 | #1 + #2（积分/token 差异由各 adapter `parseCredits` 吸收） |
| 活跃账号检测 | `activeAuthOf` index.js:485 | #3（读 `recent_requests` 统计，不打上游） |
| 一键签到 / 一键任务 / 刷新（全部） | `action(plugin,kind)` index.js:450，无 authIndex | #8/#9/#10，body `{}` |
| 每账号单独签到/任务 | 同上，带 authIndex | body `{"auth_index":n}` |
| 启用/禁用账号 | `accountEnabled` index.js:821 | #3 反查 + #16 |
| 账号排序（拖动） | `priorityGet/prioritySet` index.js:729/770 | #3 + #1（反查昵称）→ #15 |
| 自动签到开关 | `autoCheckin` index.js:552 | 读 #1 顶层 `checkin_auto`；写 #12 |
| 开机补签 | `runStartupCheckin` index.js:340 | 对支持签到的插件发 #8，当天只补一次（stamp 文件 `~/.dsh/storages/cpa-panel-checkin.json`） |
| CPA 进程启停 | `ensureRunning`/`stopIfOwned` index.js:275/321 | 不发 HTTP；`spawn(exe,['--config','config.yaml','-no-browser'])`，端口探测 `probePort`（index.js:132） |

---

## 3. 插件配置 schema

全部定义在 `index.js:57-72`，用 `@deepseek-ai/schemastery` 的 `z.object({...})`；**每个字段都 `.volatile()`**（理由见注释 index.js:48-56：只有 volatile 字段才进设置表单，且改值不触发插件重挂）。

| 配置项 | 类型 | 默认 | 必填 | 说明 / 硬编码位置 |
|---|---|---|---|---|
| `adminKey` | string（`.role('secret')`） | `''` | 否（留空走凭据引用） | CPA 管理密钥；`index.js:58` |
| `adminKeyRef` | string（`.role('credential-ref')`） | `'CPA_ADMIN_KEY'` | 否 | 凭据库引用名；`index.js:59` |
| `port` | natural 1–65535 | `8317` | 否 | CPA 监听端口；`index.js:60`（常量 `DEFAULT_PORT` index.js:75） |
| `exePath` | string | `''` | 否 | CPA 可执行文件路径；留空则按 `defaultExeCandidates()`（index.js:84-94）探测：`~/CLIProxyAPI/cli-proxy-api.exe`、`~/Desktop/CLIProxyAPI/...`、`~/cpa/...` 及无扩展名变体 |
| `manageLifecycle` | boolean | `true` | 否 | 是否由插件负责 CPA 启停 |
| `autoCheckinOnStart` | boolean | `true` | 否 | 启动时补签 |
| `openControlPanel` | boolean | `false` | 否 | true 则不加 `-no-browser`（index.js:302） |
| `startTimeoutSeconds` | natural 3–180 | `30` | 否 | 等待 CPA 就绪秒数 |

- **DSH 里的配置节名**：`dsh-cpa-panel`（即 loader 行 id，`ENTRY_ID`，index.js:33）。用户在「插件 → CPA 中转站面板」卡片里填；`adminKey` 以 secret 形式渲染，`adminKeyRef` 以凭据引用形式渲染。
- **CPA 地址/凭据默认值**：地址 = `http://127.0.0.1:8317`（端口默认 8317，host 恒为 127.0.0.1，硬编码于 `cpaFetch` index.js:169）；凭据默认引用名 `CPA_ADMIN_KEY`（index.js:59）；**没有任何硬编码的真实密钥**。

---

## 4. JS → TS 迁移评估

### 4.1 现状盘点（package.json 事实）

- `"type": "module"`（ESM），`"main"`/`"exports"` 直指 `./index.js`；**无 `scripts`、无 devDependencies、无构建步骤**；`node_modules/` 不存在（是本地 junction，已 gitignore）。
- 宿主半端（index.js/adapters.js）：纯 ESM，`import`/`export`，**无 `module.exports`、无动态 `require`、无 `this`**。
- 浏览器半端（client.js）：**不是 ESM**——`window.__ModuleLoader__.load({id, factory:(require)=>{…}})` 包裹的 CJS bundle，内部手写 `module={exports:{}}`/`exports`，用宿主注入的 `require('react')`、`require('@deepseek-ai/dsh-client-ui-primitives')`（client.js:16-34）。

### 4.2 框架层面：Cordis 对 TS 的原生支持

**结论：框架原生支持 TS，无需社区 @types。** 证据（npm registry 实时元数据）：

| 包 | 版本 | types 字段 | 来源 |
|---|---|---|---|
| `@deepseek-ai/cordis`（DSH 实际承载） | latest 4.0.4 | `"types":"lib/types/index.d.ts"`，exports 同时声明 `".":{"types":"./lib/types/index.d.ts","default":"./lib/index.js"}` | registry JSON ["https://registry.npmjs.org/@deepseek-ai%2fcordis/latest"] |
| `cordis`（上游 cordiverse） | latest 4.0.0-rc.10 | `"types":"lib/index.d.ts"`，exports 同样带 types 条件 | registry JSON ["https://registry.npmjs.org/cordis/latest"] |

框架本身就是 TypeScript 编写（author Shigma，Koishi 一脉），`Context`/`inject`/`effect`/slots/credentials 服务均带类型。`@deepseek-ai/schemastery` 上游 `@koishijs/schemastery` 同样自带 `.d.ts`。**旁证**：npm 上已存在多个 TS 编写的 DSH Cordis 插件——`dsh-trajectory-pistence`（`src/index.ts` + schemastery）["https://www.npmjs.com/package/dsh-trajectory-persistence"]、`dsh-todo-list`（自带 `.d.ts`）["https://www.npmjs.com/package/dsh-todo-list"]、`dsh-whale-pet-yjj730`（`tsconfig.host.json` CommonJS + `tsconfig.client.json` ESM 双端）["https://www.npmjs.com/package/dsh-whale-pet-yjj730"]，`@xinvxueyuan/cordis-plugin-github` 直接跑 `tsc` typecheck["https://www.npmjs.com/package/@xinvxueyuan/cordis-plugin-github"]。

### 4.3 插件自身代码层面：逐文件改造点

| 文件 | 改造量 | 具体改造点 |
|---|---|---|
| `index.js` → `index.ts` | **小** | ① 引入 `import type { Context } from '@deepseek-ai/cordis'`，给 `apply(ctx, refs)` 标 `ctx: Context`；② `refs` 用 schemastery 的 `Infer<typeof Config>` 推断，`refs.xxx.get()` 返回值自动成型；③ `cpaFetch(options, path, init)` 标 `{port, adminKey, timeoutMs}` 与 `fetch` init 类型；④ `error.status` 自定义属性需 `interface CpaError extends Error { status?: number }`（index.js:190）；⑤ 其余已是 ESM，语法平移 |
| `adapters.js` → `adapters.ts` | **小** | 纯函数最易转：定义 `PluginAdapter`（`label/unit/capabilities/creditsPath/parseCredits/parseCheckin`）、`CreditEntry`、`NormalizedAccount` 接口；`parseCredits(payload)` 的入参是各家不规则 JSON，用 `unknown` + 类型守卫/窄化即可。无框架依赖 |
| `client.js` → ? | **大 / 不建议直接转** | 它消费的是宿主自定义浏览器加载器：`factory(require)` 回调 + 手写 `module/exports` shim + `window.__ModuleLoader__`。原生 TS 编译产物无法被该加载器直接执行——必须经过打包器（esbuild/tsup）输出**保持 `__ModuleLoader__.load({factory})` 包装**的 CJS bundle；且 `require('react')`、`require('@deepseek-ai/dsh-client-ui-primitives')` 是宿主冻结模块表里的符号，需要在打包时标记 external。社区做法（dsh-plugin-worktree）是**手写 `client.d.ts` 配纯 JS client**["http://raw.githubusercontent.com/limoiie/dsh-plugin-worktree/HEAD/docs/development.md"] |
| `locale/*.json` | **不动** | 纯数据；`exports["./locale/*.json"]` 原样保留。注意 client.js 内联字典与这两个文件无关 |
| `cordis.patch.yml` / `icon.svg` | **不动** | 非代码 |

### 4.4 迁移结论

- **纯 TS 是否可行？** 对**宿主半边（index.ts + adapters.ts）完全可行**：框架自带类型、代码已是 ESM、无动态 require、无 this 绑定，改造点仅为类型标注。
- **JS/TS 混合分界建议**：
  - **转 TS**：`index.ts`、`adapters.ts`（宿主半端）。这是逻辑核心（密钥、生命周期、HTTP 转发），最需要类型保护。
  - **保留 JS（或 JS + 手写 .d.ts）**：`client.js`（浏览器半端）。原因：它的运行形态是 `__ModuleLoader__` 包装的单文件 CJS bundle，不是 Node ESM；直接 TS 化必须引入打包链去复现这个包装，收益（UI 代码的类型安全）小于成本。若一定要 TS，可按 `dsh-whale-pet-yjj730` 的模式加 `tsconfig.client.json` + esbuild 输出同名 bundle，但这是"可选优化"而非"必须"。
- **判断依据**：分界标准是"该文件被谁加载"——被 Node/Cordis loader 以 ESM 加载的（index/adapters）可直接 `.ts` + tsc 产物；被宿主自定义浏览器加载器以 CJS factory 加载的（client）维持 JS bundle。

---

## 5. 开箱即用差距（插件假设外部已存在什么）

插件**只管理、不安装**。当前用户必须手动完成、插件内部无法替代的事：

| # | 前置条件 | 插件现状 | 可否自动化进插件 |
|---|---|---|---|
| 1 | **DSH 本体**已安装并运行 | 强假设 | 否（插件本身就跑在 DSH 里） |
| 2 | **CPA 本体可执行文件**已存在；插件只按 5 个候选路径探测 `exePath`（index.js:84-94），找不到就报 `exe-not-found` | 半自动化（探测 + 配置项） | 部分可行：可加"下载/解压 CPA"向导，但当前未做 |
| 3 | **CPA 的 `config.yaml`** 已在 exe 同目录（spawn 写死 `--config config.yaml`，index.js:301） | 强假设 | 否（README 明确"不改动 CPA 配置"） |
| 4 | **渠道插件 DLL**（`workbuddy.dll`/`trae.dll`/`qoder.dll`/`zcode.dll`）已放进 CPA 的 `plugins/` 目录，且**账号已在 CPA 侧配好**（auth 文件已生成） | 强假设；面板只显示 CPA 已有账号，不负责加号 | 否（加号要走 OAuth 上游流程） |
| 5 | **CPA 管理密钥**已设置：要么填配置 `adminKey`，要么在 DSH 凭据库建 `CPA_ADMIN_KEY` 引用；否则所有写操作报 `no-admin-key` | 配置项 + 凭据引用双通道 | 可做"首启引导填密钥"，当前未做 |
| 6 | **平台仅 Windows**（CPA 是 Windows exe + DLL；README:72） | 硬约束 | 否 |
| 7 | 插件必须装在 profile 的 `node_modules/` 真实目录（不能 `link:` 外指，README:47-49） | 安装约束 | 否（DSH runtime 行为） |

**可以但尚未自动化的**：CPA 二进制探测已有（#2）；首启密钥引导、自动下载 CPA 都还在插件外。

---

## 附：调研元信息

- 只读操作：`git log/show/status`、`Read`、`Bash ls/cat`（均未触碰仓库写状态）。
- 外部来源：npm registry（`@deepseek-ai/cordis@4.0.4`、`cordis@4.0.0-rc.10` 的 types 字段）、npm 页面上多个 TS DSH 插件的工程结构。
- 仓库无 `node_modules`，Cordis 类型结论以 registry 元数据为准。
