# dsh-workbuddy-bridge 工程参考拆解

- 调研对象：`dsh-workbuddy-bridge`，main 分支，commit `2b2992d`（zlZayn）
- 性质：纯只读调研；本机凭证模式**不采纳**，仅其插件架构 / TS 工程化 / DSH 集成方式作为 dsh-cpa-panel 的 TS 迁移与「开箱即用」参考
- 包名：`dsh-workbuddy-bridge@0.3.0`，`"type": "module"`，作者 zlZayn

---

## 0. 一句话结论

这是一个**双产物、双进程、双 tsconfig** 的 DSH Cordis 插件：宿主半边（Node ESM，`lib/index.js`）注册 LLM provider + 挂载 loopback HTTP 路由；浏览器半边（`lib/client.js`）是一段被 `window.__ModuleLoader__.load({id, factory})` 包装的 CJS bundle，通过官方 slots 契约注入设置页与 composer。它的 TS 工具链（tsdown 双配置 + vitest 双 project + eslint flat + 双 tsconfig）、schemastery 全 volatile schema 写法、`cordis.patch.yml` 的「entry id vs 包名」分工、locale 双层组织，都是可直接照搬的工程范式。

---

## 1. 工程结构全貌

### 1.1 package.json 关键字段

| 字段 | 值 | 说明 |
|---|---|---|
| `type` | `"module"` | 全仓 ESM |
| `main` | `lib/index.js` | 宿主入口 |
| `types` | `./lib/index.d.ts` | |
| `bin` | `{ "dsh-workbuddy-bridge": "lib/bin.js" }` | CLI 入口（见 §1.4） |
| `exports` | `.` → `lib/index.js`；`./client` → `lib/client.js`；`./cordis.patch.yml`；`./locale/*.json`；`./package.json` | 宿主按 `./client`、`./locale/*.json` 精确子路径取件 |
| `files` | `lib`（排除 `*.map`）、`cordis.patch.yml`、`icon.svg`、`locale/*.json`、README×2、LICENSE、NOTICE | 发布面 |
| `scripts` | `build: tsdown`；`prepack: node node_modules/tsdown/dist/run.mjs`；`test: vitest run`；`lint: eslint .`；`typecheck: tsc -p tsconfig.json && tsc -p tsconfig.client.json`；`check:release: node scripts/check-release.mjs`；`check: pnpm run typecheck && pnpm run build && pnpm run test` | 注意 `check` 是 **typecheck→build→test** 顺序 |
| `engines` | `node: "^22.19.0 || >=24.0.0"`；`dsh: ">=0.1.7-rc.2"` | 宿主版本下限唯一真源 |
| `peerDependencies` | `@deepseek-ai/cordis: ^4.0.4`、`@deepseek-ai/schemastery: ^3.18.4`、`@earendil-works/pi-ai: ^0.85.1`、`react/react-dom ^18`，以及一长串 `@deepseek-ai/dsh-*: >=0.1.7-rc.2`（llm / llm-pi-ai / settings / home-paths / host-webserver / atomic-write / attachment / client-store / client-ui-* / client-locale） | 运行时全由宿主提供，插件不打包 |
| `devDependencies` | 上面 dsh-* 全部锁到 `0.2.0-rc.2`，`@deepseek-ai/cordis: 4.0.4`，`tsdown ^0.22.2`，`typescript ^5.9.3`，`vitest ^4.1.11` + `@vitest/coverage-v8`，`lightningcss`，`zustand`，`immer` 等 | devDeps 锁「某个宿主编译」，运行宿主可能更新 → 见 §5 坑 |

