# CLIProxyAPI 架构与删留清单

> 调研对象：`CLIProxyAPI` @ `c121fde`（https://github.com/zlZayn/CLIProxyAPI/tree/local-autobrowser）
> 分支 `local-autobrowser`，HEAD `c121fde`，Go module `github.com/router-for-me/CLIProxyAPI/v8`（基于上游 v8.0.7）
> 跨仓库依赖：`cpa-multi-plugins` @ `cf5f6af`（https://github.com/mmqz/cpa-multi-plugins）
> 性质：只读调研，未改动任何代码。

---

## 0. 一页结论（TL;DR）

1. **账号面板所需的后端能力，宿主二进制本身只提供「账号 CRUD + 启用/禁用 + 刷新 + 插件余额代理」**；真正有业务价值的**余额数字、签到、任务**全部由 **cpa-multi-plugins 动态库**在运行时注入。宿主 = 一个带热重载账号文件管理 + 插件宿主的最小 HTTP 服务。
2. **运行时可以通过 Management API 增/删/改/启停账号，无需重启**（见 §5）。这是「配置全在 DSH 插件侧、开箱即用」的关键。
3. **插件不是 Go 内置 `plugin` 包，而是 CGO + `dlopen` 加载的 C ABI 动态库**（导出 `cliproxy_plugin_init`）。因此**必须 `CGO_ENABLED=1` 编译**，且插件 `.so/.dll` 要与宿主同 ABI。
4. `local-autobrowser` 相对上游**没有引入任何新的代理端点/供应商/自动化能力**，本地增量仅「启动时自动浏览器打开面板」+ Windows 构建脚本。它是账号面板用例的**合格基座**（因为面板 v1.25+ 强制要 v8 Management API）。
5. 可删除面非常大：WebRTC/Realtime、TUI、Home 控制面、Postgres/Git/Object 存储、mDNS 发现、TLS、大部分协议翻译器与供应商执行器、v0 冗长配置端点、Docker/构建脚本。核心保留闭包见 §6。

---

## 1. 架构总览

### 1.1 入口与 `cmd/` 各子命令职责

唯一服务入口是 `cmd/server/main.go`。其余 `cmd/` 下都是一次性工具：

| 路径 | 职责 |
|---|---|
| `cmd/server/main.go` | 服务主入口：flag 解析 → 选存储后端 → 加载配置 → 注册 token store/插件宿主 → 走「登录子命令」或「起服务」分支。`main()` 在 L75。 |
| `cmd/fetch_codex_models/main.go` | 一次性拉取 Codex 模型目录（离线工具，带 test） |
| `cmd/fetch_antigravity_models/main.go` | 一次性拉取 Antigravity 模型目录 |
| `cmd/fetch_devin_models/main.go` | 一次性拉取 Devin 模型目录 |
| `cmd/validate_codex_models/main.go` | 校验 Codex 模型目录 JSON |

`main()` 内的「命令模式」分支（`main.go` L714–L739）：`-codex-login` / `-codex-device-login` / `-claude-login` / `-antigravity-login` / `-kimi-login` / `-kimi-ai-login` / `-xai-login` / `-devin-login` / `-meta-login` / `-vertex-import`，全部是**走 OAuth 浏览器登录后写 auth 文件**的工具；非命令模式才起 HTTP 服务（L825–L834）。

### 1.2 `internal/` 各包一句话职责