**不是 pnpm workspace 多包仓**：`pnpm-workspace.yaml` 里**没有 `packages:` 字段**，它只是借这个文件放 pnpm 11 的两项全局配置：
- `allowBuilds: { '@google/genai': true, protobufjs: true }`（放行传递依赖的构建脚本）；
- `minimumReleaseAge: 0`（关掉「发布不足 24h 拒收」门禁——本插件跟宿主 rc 线，rc 天然落在 24h 窗口内，否则 install 直接报 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`）。

### 1.2 `lib/` 是源码目录还是构建产物？——**是构建产物，且被提交进 git**

`lib/` 共 6 个文件，全部由 `tsdown` 产出：

| 文件 | 体积 | 是什么 |
|---|---|---|
| `lib/index.js` | ~99 KB | 宿主半边 ESM 产物（`main`） |
| `lib/index.d.ts` | ~87 KB | 宿主半边声明（`dts: true` 产出） |
| `lib/bin.js` | ~10 KB | CLI 产物（ESM，首行 `#!/usr/bin/env node`） |
| `lib/bin.d.ts` | 235 B | CLI 声明 |
| `lib/client.js` | ~112 KB | **浏览器半边 CJS bundle** |
| `lib/variants-3SmUZ0e_.js` | ~144 KB | tsdown 拆出的共享 chunk（index.js 与 bin.js 都从它 `import {…}`） |

证据：`git show 2b2992d` 显示 `lib/*` 是该提交一次性加入的产物文件；`lib/index.js` 顶部是压缩后的 ESM import（`import { A as modelWithCurrentPromotion, … } from "./variants-3SmUZ0e_.js"`）；`lib/client.js` 顶部是 `window.__ModuleLoader__.load({ id: "dsh-workbuddy-bridge", factory: (require) => { …`。**源码在 `src/`，`lib/` 不进 eslint（`ignores: ['lib/**']`）、不进 coverage（`exclude: ['lib/**']`）**。`PUBLISHING.md` 明确：link 本地开发直接读 `lib/`，所以「仓库里 `lib/` 必须永远是 build 过的状态」。

### 1.3 `bin.js` 是什么？——**CLI 入口，不是常驻子进程**

`src/cli/bin.ts` → `lib/bin.js`，经 `dsh plugin exec dsh-workbuddy-bridge <action>` 调用（见 `docs/CLI.md`）：
- `doctor`：无密钥地诊断桌面 App 发现路径与凭据读取结果；
- `status`：登录态 + 剩余积分 + 宿主 bundle 健康（读心跳文件）；
- `logout`：删**插件自留**的凭据副本（不动桌面 App 自己的登录）；
- `--provider workbuddy-ai` 选国际版；`--json` 出一份无密钥 JSON（`safeMessage()` 正则把 `eyJ…` JWT 与 `token=…` 全部 redact）。
它只做诊断/清理，**不拉起任何服务**。

### 1.4 `client.js` 是什么？——**浏览器 bundle，被宿主 ModuleLoader 包装加载**

不是给浏览器 `import` 的 ESM，而是一段 CJS：tsdown 的 `banner`/`intro`/`footer` 把它包成
`window.__ModuleLoader__.load({ id, factory: (require) => { var module={exports:{}}; …; return module.exports; } })`，
宿主运行时用自己的 `require` 提供 `react`、`@deepseek-ai/*`（这些都在 `CLIENT_EXTERNALS` / `neverBundle` 里，**绝不内联**——见 §5 关于 react-dom 被误内联的 80KB→1MB 事故）。

### 1.5 双 tsconfig 的分工（宿主半 vs 浏览器半）

`tsconfig.json`（宿主半）：`lib: ["es2024"]`、无 jsx、`types: ["node"]`，`include: ["src","tests"]`，**`exclude: ["src/client","tests/browser"]`**。
`tsconfig.client.json`（浏览器半）：上面基础上加 `jsx: "react-jsx"`、`lib: ["es2024","dom"]`，`include: ["src/client","tests/browser"]`。
两份共用同一组严格开关（`strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`verbatimModuleSyntax`、`noUnusedLocals/Parameters`）。`typecheck` 脚本两份都过。

### 1.6 `tsdown.config.ts` 怎么配（导出一个 `UserConfig[]`，两个配置）

**配置 A — 宿主（Node ESM）**：
- `entry: { index: 'src/index.ts', bin: 'src/cli/bin.ts' }`，`outDir: 'lib'`，`format: ['esm']`，`platform: 'node'`，`target: 'es2024'`，`dts: true`，`clean: true`；
- `define: { __DSH_WORKBUDDY_VERSION__: '"0.3.0"' }`（从 package.json 读 version 注入，`src/version.ts` 读它，单一事实源）；
- `deps.neverBundle`：`@earendil-works/pi-ai`、`@deepseek-ai/schemastery`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-atomic-write/home-paths/host-webserver/llm/llm-pi-ai/settings/attachment` —— 这些全由宿主提供，打进去就错。

**配置 B — 浏览器（CJS bundle）**：
- `entry: { client: 'src/client/index.tsx' }`，`format: ['cjs']`，`platform: 'browser'`，`dts: false`，`clean: false`（不跟 A 互相清目录）；
- `outputOptions.entryFileNames: 'client.js'`；
- **复现 `__ModuleLoader__` 包装**：`banner: \`window.__ModuleLoader__.load({ id: "dsh-workbuddy-bridge", factory: (require) => {\`` + `intro: 'var module = { exports: {} }; var exports = module.exports;'` + `footer: 'return module.exports; } });'` —— 这就是 §1.4 那层壳；
- `deps.neverBundle: [...CLIENT_EXTERNALS]` = `react`、`react-dom`、`react/jsx-runtime`、`react-dom/client`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-locale/client`；
- 自带一个 **lightningcss CSS Modules 插件**（`cssModulesPlugin`）：把 `*.module.css` 编译成 `[hash]_[local]` 类名，再生成一个虚拟模块——运行时往 `document.head` 插一条带 `data-plugin-css` 的 `<style>`（按 tagId 去重，热重载不叠样式），并导出类名映射。类名 key 排序后再序列化，保证产物构建确定性。

### 1.7 `vitest.config.ts` 与 `eslint.config.mjs` 要点

vitest 4 用 **`projects` 双 lane**（注意：project 不继承顶层 `define/plugins`，所以 version define 要在两个 project 里各写一遍）：
- `host`：`environment: 'node'`，`include: tests/**/*.spec.ts`（排除 browser/）；
- `browser`：仍是 `environment: 'node'`（jsdom 都不用，自己 stub window/fetch），`include: tests/browser/**`，带一个 `cssStub` 插件（`.module.css` → 返回 key=类名的 Proxy，裸 `.css` → 空模块），并 `server.deps.inline` 精确只放 `dsh-client-ui-primitives`、`dsh-client-store` 两个官方包；
- coverage：v8，`include: ['src/**/*.{ts,tsx}']`（故意不写 `src/**`，否则子树里的 README/.css/.d.ts 会让 v8 每次刷 20 组 `RolldownError`），`exclude: lib/tests/node_modules`，阈值 lines/statements 70、functions/branches 60；
- `minWorkers:2 / maxWorkers:8` 固定，避免 CI 沙箱退化成单 fork 把 ~30 个 spec 跑成 20 分钟。

eslint flat config：`ignores: ['lib/**','node_modules/**','assets/**','.local/**']`；`js.recommended + tseslint.recommended`；默认 `globals.node`；对 `src/client/**` 与 `tests/browser/**` 追加 `globals.browser`；`@typescript-eslint/no-unused-vars` 放行 `_` 前缀；末尾接 `eslint-config-prettier`。

### 1.8 src / locale / docs / scripts / tests 各装什么