| 包 | 职责 |
|---|---|
| `internal/api` | Gin HTTP 服务器装配、路由注册、中间件、协议多路复用 |
| `internal/api/handlers/management` | **Management API 全部 handler（账号面板核心就在这）** |
| `internal/api/middleware` | 请求日志、响应体包装 |
| `internal/access` / `internal/access/config_access` | 代理 API 客户端鉴权（`access.api-keys`） |
| `internal/auth/{claude,codex,antigravity,kimi,xai,vertex,devin,meta,empty}` | 各供应商 OAuth/token 结构与刷新逻辑 |
| `internal/browser` | 跨平台调用系统默认浏览器打开 URL（`browser.OpenURL`） |
| `internal/buildinfo` | 注入版本/commit/构建时间 |
| `internal/cache` | 请求签名缓存 |
| `internal/client/{claude,codex,grokbuild}` | 各供应商官方 API 的客户端模型/live 封装 |
| `internal/cmd` | 登录流程实现 + `StartServiceWithPluginHost` 服务启动 |
| `internal/config` | YAML 配置定义/加载/校验/v8 迁移/热保存 |
| `internal/constant` | 常量 |
| `internal/credentialweight` | 账号权重校验/解析 |
| `internal/discovery` | LAN mDNS/DNS-SD 网关发现（zeroconf） |
| `internal/home` | CLIProxyAPIHome 控制平面 RESP 客户端（cloud 集群模式） |
| `internal/homeplugins` | Home 模式下插件同步/上报 |
| `internal/htmlsanitize` | 插件管理响应的 HTML/JSON 转义 |
| `internal/httpfetch` / `internal/httpwire` | 精简 HTTP 取数 / HTTP/1.1 报文辅助 |
| `internal/interfaces` | 核心接口与共享结构 |
| `internal/logging` | logrus 初始化、日志文件轮转、目录解析 |
| `internal/managementasset` | 管理面板 `management.html` 的下载/快照/后台自更新 |
| `internal/misc` | 杂项（如复制配置模板、Antigravity 版本更新器） |
| `internal/modelconfig` | 模型配置 |
| **`internal/pluginhost`** | **插件宿主：dlopen 加载 .so/.dll、RPC、注册并派发插件管理/资源路由、quota provider** |
| `internal/pluginstore` | 插件市场：从 GitHub release 下载/安装插件、registry 解析 |
| `internal/redisqueue` | 用量统计队列（可退化为内存） |
| `internal/registry` | 模型注册表 + 远程模型目录更新 |
| `internal/runtime/executor` | 每供应商运行时执行器（含 Codex WebSocket） |
| `internal/safemode` | 示例 API key 安全模式（禁用代理端点） |
| `internal/signature` | 供应商请求签名（antigravity） |
| `internal/store` | token 存储后端：file / Postgres / Git / Object(MinIO) |
| `internal/thinking` | 思考/reasoning 参数规范化与按供应商翻译 |
| `internal/translator/{openai,claude,codex,gemini,antigravity,interactions,common}` | 协议互译层 |
| `internal/tui` | Bubbletea 终端管理 UI |
| `internal/util` | 日志级别、可写路径、auth 目录解析等 |
| `internal/watcher/{diff,synthesizer}` | **fsnotify 监听 config 与 auth 目录，热重载账号/配置** |
| `internal/wsrelay` | WebSocket 中继会话 |

`sdk/` 是对外可嵌入 SDK：`sdk/cliproxy`（auth/executor/pipeline/session/usage）、`sdk/api/handlers/{openai,gemini,claude}`（对外兼容协议 handler）、`sdk/pluginapi`/`sdk/pluginabi`/`sdk/pluginhost`（插件契约）、`sdk/pluginstore`、`sdk/auth`（token store 接口与 file 实现）。

### 1.3 启动流程（main → server → provider 注册 → 插件加载）

`cmd/server/main.go`（L75）顺序：

1. **`discover` 子命令**短路退出（L76–L99）。
2. 建 `pluginHost := pluginhost.New()`，先读一次 bootstrap 配置（`loadPluginBootstrapConfig`，L980）让插件能注册自己的 CLI flag。
3. 解析 flag；加载 `.env`（L255）。
4. **选存储后端**（L273–L597）：`-home-jwt`（Home 控制面）> `PGSTORE_*`(Postgres) > `OBJECTSTORE_*`(MinIO) > `GITSTORE_*`(git) > 本地 `config.yaml`。账号面板用例应走**最后一条：本地文件**。
5. `sdkAuth.RegisterTokenStore(...)`（L671–L679）：默认 `NewFileTokenStore()`。
6. `configaccess.Register(&cfg.SDKConfig)`（L682）；`pluginHost.ApplyConfig(ctx, cfg)`（L683）→ **这里真正 dlopen 插件**。
7. 命令模式（各 `*-login`）或起服务：普通服务分支 L825–L834 → `managementasset.StartAutoUpdater`（后台下载面板 HTML）+ `cmd.StartServiceWithPluginHost(...)`。
8. `internal/cmd` 内组装 `api.Server`：建 Gin engine → `s.setupRoutes()`（`server_routes.go` L43）→ 若配置了管理密钥则 `registerManagementRoutes()`（`server.go` L246–L248）→ `refreshPluginManagementRoutes()` → `engine.NoRoute(s.pluginManagementNoRoute)`（`server.go` L250）。

供应商「注册」：内置供应商由 `internal/translator` 匿名 import（`main.go` L38 `_ "...internal/translator"`）+ `internal/runtime/executor` 提供；**插件供应商（workbuddy/qoder/trae/zcode/mimo）由插件在 dlopen 后通过 host callback 自注册 auth provider / executor / quota provider / 管理路由**。

### 1.4 配置系统全貌