- `src/`：`index.ts`（宿主入口/组装/生命周期，~1278 行）、`variants.ts`（双变体描述符）、`version.ts`、`credential/`（读桌面 App 登录文件 + 自留副本 + at-rest 解密）、`catalog/`（模型目录 live→saved→fallback 降级链、显隐）、`protocol/`（上游 chat/目录/账单/错误分类/身份）、`llm/`（adapter、shim loopback 端点、credit-log）、`probe/`（推理档位探测）、`web/`（status/credit/probe/heartbeat 四条宿主路由）、`shared/paths.ts`（两半唯一桥：路由路径 + JSON 形状）、`client/`（React 浏览器半边）。
- `locale/`：只有 `en.json` / `zh.json`，内容仅 `meta.title` + `meta.description` —— **是宿主插件页直读的包展示元数据，不是界面文案**。
- `docs/`：`ARCHITECTURE.md`（结构契约唯一权威）、`CLI.md`、`COMPATIBILITY.md`、`PUBLISHING.md`、`archive/`（按日期归档的一次性调查）。
- `scripts/`：`check-release.mjs`（发布态断言）、`release-guard.mjs`（上个 tag 以来只改文档/测试则红）、`live-e2e.mjs`、`client-identity-live-matrix.mjs`、`issue-48-forced-fallback-e2e.mjs`、`verify-shim-hardening.mjs`（后四条是真机脚本，进不了 CI，只在发版清单里跑）。
- `tests/`：~38 个 host spec + `tests/browser/`（react-test-renderer + 自写 `harness.ts` 时钟/事件）。

---

## 2. Cordis 集成方式

### 2.1 入口与生命周期（`src/index.ts`）

```ts
export const name = 'llm-workbuddy'        // loader entry id
export const inject = ['llm']              // 需要 llm 服务
export const Config = z.object({ … })      // schemastery schema
export function apply(ctx: Context, refs: ConfigRefs): void { … }
```

- **没有手写 `start`/`stop`**：生命周期靠 cordis `apply` + `ctx.effect` 返回的 dispose 函数 + 一个 `stopped` 标志 + 手动收集的 `timers[]`。停掉时 `stopped = true`、清定时器、`adoptIdentity` 在退出路径把 catalog 打回 fallback。
- `apply` 内做的事：为两个产品变体各 `createVariantRuntime(...)`（各自独立的凭据 store / 目录 / shim / 探测状态 / 路由，一个变体启动失败不影响另一个注册）；`ctx.inject(['webServer'], webCtx => {…})` 挂路由；起 30s 一次的凭据轮询（`DSH_WORKBUDDY_POLL_MS` 可覆盖，钳在 100ms–24h）。
- **启动分三相且顺序是契约**（ARCHITECTURE）：先读凭据采纳身份 → 再注册 provider → 最后抓目录。保证 provider 一进 `listProviders()` 就已经带模型，不留「provider 可见但 `resolveModelInfo` 答 UNKNOWN_MODEL」的空窗。守卫在 `tests/catalog-lifecycle.spec.ts`。

### 2.2 配置 schema（schemastery 写法，重点可借鉴）

```ts
export interface Config { authFile: string; authFileAI: string; probeConsent: boolean; useMaximumContextWindow: boolean }

const AUTH_FILE_FIELD = z.string().default('').volatile().description("…")
const Config = z.object({ authFile: AUTH_FILE_FIELD, … })
export type ConfigRefs = { readonly [K in keyof Config]: Volatile<Config[K]> }
```

三条被注释反复强调的硬规则：
1. **每个字段都必须 `.volatile()`**——宿主 `volatileForm()` 在 schema 没有 volatile 字段时返回 `undefined`，整条配置项从 `describe()` 消失，`configForms.get()` 永远不 ready，**配置区静默空白、不报错**；且非 volatile 路径写入会被宿主直接拒（`Config field "..." is not volatile`）。
2. **`.default()` 必须在 `.volatile()` 之前**：前者定 mode，后者才产出 `Volatile<T>` 而不是 `Volatile<T|undefined>`。
3. 全 volatile 的副作用正好是想要的：Loader 提交新值时只 remount volatile 部分，**改配置不重挂载插件，`apply` 只跑一次**。
4. 取值永远在**使用点** `refs.x.get() ?? <默认>`（`configOf()`），绝不把值 capture 进闭包——引用是活的。

配置即设置文档：宿主按 `plugins.bundle.config` 服务它，没有第二份「设置区」；静态部署态走 Config，实时账号状态（积分/目录来源/探测结果）走只读路由，卡片只报告不编辑，唯一写路径（探测控制）写完必回读。

### 2.3 自定义前端确实存在，且与宿主通信的方式

`src/client/` 是一套真 React UI（WorkBuddyConfigPage / panels / probe-control / credit-balance / credit-label / WorkBuddyCard），对应 assets 里的 plugin-page / models-tab / credits-tab / detection-tab / model-picker 截图。它**不自己起路由、不读文件**，与宿主的通信全部走官方契约：

- **设置页**：`ctx.configForms.whileServed(['llm-workbuddy'], () => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name:'plugins.bundle.config', key:'dsh-workbuddy-bridge', locale:NS, inject:()=>config.inject() }, WorkBuddyConfigPage)))`。
- **composer 控件行**：注册进 `conversation.input.right`（`kind:'list'` 槽），放推理档位灯泡 + 剩余积分标签；**故意不用 `conversation.input.model`**——那是 `kind:'single'`，已被宿主自带 ModelSelect 占用，同 priority 再注册会抛 `single slot … already has a registration`，且**顶掉的是宿主自己的模型选择器**。
- **消息操作行**：`conversation.chat.assistant-actions`（list、session scope、owner currency `{messageId}`）放「共消耗 X」标签。
- **数据从哪来**：浏览器半边 `fetch` 同源 loopback 路由（`src/web/status.ts` 等在宿主 `webServer` 服务上注册），路由只回脱敏 JSON、绝不回 token；两半边唯一的桥是 `src/shared/paths.ts` 里的路径常量与 JSON 形状。
- `ctx.slots.inject` 跟随**槽声明方**生命周期：宿主没有插件页/composer 时回调根本不跑，所以代码里**不做任何宿主版本探测或防御性包装**。

### 2.4 `cordis.patch.yml` 内容与「两个常量各钉一处」

```yaml
- insert:
    - id: llm-workbuddy            # entry id → 设置命名空间 ns
      name: dsh-workbuddy-bridge   # 包名     → slots 的 key
```

配套在 `package.json`：`"dsh": { "bundle": { "patch": "./cordis.patch.yml" }, "client": { "inject": […9 个 @deepseek-ai/dsh-client-ui-* 与 locale/remotes…], "platform": "web" } }`。

**load-bearing 的分工**（client/index.ts 里写死两个常量 `ENTRY_ID='llm-workbuddy'`、`BUNDLE_NAME='dsh-workbuddy-bridge'`）：
- `ctx.configForms.get()` 收的是**命名空间**，宿主按 `ns: entry.options.id` 发设置文档 → 喂**包名**会静默落空（whileServed 永不触发，配置页根本不出现）；
- `slots.register` 的 `key` 取**包名**（宿主按 `pkg.name` 派发）。
这两个常量不一致是高频坑，所以注释里说「两条红线钉在 cordis.patch.yml 上」。

> 与 dsh-cpa-panel 的 `cordis.patch.yml` 对照时应核：① insert 的 `id`（entry id）是否与 `configForms.get()` 用的命名空间一致；② `name` 是否等于 `pkg.name`；③ `dsh.bundle.patch` 是否指向本文件、`dsh.client.inject` 是否列齐浏览器半边依赖的官方 UI 包。

### 2.5 locale 的双层组织

- **包展示元数据**：`locale/en.json`、`locale/zh.json`（`meta.title`/`meta.description`），宿主插件页**直接读包内文件、不经插件代码**；经 `exports["./locale/*.json"]` 与 `files` 发布；宿主先读 en，en 不在才读别的。
- **界面文案**：在 `src/client/locales.ts`，运行时 `ctx.effect(() => ctx.locale.register('settings.workbuddy', { zh, en }))`，并用 `declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { 'settings.workbuddy': … } }` 把命名空间挂进类型。