- **三层来源**：YAML 文件（默认 `config.yaml`，模板 `config.example.yaml`）> 环境变量（`.env` 自动加载 + `PGSTORE_*`/`GITSTORE_*`/`OBJECTSTORE_*`/`HOME_JWT`/`MANAGEMENT_PASSWORD` 等）> flag（`--config`/`--port`/`--tui` 等）。
- **v8 布局**（`config.example.yaml` L1 起）：`config-version: 8`，顶层嵌套为 `server.*` / `management.*` / `access.api-keys` / `oauth.auth-dir` / `plugins.*` / `routing.*` / `observability.*` / `requests.*`。旧扁平键仍兼容，v8 写入时迁移。
- **配置结构体**：`internal/config/config.go` L8 `type Config struct`（内嵌 `SDKConfig`）。
  - `server.host/port`（L12–14）、`management`（L33，即 `RemoteManagement`）、`plugins`（L36，`PluginsConfig`）、`auth-dir`（L39）。
  - `RemoteManagement`：`allow-remote` / `secret-key`（支持 bcrypt，启动时把明文 hash 回写）/ `disable-control-panel` / `disable-auto-update-panel` / `panel-github-repository` / `base-url`。
  - `PluginsConfig`：`enabled` / `dir`（默认 `plugins`）/ `store-sources` / `store-auth` / `configs map[id]PluginInstanceConfig`；`PluginInstanceConfig` = `enabled *bool` + `priority int` + 一段自由 YAML `Raw`。
- **auths 目录的作用**：`auth-dir`（v8 是 `oauth.auth-dir`，示例默认 `~/.cli-proxy-api`，本仓库用 `./auths/`）。**一个 `.json` 文件 = 一个上游账号（credential）**。本仓库 `auths/` 当前只有 `.gitkeep`，实际字段结构可由 `sdk/cliproxy/auth` 的 `Auth` 结构体（见 §5.1）反推：`provider` / `label` / `disabled` / `attributes{...}` / `metadata{tokens,cookies,quota_probe,priority,note,...}`。插件账号（如 workbuddy/qoder）的文件由插件「import」接口写入宿主 auth store，再由 watcher 加载。

### 1.5 HTTP 服务器与中间件

- 框架 **Gin**（`go.mod` gin v1.10.1）。监听 `host:port`，可选 TLS（`server.go` L299–）。
- 全局中间件栈（`server.go` L230–L231）：`homeHeartbeatMiddleware`（Home 模式门控）+ `exampleAPIKeySafeModeMiddleware`。
- 代理端点组 `/v1`、`/v1beta`、`/openai/v1`、`/backend-api/codex` 挂 `AuthMiddleware(accessManager)`（`server_routes.go` L64/L104/L113/L123）。
- 管理端点 `/v0/management`、`/v8/management` 挂 `managementAvailabilityMiddleware()`（未配密钥→404）+ `mgmt.Middleware()`（鉴权，见 §4.2）。
- `engine.NoRoute` 统一落到 `pluginManagementNoRoute`（`server_management.go` L254），把 `/v0/management/*` 与 `/v0/resource/plugins/*` 的未命中路径转交给插件。

---

## 2. `local-autobrowser` 分支核实

> **重要前置事实**：本检出是**单提交浅克隆**。`.git/shallow` 仅含 `c121fde` 自身，`git rev-list --count HEAD = 1`，本地与远端都**只有 `local-autobrowser`，不存在 `main` / `upstream` ref**。因此**无法做 `git diff main...local-autobrowser`**——没有可对比的基线提交。`git show --stat HEAD` 把整棵树当新增（root commit），不能作为分支差异依据。

依据 `AGENTS.md` L65–L101（该文件本身就在本提交里）与代码内标记交叉验证，本分支 = **上游 v8.0.7 + 两个本地提交**：

| 本地改动 | 证据 | 性质 |
|---|---|---|
| ① 启动后自动用默认浏览器打开 `/management.html` | `cmd/server/main.go` L830–L832 调用 `shouldOpenControlPanel`/`openControlPanelWhenReady`，定义在 L885–L947；`--no-browser` 帮助文案 L141 已改为「OAuth flows and the management control panel」；单测 `cmd/server/main_test.go` 含 `TestShouldOpenControlPanel`/`TestControlPanelHost` | 纯 UX，不新增任何 API/供应商/自动化能力 |
| ② Windows 重建/更新辅助脚本 | 顶层 `build-local.ps1`、`docker-build.ps1`、`update-upstream.ps1`（AGENTS.md L78、L88–L89） | 工程脚本，与运行时能力无关 |

**结论：相对上游，该分支没有新增/删除任何 HTTP 端点、没有改动供应商适配层、没有引入新的自动化能力**。它唯一的「能力差异」是启动时多弹一次浏览器。

**它是不是账号面板用例的正确基座？** 是，但理由与本地增量无关：
- 账号面板（DSH 插件 / Cli-Proxy-API-Management-Center v1.25+）**强制要求 v8 Management API（`/v8/management`）**，旧 v7 后端会报 "legacy backend"（AGENTS.md L95）。本分支基于 v8.0.7，满足。
- 本地「自动开浏览器」对 headless 后端部署反而要靠 `--no-browser` / `remote-management.disable-control-panel` 关掉——**删留时可连同 `internal/browser`、`management.html` 自下载一起去掉**，不影响 DSH 插件直接打 Management API。

---

## 3. 供应商插件机制（cpa-multi-plugins `.so` 如何被加载）

### 3.1 加载方式：CGO `dlopen`，**不是** Go `plugin` 包

- 加载器：`internal/pluginhost/loader_unix.go`（Linux/macOS，`//go:build cgo && (linux||darwin||freebsd)`）与 `loader_windows.go`。
- 机制（`loader_unix.go` L43–L171）：`dlopen(path, RTLD_NOW|RTLD_LOCAL)` → `dlsym("cliproxy_plugin_init")` → 调用该 C 符号，交换两张函数表 `cliproxy_host_api`（宿主回调）与 `cliproxy_plugin_api`（插件 `call`/`free_buffer`/`shutdown`）。之后所有交互走 `dynamicLibraryClient.Call(method, payload []byte) []byte`（L180），即**进程内、字节载荷的 JSON-RPC 式调用**。
- **进程内、同地址空间**，不是外部子进程。ABI 版本钉死（`pluginHostABIVersion`，L162）。
- **必须 CGO**：`support_cgo.go` 常量 `supportPluginValue="1"`；CGO 关闭时 `support_nocgo.go`="0"，`loader_unsupported.go` 拒绝加载。这与 AGENTS.md L90「上游用 CGO_ENABLED=1 构建」一致。
- 插件侧契约（跨仓库已核实）：`cpa-multi-plugins/plugins/*/` 与本仓 `examples/plugin/*/go/main.go` 均用 `//export cliproxy_plugin_init`（如 `examples/plugin/auth/go/main.go` L80–81），C/Rust 版导出同名符号。**插件可以是 Go(cgo)、C、Rust 编译出的动态库**。

### 3.2 如何被发现/激活（registry / 配置）

- 配置驱动：`internal/pluginhost/config.go` L29 `runtimeConfigFromConfig(cfg)`。总开关 `plugins.enabled`（L38，关则直接返回、一个都不加载）；目录默认 `plugins/`（L31）；逐插件 `plugins.configs.<id>.enabled`（**默认 false**，不显式启用则宿主根本不加载它，AGENTS.md L94 同述）。
- 安装来源：`internal/pluginstore` 从 GitHub release 下载 `.so/.dll` 到 `plugins/`；`cpa-multi-plugins/dist/linux-amd64/` 已带 `qoder.h/trae.h/workbuddy.h`。
- 激活后插件经 `RegisterManagement(ctx, {BasePath:"/v0/management", ResourceBasePath:"/v0/resource/plugins/<id>"})` 自报路由（`internal/pluginhost/management.go` L39–L100），由 `Server.refreshPluginManagementRoutes()`（`server_management.go` L229）重建路由表。

### 3.3 缺插件 / 插件失败时的行为

- 未启用或 `.so` 缺失：宿主照常起服务，只是没有对应 provider/管理路由；访问插件路由时 `ServeManagementHTTP` 返回 false → NoRoute 最终 404（`management.go` L240）。
- 插件 panic：宿主 `recover` 后 `fusePlugin(id,...)` 熔断该插件（`management.go` L338–L344），不拖垮进程。
- 未加载任何插件时，**账号面板仍能用**：宿主自带的账号 CRUD/启停/刷新/通用 quota-probe 都在；只是没有 workbuddy/qoder/trae 那些**签到/任务/实时 credits** 业务路由。

---

## 4. API 面清单（method + path + handler 文件:行）

> 路由注册文件：`internal/api/server_routes.go`（代理面）、`internal/api/server_management.go`（v0 管理面）、`internal/api/server_management_v8.go`（v8 管理面）。
> **总计约 170+ 条静态路由**：代理面约 45 条，v0 管理面约 110 条（大量 GET/PUT/PATCH 三元组的单项配置），v8 管理面 21 条；另有动态 `AttachWebsocketRoute` 与插件自报路由。**账号管理相关路由见 §4.2。**

### 4.1 代理兼容面（DSH 面板用例基本可删）

| Method | Path | 位置 |
|---|---|---|
| GET/HEAD | `/healthz` | server_routes.go:52-53 |
| GET | `/management.html`（面板静态页） | server_routes.go:55 |
| GET | `/` | server_routes.go:132 |
| GET | `/v1/models` | server_routes.go:66 |
| POST | `/v1/chat/completions` `/v1/completions` `/v1/images/generations` `/v1/images/edits` | :67-70 |
| POST | `/v1/videos*`（xAI 视频系列） | :71-75 |
| POST | `/v1/messages` `/v1/messages/count_tokens`（Claude） | :76-77 |
| GET/POST | `/v1/responses` `/v1/responses/compact` | :78-80 |
| POST | `/v1/alpha/search`（Codex） | :81 |
| POST/GET | `/v1/live` `/v1/live/:call_id`（Codex live） | :82-83 |
| GET/POST | `/v1/realtime/*`（WebRTC/SIP 系列，约 14 条） | :88-101 |
| POST/GET | `/openai/v1/videos*` | :106-108 |
| GET/POST | `/backend-api/codex/responses*` `/alpha/search` | :115-118 |
| GET/POST | `/v1beta/models*` `/v1beta/interactions`（Gemini） | :125-128 |
| GET | `/anthropic/callback` `/codex/callback` `/antigravity/callback` `/callback` `/devin/callback` | :146-209 |