---

## 3. 本机凭证模式（只描述、不采纳）

### 3.1 凭证存哪、怎么读写

- **读**：`src/credential/store.ts` 按平台候选顺序找桌面 App 自己的登录文件（Win: `%LOCALAPPDATA%`/`%APPDATA%` 下相对路径；mac: bundle 布局；Linux: `XDG_CONFIG_HOME`/`XDG_DATA_HOME`；支持 `WORKBUDDY_AUTH_FILE` env 覆盖与 WSL `/mnt/c` 换算）。
- **自留副本**：插件把凭据拷一份到 `$DSH_HOME/.workbuddy-auth.json`（`resolveDshHome()` 来自 `@deepseek-ai/dsh-home-paths`），刷新 token 后回写。
- **写机制**（这才是可借鉴的运行时锁）：
  ```ts
  import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
  await withFileLock(this.ownPath, async () => {
    await writeFileAtomic(this.ownPath, JSON.stringify(ownDocument(credential), null, 2) + '\n', …)
  })
  ```
  即「**文件锁 + 原子写（临时文件 + rename）**」，来自宿主官方包，不是自己实现。
- **at-rest 解密**：桌面 App 的凭据是加密信封，`WorkBuddyAtRestKeyProvider` 在 Windows 上**调用 WorkBuddy 自带的 Electron exe 当密钥助手**（`cnAppDiscovery()` 按 bundle id 找）；国际版 `discovery:'none'`，绝不悄悄跑国内版的 Electron。

### 3.2 「lockfile 那条代价」到底是什么锁——**是 pnpm-lock.yaml，不是运行时文件锁**

commit `2b2992d` 的 message 与 `AGENTS.md` §活跃坑写得很清楚：

> 核验兼容性时把探测目录建在仓内，pnpm 往 `pnpm-lock.yaml` 写了一条 **importer** 记录，目录删了记录还在。本机 `pnpm install` 不带 `--frozen-lockfile` 会**静默自愈**，只有 CI 的 frozen 模式才判红（2026-10-02 三平台齐红，失败在第一步 install）。

为什么是坑：
1. pnpm 把仓内任意目录当 workspace importer，在 lockfile 里留下该 importer 的快照；目录删了，lockfile 记录不删；
2. 本机不带 `--frozen-lockfile` 跑 install 会自动重解析、把脏记录悄悄修掉——**开发者本机全绿**；
3. CI 用 frozen 模式，lockfile 与实际文件树对不上，直接在 install 这步红，且三平台（Win/mac/Linux）齐红，错误信息远离根因。

**判据**：在 `pnpm-lock.yaml` 里 grep 那个临时目录名。**处置**：跑一次 `pnpm install` 重解析，**不要手编 lockfile**。**根治做法**（AGENTS.md 给的）：核验宿主兼容性时，临时装包的目录必须放在**仓库外面**。

> 注意区分两个「锁」：运行时的 `withFileLock`（§3.1，可借鉴）与这条被写进活跃坑的 `pnpm-lock.yaml` importer 污染（§3.2，要规避的流程坑）。

### 3.3 与 CPA 中转模式在插件侧的差异

| 部分 | 本机凭证模式（本仓，不采纳） | CPA 中转（dsh-cpa-panel 方向） |
|---|---|---|
| `credential/`（读桌面登录文件、Electron 解密、`$DSH_HOME` 自留副本、token 刷新） | 全部围绕「本机已有登录态」 | **整块不可照搬** |
| `protocol/client.ts`（chat/目录/账单的 wire 解析、`typeof` 收窄、错误分类） | 与上游形态耦合 | 可借鉴「严格 `typeof` 收窄、不用 schema 库强转」的解析纪律 |
| `llm/adapter.ts` + `shim.ts`（接 `@deepseek-ai/dsh-llm` / `pi-ai`，注册 provider） | 通用接入骨架 | **可复用** |
| `catalog/`（live→saved→fallback 降级链、按账号显隐） | 通用模型目录管理 | **可复用思路** |
| `web/*`（loopback 路由 + 脱敏 + 写后回读） | 通用宿主 HTTP 路由模式 | **可复用**（若 CPA 面板也要前端读状态） |
| 三相启动、全 volatile schema、双产物打包 | 工程化骨架 | **直接照搬** |