### 4.2 管理面 —— 账号面板真正要打的路由

**v8（面板 v1.25+ 使用，`server_management_v8.go`）**：

| Method | Path | Handler（文件:行） | 面板用途 |
|---|---|---|---|
| GET/POST | `/v8/management/oauth/callback` | `mgmt.GetOAuthCallback`/`PostOAuthCallback`（oauth_callback.go） | OAuth 回调 |
| GET/PUT/PATCH | `/v8/management/config`、`/config.yaml`、`/config/*path` | `mgmt.ConfigV8`（config_v8.go） | **DSH 推送/读取后端配置** |
| GET | `/v8/management/server/latest-version` | `GetLatestVersion` | 版本检查 |
| POST | `/v8/management/requests/api-call` | `mgmt.APICall`（api_tools.go） | 代理发请求 |
| POST | `/v8/management/routing/cooldown/reset` | `mgmt.ResetQuota`（quota.go:27） | 重置冷却 |
| GET | `/v8/management/observability/logs*`、`/requests/:id` | logs.go | 日志 |
| GET | `/v8/management/observability/usage/api-keys`、`/usage/queue` | usage.go / api_key_usage.go | 用量 |
| **GET** | **`/v8/management/credentials`** | **`mgmt.ListAuthFiles`（auth_files.go:103）** | **账号列表** |
| **POST** | **`/v8/management/credentials`** | **`mgmt.UploadAuthFile`（auth_files_crud.go:51）** | **新增账号（上传 auth json）** |
| **DELETE** | **`/v8/management/credentials`** | **`mgmt.DeleteAuthFile`（auth_files_crud.go:132）** | **删除账号** |
| GET | `/v8/management/credentials/models` | `mgmt.GetAuthFileModels`（auth_files.go:333） | 账号可用模型 |
| GET | `/v8/management/credentials/download` | `mgmt.DownloadAuthFile` | 下载账号文件 |
| **PATCH** | **`/v8/management/credentials/status`** | **`mgmt.PatchAuthFileStatus`（auth_files_fields.go:28）** | **启用/禁用账号** |
| **PATCH** | **`/v8/management/credentials/fields`** | **`mgmt.PatchAuthFileFields`（auth_files_fields.go:258）** | **改账号字段(label/priority/note/...)** |
| **POST** | **`/v8/management/credentials/refresh`** | **`mgmt.RefreshAuthFiles`（auth_files_refresh.go:14）** | **刷新 token** |
| POST | `/v8/management/oauth/import`、GET `/v8/management/oauth/auth-url`、GET `/oauth/status`、DELETE `/oauth/session` | auth_files_v8.go:11/39、oauth_sessions.go | OAuth 登录流 |
| GET | `/v8/management/plugins` | `mgmt.ListPlugins`（plugins.go） | 已加载插件 |
| DELETE | `/v8/management/plugins/:id` | `mgmt.DeletePlugin` | 删插件 |
| GET | `/v8/management/plugins/store`、POST `/plugins/store/:id/install` | plugin_store.go | 插件市场 |
| **GET** | **`/v8/management/plugins/:id/quota`** | **`mgmt.GetPluginQuota`（plugin_quota.go:237）** | **读某账号余额（缓存）** |
| **POST** | **`/v8/management/plugins/:id/quota`** | **`mgmt.FetchPluginQuota`（plugin_quota.go:251）** | **实时拉余额** |
| DELETE | `/v8/management/plugins/:id/quota` | `mgmt.ResetPluginQuota`（plugin_quota.go:301） | 清余额缓存 |

**v0（`server_management.go`，已废弃但插件路由仍挂其下）**：`/v0/management/auth-files*` 与上面 credentials 一一对应（L180–L188）；`/v0/management/plugins/:id/quota*`（L43–46）；`/v0/management/quota/providers|fetch|reset`（L84–86）。其余约 90 条是各项全局配置的 GET/PUT/PATCH（api-keys、routing、retry、debug、proxy-url、各 `*-api-key` 组…），账号面板用例**不需要**。

**插件自报路由（签到/任务/实时余额，运行时注入，前缀 `/v0/management/plugins/<provider>`）**——来自 cpa-multi-plugins 源码：

| 插件 | 路由（已拼宿主前缀） | 用途 |
|---|---|---|
| workbuddy | `GET /v0/management/plugins/workbuddy/accounts`；`POST .../refresh`；`POST .../checkin`；`GET .../tasks`；`POST .../tasks/run`；`GET .../school/vouchers`；`POST .../checkin/config`；`GET .../credits`；`POST .../import`；`POST .../trial`；`POST .../select`；`POST .../keepalive` | **签到 / 任务(成长中心) / 实时 credits**（workbuddy/management.go:146-162） |
| qoder | `GET .../qoder/accounts`；`POST .../checkin`；`POST .../checkin/config`；`GET .../credits`；`POST .../claim-pro`；`POST .../keepalive`；`GET .../cooldowns` 等 | 签到/claim-pro/credits（qoder/management.go:120-132） |
| trae | `GET .../trae/accounts`；`POST .../checkin`；`GET .../credits`；`POST .../release`；`POST .../import`；intl 系列 | 签到/credits（trae/management.go:91-111） |
| zcode | 自建 billing/balance quota panel（见 registry.json 描述） | 余额面板 |

> 即：**「签到」= 插件 `/checkin`，「任务」= workbuddy `/tasks`+`/tasks/run`，「余额/credits/积分」= 插件 `/credits` 或宿主 `POST /plugins/:id/quota`**。token 与积分的分算由插件响应结构决定，宿主只透传 `pluginapi.QuotaFetchResponse`（plugin_quota.go:297）。

### 4.3 账号管理类 handler 的 import 依赖闭包

以 `internal/api/handlers/management` 包内账号类 handler 为准（`handler.go` L5–L25、`auth_files_fields.go` L3–L25、`auth_files.go`）：

- **internal**：`internal/buildinfo`、`internal/config`、`internal/pluginhost`、`internal/pluginstore`、`internal/auth/claude`、`internal/auth/codex`、`internal/credentialweight`、`internal/watcher/synthesizer`、`internal/logging`（经 server 侧）、`internal/managementasset`（面板/快照）。
- **sdk**：`sdk/auth`（token store 接口/文件实现）、`sdk/cliproxy/auth`（**Auth 结构体 + Manager：账号内存态、Select/Update/ResetQuota**，闭包核心）、`sdk/pluginapi`（quota/路由契约）。
- **外部库**：`gin-gonic/gin`、`sirupsen/logrus`、`golang.org/x/crypto/bcrypt`、`gopkg.in/yaml.v3`、`tidwall/gjson|sjson`（配置 v8 路径写）。

> 闭包的「根」是 `sdk/cliproxy/auth.Manager`：列表/启停/刷新/余额全部围绕它展开。它再向下牵出 `internal/translator`（`main.go` L38 匿名 import）与 `internal/runtime/executor`——**这是删留时最大的隐性牵连**（§6）。

---

## 5. 数据流与状态

### 5.1 账号状态存哪

- **运行时**：内存中的 `sdk/cliproxy/auth.Manager`，每条是 `Auth` 结构体（`sdk/cliproxy/auth`）：`ID/Provider/Label/Status/Disabled/Unavailable/Quota/ModelStates/Attributes/Metadata{tokens,cookies,quota_probe,...}/CreatedAt/UpdatedAt/LastRefreshedAt`。
- **持久化**：`auth-dir` 下每账号一个 `.json`（file token store，默认）。`disabled` 同时写进 auth 文件 JSON（`auth_files_fields.go` L208–L236 `setSourceAuthFileDisabled`）与内存 `Auth.Disabled`。
- **可选外部后端**（账号面板用例都不需要）：Postgres（`PGSTORE_DSN`）、Git（`GITSTORE_*`）、MinIO Object（`OBJECTSTORE_*`）。

### 5.2 启用/禁用、签到、任务是否运行时可变

- **启用/禁用：是，运行时立即生效**。`PATCH /credentials/status` → `authManager.Update(ctx, auth)` 同步内存（`auth_files_fields.go` L128–L146），无需重启。
- **签到/任务：是**，但它们是插件在进程内直接跑上游 HTTP，结果即返，不落宿主全局状态（除插件自己缓存的 credits）。
- **冷却/配额观测**：`auth.Quota`/`ModelStates` 是从上游响应被动记录的运行时态，可 `save-cooldown-status` 落盘。

### 5.3 运行时能否通过 API 增改账号？（开箱即用关键问题）

**能，且这是本服务为「DSH 托管配置」准备好的能力：**

1. **增账号**：`POST /v8/management/credentials`（multipart 上传 或 `?name=xxx.json` + body，`auth_files_crud.go:51`）→ `writeAuthFile`（:261）写入 auth 目录。
2. **改账号**：`PATCH /credentials/fields`（改 label/priority/note/metadata，`auth_files_fields.go:258`）、`PATCH /credentials/status`（启停）。
3. **删账号**：`DELETE /credentials`（单个或 `?all=true`）。
4. **热加载**：`internal/watcher/events.go:36` 同时 `Add(configPath)` 与 `Add(authDir)`，文件落盘后 fsnotify 触发，新账号自动进 `auth.Manager`。
5. **改后端配置**：`PUT/PATCH /v8/management/config[/*path]` → `config.SaveConfigPreserveComments` 写盘 → `reloadConfigAfterManagementSaveAsync` **异步热重载**（`handler.go:189–235`），**无需重启**。