---

## 4. 进程 / 资源管理

- **不常驻子进程**：插件本身只在宿主进程内跑；`bin.js` 是 `dsh plugin exec` 时一次性拉起的短生命周期 CLI（doctor/status/logout）。
- **服务挂载**：通过 `ctx.inject(['webServer'], webCtx => registerXRoute(webCtx, …))` 把路由挂到**宿主已有**的 webServer 上，不自己 `listen()` 端口；路由做 loopback 校验（`hostIsLoopback` / `originIsLoopback`），写路由（探测控制）用进程内 `createProbeKey()` 鉴权。
- **心跳文件**：`src/web/heartbeat.ts` 在宿主 bundle 注册后往 `$DSH_HOME/.workbuddy-host-heartbeat.json` 写 `{ pid, … }`；CLI/status 读它并 `isHeartbeatProcessAlive()` 靠 pid 判活——用于区分「宿主根本没启动」与「心跳文件是上次崩溃残留」。这是一个可借鉴的「短生命周期 CLI 探测长生命周期宿主」的模式。
- **文件锁 / 原子写**：见 §3.1，统一走 `@deepseek-ai/dsh-atomic-write` 的 `withFileLock` + `writeFileAtomic`。
- **平台探测**：`execFileSync` 调 `reg.exe`（Win）/ `mdfind`+`plutil`（mac），且对退出码语义有专门注释（reg 退出码 1 有两种形状，都算「这格没有」，只有被杀/没起来才算「查不了」）。
- **scripts/**：`check-release.mjs` 把「发布态该有什么」变成断言（`dsh.bundle.patch` 在、`files`/`exports` 覆盖了 locale 与 cordis.patch.yml、`engines.dsh` 与全部 dsh-* peer 下限同形）；`release-guard.mjs` 挡「只改文档/测试就发版」；其余四条是真机 e2e。

---

## 5. 可借鉴清单（落到 dsh-cpa-panel 文件级）

### 5.1 直接照搬的工程化骨架

1. **tsdown 双配置**（照抄 `tsdown.config.ts` 结构）：
   - 宿主配置：`entry: { index: 'src/index.ts' }`（若也做 CLI 再加 `bin`）、`outDir:'lib'`、`format:['esm']`、`platform:'node'`、`target:'es2024'`、`dts:true`、`define` 注入 version、`deps.neverBundle` 列出全部 `@deepseek-ai/*` 与 `schemastery`、`pi-ai`；
   - 浏览器配置（若做前端）：`format:['cjs']`、`platform:'browser'`、`dts:false`、`clean:false`，用 `banner/intro/footer` 复现
     `window.__ModuleLoader__.load({ id:"<pkg>", factory:(require)=>{ var module={exports:{}}; …; return module.exports; } })`；
   - **version 单一事实源**：`src/version.ts` 里 `declare const __XXX_VERSION__`，build 时 define，运行时 fallback `'0.0.0-dev'`。
2. **双 tsconfig**：`tsconfig.json` 管宿主半（include src+tests、exclude src/client）、`tsconfig.client.json` 加 `jsx:react-jsx` + `lib:dom` 管浏览器半；`typecheck` 两份都过。
3. **vitest 双 project**：host lane（node）+ browser lane（node 环境 + cssStub + 精确 inline 官方包）；coverage 只收 `src/**/*.{ts,tsx}`、exclude `lib/tests/node_modules`。
4. **schemastery schema 写法**：每个字段 `z.<type>().default(…).volatile().description(…)`，`.default` 在 `.volatile` 前；`ConfigRefs = { [K in keyof Config]: Volatile<Config[K]> }`；取值用 `refs.x.get() ?? 默认` 在使用点读。
5. **`cordis.patch.yml` + 两个常量**：`ENTRY_ID`（= insert 的 `id` = `configForms.get()` 的命名空间）与 `BUNDLE_NAME`（= `pkg.name` = slots 的 `key`）必须分别对齐；package.json 配 `dsh.bundle.patch` 与 `dsh.client.inject`。
6. **locale 双层**：`locale/{en,zh}.json` 放包展示元数据并经 `exports["./locale/*.json"]`+`files` 发布；界面文案放 `src/client/locales.ts` 运行时 `ctx.locale.register(ns,{zh,en})`。
7. **目录结构**：按职责切 `credential|catalog|protocol|llm|probe|web|shared|client`，`shared/paths.ts` 作为两半唯一桥（路径常量 + JSON 形状类型），浏览器半永不碰文件路径与平台事实。
8. **发布链**（`PUBLISHING.md` 摘要）：`pnpm version` bump（不打 tag）→ 重建 `lib/` → 提 main → 推 `v<版本>` tag；release.yml 一条链（守卫→安装→typecheck→build→test→check:release→publish→tag→GitHub Release）；tag 名必须等于 `v`+版本号；已发过的版本幂等跳过 publish；本地开发用 `link:` 装法（改完 build + 重启 dsh 即生效）。

### 5.2 要规避的坑（含 lockfile）

- **lockfile importer 污染**（§3.2）：在仓内建临时目录做兼容性核验，会让 pnpm 往 `pnpm-lock.yaml` 写 importer、本机静默自愈、CI frozen 三平台齐红。**dsh-cpa-panel 做法**：所有临时装包/核验目录一律放仓库外；CI 上 install 必须 `--frozen-lockfile`；发现脏记录用 `pnpm install` 重解析，不手编 lockfile。
- **浏览器 bundle 绝不内联 react/宿主包**：漏一个 `neverBundle`（如当年漏 `react-dom`），bundle 从 ~80KB 涨到 1MB 并在浏览器里抛 `process is not defined`，插件激活失败、宿主只报 import error。产物里连注释都不能出现 `process`（本仓用 `tests/redlines.spec.ts` 正则扫整份产物当哨兵）。
- **全 volatile 才出表单**：漏一个 `.volatile()`，配置区静默空白。
- **single 槽不要抢**：`kind:'single'` 的槽（如 `conversation.input.model`）已被宿主占用，再注册会顶掉宿主 UI；并排控件选 `kind:'list'` 槽。
- **`engines.dsh` 与全部 dsh-* peer 下限同形**：唯一真源是 package.json，由 `scripts/check-release.mjs` 断言；devDeps 锁某个宿主编译、运行宿主可能更新，升级时同步决定兼容下限。
- **测试断言里不许出现 locale 相关字面量**（本机中文 locale 绿、CI en 红），日期/数字走统一 formatter。

### 5.3 不能照搬的

- **整块本机凭证模式**：`credential/`（读桌面 App 登录文件、调 Electron 解密、`$DSH_HOME` 自留副本与 token 刷新）与 CPA 中转模式无关，不采纳；需要持久化时只借它的 `withFileLock + writeFileAtomic` 写法。
- **自定义前端（若 dsh-cpa-panel 决定零前端）**：`src/client/` 整套 React 卡片/tabs、`__ModuleLoader__` 浏览器配置、`dsh.client.inject`、CSS Modules 注入——零前端则这些都不要，宿主半边单产物即可；但仍建议保留 `bin.js` 式 `dsh plugin exec` 诊断 CLI 与 `web/` loopback 状态路由（供未来排障）。