> 结论：**DSH 插件可以完全不碰用户的 config.yaml、不重启后端**——后端地址/端口/管理密钥可由 DSH 首次启动时通过 `PUT /v8/management/config` 或直接生成最小 `config.yaml` 后，后续全部走 Management API。唯一需要重启的配置项是 `server.trusted-proxies`（config.go L17 注释明示）。

---

## 6. 删留清单（verdict 与「账号面板依赖闭包」挂钩）

### 6.1 账号面板用例的最小依赖闭包（必须保留）

```
cmd/server/main.go（瘦身后，仅留起服务分支）
internal/api/            服务器 + 路由 + 中间件（只留 management 组 + NoRoute 插件派发）
internal/api/handlers/management/   账号 CRUD/启停/刷新/quota + ConfigV8 + plugins + 面板静态
internal/config/         配置定义/加载/v8 写/热保存
internal/pluginhost/     插件 dlopen + 路由派发 + quota provider（=签到/任务/余额载体）
internal/pluginstore/    （可选）插件下载安装
internal/watcher/        auth 目录热加载账号（运行时增删改生效的前提）
internal/logging, internal/buildinfo, internal/util, internal/misc, internal/constant
internal/managementasset/（若还要内置 management.html；DSH 自绘面板则可删）
internal/credentialweight, internal/htmlsanitize, internal/httpfetch, internal/interfaces
sdk/auth（file token store）, sdk/cliproxy/auth（Auth Manager）, sdk/pluginapi/pluginabi/pluginhost, sdk/pluginstore
plugins/*.so（cpa-multi-plugins：workbuddy/qoder/trae/zcode/mimo 按需）
```

### 6.2 顶层目录 verdict

| 顶层项 | verdict | 理由 / 删除后影响 |
|---|---|---|
| `cmd/server` | **保留（瘦身后）** | 唯一服务入口。删登录子命令分支。 |
| `cmd/fetch_*`、`cmd/validate_codex_models` | **删除** | 一次性模型目录工具，与面板无关 |
| `internal/api` | **保留（裁剪路由）** | 删代理兼容面 `/v1`、`/v1beta`、realtime/WebRTC、回调；留 management + NoRoute |
| `internal/pluginhost` | **保留** | 签到/任务/余额全靠它加载插件 |
| `internal/pluginstore` | **可选** | 若 DSH 自带 .so 分发则可删；要「插件市场安装」则留 |
| `internal/config` | **保留** | 配置读写/热保存 |
| `internal/watcher` | **保留** | 运行时增删账号热加载 |
| `internal/store` | **删除（默认 file 即可）** | 只留 `sdk/auth` 的 file store；`PostgresStore`/`GitTokenStore`/`ObjectTokenStore` 及 jackc/pgx、minio-go、go-git 依赖可整体删 |
| `internal/translator/*` | **大部分删除** | 协议互译是给「真代理转发」用的；面板不转发。但注意 `main.go` L38 匿名 import 与 executor 的耦合，需逐一验证编译 |
| `internal/runtime/executor` | **大部分删除** | 同上；仅留插件 executor 适配所需最小面 |
| `internal/thinking` | **删除** | reasoning 参数处理，面板无关 |
| `internal/registry` + 远程模型更新 | **删除**（`--local-model` 思路） | 模型目录拉取/更新器，面板不需要 |
| `internal/client/{claude,codex,grokbuild}` | **删除** | 官方客户端模型/live，面板不转发 |
| `internal/tui` | **删除** | Bubbletea 终端 UI，DSH 是外部插件 |
| `internal/home`、`internal/homeplugins` | **删除** | Home 集群控制面（RESP/mTLS），本地面板用不到 |
| `internal/discovery` | **删除** | mDNS/LAN 发现（zeroconf/pion-mdns） |
| `internal/browser` | **删除** | 启动弹浏览器；headless 后端不需要（连带删 local-autobrowser 的自动开面板逻辑） |
| `internal/redisqueue` | **删除/简化** | 用量统计队列；面板不看用量可去（连带 go-redis） |
| `internal/wsrelay` | **删除** | WebSocket 中继会话 |
| `internal/safemode` | **可选** | 示例 key 安全模式，保留无害 |
| `internal/signature`、`internal/cache`、`internal/modelconfig`、`internal/antigravity*` | **删除** | 签名缓存/模型配置/antigravity 专用 |
| `internal/auth/{antigravity,devin,kimi,meta,vertex,xai,claude,codex}` | **按保留供应商裁剪** | 若面板只管 cpa-multi-plugins 的账号，这些内置 OAuth 目录都可删；插件账号不依赖它们 |
| `internal/managementasset` | **可选** | 删了就不内置下载 `management.html`；DSH 自绘面板则删，连带不再需要从 GitHub 拉面板 |
| `sdk/cliproxy/{executor,pipeline,session,usage}`、`sdk/api/handlers/{openai,gemini,claude}`、`sdk/translator` | **删除** | 代理转发管线与对外协议 handler |
| `sdk/cliproxy/auth` | **保留** | Auth/Manager，面板数据根 |
| `examples/` | **删除**（保留 `examples/plugin` 作插件开发参考另说） | 示例，不进生产二进制 |
| `docs/`、`README*.md` | **删除**（仓库内） | 文档，不影响编译 |
| `test/` | **删除** | 集成测试 |
| `Dockerfile`、`docker-compose.yml`、`docker-compose.cluster.yml`、`.env*.example` | **删除** | 用户不手动部署复杂组件；DSH 直接拉起瘦身后二进制即可。cluster/compose 面向集群，无关 |
| `build-local.ps1`、`build-*.sh/.ps1`、`update-upstream.ps1` | **删除** | 本仓库是 Windows 个人构建脚本；Linux 部署不需要 |
| `.github/` | **删除** | CI/Release 工作流 |
| `assets/` | **删除** | README 里的宣传图 |
| `auths/` | **保留目录（空即可）** | 运行时账号文件落点 |

### 6.3 外部库连带可删（go.mod）

`pion/webrtc*`（realtime/WebRTC）、`charmbracelet/*`+`atotto/clipboard`+`skratchdot/open-golang`（TUI/弹浏览器）、`jackc/pgx`+`jackc/*`（Postgres）、`minio-go`（Object store）、`go-git/v6`+`go-billy`+`gcfg`（Git store）、`redis/go-redis`（用量队列）、`libp2p/zeroconf`（mDNS 发现）、`refraction-networking/utls`（TLS 指纹，代理伪装用）、`tiktoken`（token 计数）。**必须保留**：`gin`、`logrus`、`fsnotify`（watcher）、`godotenv`、`yaml.v3`、`bcrypt`、`tidwall/gjson|sjson`（v8 配置路径写）、`google/uuid`。

---

## 7. 最小配置与契约

### 7.1 账号面板工作所需的最小 `config.yaml`（v8 布局）

```yaml
config-version: 8
server:
  host: "127.0.0.1"     # 仅本地；DSH 与后端同机
  port: 8317
management:
  secret-key: "<DSH 生成的强随机管理密钥>"   # 留空则整个 Management API 404
  allow-remote: false   # 同机访问即可；跨机才开（需 MANAGEMENT_PASSWORD 或此项）
  disable-control-panel: true   # DSH 自绘面板，不下载内置 management.html
plugins:
  enabled: true
  dir: "plugins"
  configs:
    workbuddy: { enabled: true, priority: 0 }   # 仅启用用到的插件
    qoder:     { enabled: true, priority: 0 }
    # trae / zcode / mimo 按需
oauth:
  auth-dir: "auths"
```

### 7.2 哪些配置可由 DSH 自动生成/推送

- 首次落盘最小 `config.yaml`（host/port/secret-key/auth-dir/plugins 开关）——DSH 生成。
- 之后全部运行时变更走 Management API，**不必再改文件**：
  - 插件启用/配置：`PUT /v0/management/plugins/:id/config`（`server_management.go:41-42`）或 `PATCH /v8/management/config/plugins.configs.<id>`。
  - 增删改/启停账号：`/v8/management/credentials*`（§4.2）。
  - 拉余额/签到/任务：插件路由 `/v0/management/plugins/<provider>/*`。
- 管理密钥：DSH 自生成随机串，既写进首启 config，也作为后续 `Authorization: Bearer` / `X-Management-Key` 头发给后端（`handler.go:276-296`）。

### 7.3 配置变更是否需要重启

- **账号增删改/启停/插件启用/大部分业务配置：不需要重启**（watcher 热加载 + 管理 API 异步 reload，见 §5.3）。
- **需要重启**：仅 `server.trusted-proxies`（config.go L17 明示）、CGO 插件 ABI/动态库替换本身、监听地址/端口/TLS。
- 注意：管理密钥为空时 Management API 整体关闭（`server.go:243`）；远程访问默认关，需 `allow-remote: true` 或环境变量 `MANAGEMENT_PASSWORD`（`handler.go:73`、`AuthenticateManagementKey` L338）。

---

### 附：关键源码锚点速查

- 入口/本地自动开面板：`cmd/server/main.go:75,830-947`
- 服务器装配/NoRoute：`internal/api/server.go:212-250`
- v8 路由：`internal/api/server_management_v8.go:12-63`；v0 路由：`internal/api/server_management.go:14-201`；代理路由：`internal/api/server_routes.go:43-212`
- 插件 dlopen：`internal/pluginhost/loader_unix.go:114-171`；插件路由派发：`internal/pluginhost/management.go:39,232`
- 账号启停：`internal/api/handlers/management/auth_files_fields.go:28`；账号上传/删除：`auth_files_crud.go:51,132`；余额：`plugin_quota.go:237-298`
- 管理鉴权/热重载：`internal/api/handlers/management/handler.go:266,189-235`
- 配置热加载：`internal/watcher/events.go:30-36`
