# 中转最小服务架构与 Windows 构建

> 调研对象同前：`CLIProxyAPI` @ `local-autobrowser`/`c121fde`（module `.../v8`，`go 1.26.0`）。
> 本轮目标变化：把后端当成「**多渠道平台中转 ProxyAPI**」做最小化——保留请求转发主链路，删除账号面板的运营特性；只交付 **Windows**。
> 仍为只读调研，未改代码。

---

## 0. 一页结论

1. **中转主链路 = `OpenAI handler → 模型路由(插件 ModelRouter) → 二选一执行：插件 executor / 内置 executor → AuthManager 选号(round-robin/weighted/fill-first) → 流式回传`**。
2. **cpa-multi-plugins 渠道走「插件 executor」路径，根本不碰内置 claude/codex/gemini 执行器**——它们是「executor candidate provider」，宿主把该 provider 的执行权整体交给插件。
3. **模型名→渠道的映射有两处**：默认靠全局模型注册表 `registry.GetGlobalRegistry().GetModelProviders(model)`（内置 catalog + 插件运行时注册的模型）；插件可用 ModelRouter 把模型名改道到自己的 executor。「模型选择」最终落在**注册表里的模型→provider 映射**，不是一个独立配置项。
4. **Windows 构建：宿主用纯 Go `syscall.LoadDLL` 加载 .dll，理论上可 `CGO_ENABLED=0`；但现成脚本 `build-local.ps1` 强制 `CGO_ENABLED=1` + 自带 MinGW。按 proven 路径走最稳**。Go 工具链需 **1.26**。
5. `/healthz` 是唯一健康端点；「自检」靠 `POST /v8/management/requests/api-call`（手动探针）+ 插件侧 `/credits`/`/cooldowns`，没有独立的 test 端点。

---

## 1. 中转请求全链路（文件级）

以 `POST /v1/chat/completions`（OpenAI 兼容）为例：

| 段 | 位置（文件:行） | 做什么 |
|---|---|---|
| 路由 | `internal/api/server_routes.go:67` | `v1.POST("/chat/completions", openaiHandlers.ChatCompletions)`，挂 `AuthMiddleware(accessManager)`（:64） |
| 入口鉴权 | `internal/access/...`（`AuthMiddleware`） | 校验 `Authorization: Bearer <access.api-keys 里的 key>`，即中转客户端的密钥 |
| handler | `sdk/api/handlers/openai/openai_handlers.go:115` `ChatCompletions` | 解析 body、取 `model`、`stream` |
| 发起执行 | `openai_handlers.go:486/603` → `BaseAPIHandler.ExecuteStreamWithAuthManager`（`sdk/api/handlers/handlers_stream.go:21`） | 唯一执行入口 |
| **模型路由** | `handlers_stream.go:301` `h.applyModelRouter(...)` → `handlers_routing.go:325` | 若有插件注册 ModelRouter，调用 `host.RouteModel()`（pluginhost.ModelRouterHost），返回 `ExecutorPluginID` / `Provider` / `TargetModel` |
| **A. 插件执行** | `handlers_stream.go:311` → `streamWithPluginExecutor`（:30）→ `host.ExecutePluginExecutorStream(...)`（:70） | 命中 `ExecutorPluginID` 时，整条流交给插件 executor |
| **B. 内置执行（解 provider）** | `handlers_stream.go:313` `providersForExecution(...)` → `handlers_routing.go:128/159` | 无插件路由时，`util.GetProviderName(baseModel)`（`internal/util/provider.go:46`）→ `registry.GetGlobalRegistry().GetModelProviders(model)` 得到 provider 列表 |
| 执行请求组装 | `handlers_stream.go:335-353` | `coreexecutor.Request{Model,Payload}` + `Options{SourceFormat/ResponseFormat 翻译方向, Headers, Stream}` |
| **选号** | `handlers_stream.go:365` `h.AuthManager.ExecuteStream(ctx, providers, req, opts)` → `sdk/cliproxy/auth/conductor_execution.go:235` | 按 provider 列表逐个尝试，`executeStreamMixedOnce`（:911）内用 Selector 选具体账号 |
| 选择策略 | `sdk/cliproxy/auth/selector.go:27` RoundRobin / :39 WeightedRoundRobin / fill-first；配置 `routing.strategy`（config_types.go:357） | 默认 round-robin；账号级 `priority`/`weight`（internal/credentialweight）决定加权 |
| 渠道执行 | `internal/runtime/executor/<provider>_executor.go` | 内置 provider 执行器发上游 HTTP/WS；插件渠道则由插件 executor 自己发 |
| 流式回传 | `handlers_stream.go:604-745` goroutine | `streamResult.Chunks` 逐个读出 → SSE `data:` 帧写回客户端，bootstrap 失败自动换号重试（:557-598） |

### 模型名 → 渠道/模型映射到底发生在哪

- **默认映射源 = 全局模型注册表**：`internal/util/provider.go:46` `GetProviderName` → `registry.GetGlobalRegistry().GetModelProviders(modelName)`。注册表内容 = 内置 catalog（`models.json`/`codex_client_models.json`，远程更新或 `--local-model` 离线内嵌）**∪ 插件运行时注册的模型**（`sdk/cliproxy/service_executors.go:428 registerResolvedModelsForAuth`、:498 `tryRegisterPluginModelsForAuth`）。
- **插件 ModelRouter 可改道**：`handlers_routing.go:325 applyModelRouter`，把某模型名直接映射到插件 executor（`ModelRouteTargetSelf/Executor`）或改写到指定 provider+目标模型名（`TargetModel`）。
- **「模型选择」这个配置项落在哪个 API/字段**：
  - 不是一个独立开关。对纯插件中转，模型清单由插件自报并注册进注册表；面板侧「模型下拉」= `GET /v1/models`（`openai_handlers.go:62` → `registry.GetAvailableModels("openai")`）。
  - 若要把「用户填的模型名」映射到「上游真实模型名」，走两条路：(a) 插件 ModelRouter 的 `TargetModel`；(b) OpenAI-compat 账号里的模型别名配置。宿主本身没有「全局模型映射表」配置项。

---

## 2. 中转最小闭包

在上一轮「账号面板闭包」基础上，中转场景**反过来**：保留转发管线，砍运营特性。

### 2.1 必须保留（模块级）

| 模块 | 理由 |
|---|---|
| `internal/api`（server/路由/middleware） | HTTP 入口；保留 `/v1/*`、`/v1/models`、`/healthz` |
| `sdk/api/handlers/{openai,gemini,claude}`（保留 openai 为主） | 对外兼容协议入口；中转至少留 OpenAI 兼容 |
| `sdk/api/handlers`（base：stream/routing/execution/interceptors） | 全链路分发骨架（handlers_stream.go 等） |
| `sdk/cliproxy/auth`（Manager/Selector/conductor） | 选号、重试、冷却、会话亲和——中转核心 |
| `sdk/cliproxy/executor`、`sdk/cliproxy/session`、`sdk/cliproxy/usage` | 执行请求结构、会话、用量 |
| `sdk/cliproxy/service*.go`（executor 注册）+ `model_registry.go` | 按 auth 绑 executor、注册模型 |
| `internal/runtime/executor` **最小面** | 至少 `openai_compat_executor.go`（通用转发骨架）+ `helps/`（UsageReporter）；内置各 provider 执行器按 §3 裁剪 |
| `internal/pluginhost` | 加载 cpa-multi-plugins executor/ModelRouter/AuthProvider |
| `internal/watcher` + `internal/config` | 账号/配置热加载（增删渠道账号不停机） |
| `internal/translator` **最小面** | 至少 OpenAI↔OpenAI-compat 所需；纯插件渠道插件自译，可删大部分 |
| `internal/credentialweight`、`internal/interfaces`、`internal/util`、`internal/constant`、`internal/thinking`(suffix 解析) | 选号权重、接口、模型后缀解析 |
| `internal/logging`、`internal/buildinfo`、`internal/misc`、`internal/cache`(如插件签名需要) | 基础 |
| `access`（`access.api-keys` 鉴权中间件） | 中转客户端鉴权 |

### 2.2 可进一步删除（相对上一轮面板闭包）

| 删除项 | 影响 |
|---|---|
| 余额/签到/任务管理路由与 handler（`plugin_quota.go`、`auth_files_status_sync.go`、插件 `/checkin` `/tasks` `/credits` 的前端运营面） | 中转不需要；但插件 `.so` 本身仍要加载（它同时提供 executor/AuthProvider） |
| OAuth 登录子命令与回调（`-codex-login` 等、`/anthropic/callback` 等、`internal/cmd` 登录流程） | 账号由 DSH 直接 import，不跑 OAuth |
| `internal/managementasset`（下载 management.html） | DSH 不看内置面板 |
| v0 冗长配置三元组路由（约 90 条） | 只留 `/v8/management/config` |
| TUI、Home、discovery、WebRTC/realtime、Redis 队列、Postgres/Git/Object 存储 | 上一轮已列 |

### 2.3 删除时必须编译验证的牵连点

- **`cmd/server/main.go:38` 匿名 import** `_ "...internal/translator"`：删 translator 子包会编译失败，必须同步删 import 或保留用到的格式注册。
- **`registerExecutorForAuth` 的 switch（service_executors.go:281-328）**：删内置 executor 前要确认没有任何 auth 的 `Provider` 命中对应 case，否则运行时 panic。
- **`main.go` 存储后端选择链**：保留 file 分支即可，但 Postgres/Git/Object 的 import（pgx/go-git/minio）要一并删才会缩小体积。
- **`go.mod` 连带依赖**：删 pion-webrtc、charmbracelet、pgx、minio、go-git、go-redis、zeroconf、utls、tiktoken 后跑 `go mod tidy`。

---

## 3. 内置 provider 与插件 provider

**结论：内置 claude/codex/gemini/kimi/xai/devin/meta/antigravity/vertex/aistudio 执行器可以整体删除——前提是中转只接 cpa-multi-plugins 渠道。**

依据（`sdk/cliproxy/service_executors.go:245 registerExecutorForAuth`）：

- 内置 provider（claude/codex/gemini/kimi/xai/...）走 `NewClaudeExecutor` 等（:283-313），**只为内置 OAuth 账号服务**。
- 插件渠道命中 `default` 分支（:314-328）：若 `pluginHost.HasExecutorCandidateProvider(providerKey)` 为真（:319），宿主**主动 unregister 原生 compat executor 并 return**（:322），执行权完全交给插件 executor。
- 因此**插件 executor 是独立于内置执行器的一条路**（`handlers_stream.go:311 streamWithPluginExecutor`），删内置执行器不影响插件执行。

**必须保留的最小 executor 骨架**：
1. `internal/runtime/executor/openai_compat_executor.go` —— 通用 OpenAI 兼容转发器（即便插件自己执行，注册/包装逻辑 `registerOpenAICompatProviderExecutor` 仍引用它）。
2. `internal/runtime/executor/helps/` —— UsageReporter（统计/重试要用）。
3. `sdk/cliproxy/executor` 接口与 `coreauth.ProviderExecutor` 抽象 —— 插件 executor 也要实现这套接口（`adapters_executors.go` 把插件 executor 包成 `ProviderExecutor`）。

> 即：executor 框架本身（接口 + OpenAICompat 骨架 + pluginhost 适配器）要留；内置各厂商执行器可删。删除后需用一条真实插件渠道请求做冒烟。

---

## 4. Windows 构建与运行最小路径

### 4.1 前提
- **Go 工具链：1.26**（`go.mod` 首行 `go 1.26.0`）。
- **插件加载机制（Windows）**：`internal/pluginhost/loader_windows.go`（`//go:build windows`）用 **纯 Go `syscall.LoadDLL` + `FindProc("cliproxy_plugin_init")`**（:81-86）+ `syscall.NewCallback` 回调（:47-48），**不依赖 cgo dlopen**。加载前先 shadow-copy 到 `%TEMP%\cliproxy-pluginhost\pid-<pid>\`（:128-190，因 Windows 不允许覆盖已映射 DLL）。
- **CGO 要求**：
  - `loader_unix.go` = `cgo && (linux/darwin/freebsd)`；`loader_windows.go` = 仅 `windows`；`loader_unsupported.go` = `!cgo && !windows`。
  - **推论：Windows 宿主即便 `CGO_ENABLED=0` 也能编译出可用的插件加载器**（loader_windows.go 无 cgo 门禁）。
  - 但 `build-local.ps1` 显式 `CGO_ENABLED=1` 并自带 `.toolchain/mingw64`（MinGW gcc）。**按 proven 路径走最稳**；若想去掉 MinGW 依赖，可试 `CGO_ENABLED=0 go build` 并用一条插件请求冒烟验证。
- **cpa-multi-plugins 的 .dll**：Go 插件用 `//export cliproxy_plugin_init`，**插件自身需 cgo 编译**；宿主只加载产物 `.dll`，不参与插件编译。

### 4.2 build-local.ps1 在做什么（`build-local.ps1`）
1. 检查 `cli-proxy-api.exe` 没在跑；
2. 要求 `.toolchain\mingw64\bin\gcc.exe` 存在；
3. 设 `PATH` 加 MinGW、`CGO_ENABLED=1`、`GOOS=windows`、`GOARCH=amd64`、`GOPROXY=goproxy.cn`；
4. 取 `git describe --tags` 版本 + commit + buildDate；
5. `go build -ldflags="-s -w -X main.Version=.. -X main.Commit=.. -X main.BuildDate=.." -o cli-proxy-api.exe ./cmd/server`。

### 4.3 Windows 从零构建并本地运行（最小步骤）

```powershell
# 1. 装 Go 1.26+（无需 Docker/Linux）
# 2. 取依赖（国内代理）
$env:GOPROXY="https://goproxy.cn,direct"

# 3. 编译（proven：CGO=1 + 自带 MinGW；如已瘦身删完 cgo 依赖可试 CGO_ENABLED=0）
$env:CGO_ENABLED="1"; $env:GOOS="windows"; $env:GOARCH="amd64"
go build -ldflags="-s -w" -o cli-proxy-api.exe ./cmd/server

# 4. 准备运行目录（三个东西）：
#    config.yaml（见 §5）
#    plugins\*.dll        <- cpa-multi-plugins 编译产物（qoder/trae/workbuddy/zcode/mimo）
#    auths\*.json         <- 各渠道账号凭据（由 DSH 通过 Management API 或直接落盘）

# 5. 运行
.\cli-proxy-api.exe --config config.yaml
```

- 砍掉 Dockerfile / docker-compose(.cluster) / `.env*.example` / `build-local.ps1` 之外的 Linux·macOS 脚本（`docker-build.sh` 等）**不影响**上述 Go 原生构建与运行——它们只是容器化封装。
- 产物：单个 `cli-proxy-api.exe` + `plugins\` 目录 + `auths\` 目录 + `config.yaml`。

---

## 5. 中转最小 `config.yaml`（v8）

```yaml
config-version: 8
server:
  host: "127.0.0.1"
  port: 8317
# management：中转主链路不强依赖。若 DSH 要远程改配置/加账号则「留」，否则「删」。
management:
  secret-key: "<DSH 生成的管理密钥>"   # 留=DSH 可远程推送配置/账号；删=只能本地改文件
  disable-control-panel: true
access:
  api-keys:
    - key: "<中转客户端用的 OpenAI 兼容密钥>"   # /v1 调用鉴权；可留多个
oauth:
  auth-dir: "auths"
routing:
  strategy: "round-robin"          # round-robin | weighted-round-robin | fill-first
  # session-affinity: true
plugins:
  enabled: true
  dir: "plugins"
  configs:
    workbuddy: { enabled: true, priority: 0 }
    qoder:     { enabled: true, priority: 0 }
    # trae / zcode / mimo 按需启用
requests:
  proxy-url: ""                    # 如需上游代理
```

- **management 留/删判断**：DSH 配置页要远程改配置/加账号/启停渠道 → **留**（必须配 `secret-key`）；若 DSH 只生成静态 config.yaml、不远程管理 → 可删整个 management 组（删后 `/v8/management` 全 404，但 `/v1` 转发照常）。
- **模型列表依赖**：纯插件中转时模型清单由插件注册进全局注册表；`--local-model`（离线内嵌 catalog）可替代远程模型更新，无需联网拉模型目录。

---

## 6. 配置页候选字段 → API 映射

| 配置页字段 | 现有端点 / config 路径 | 说明 |
|---|---|---|
| 模型选择（用户可选模型列表） | `GET /v1/models`（数据源）；实际模型→渠道映射由插件 ModelRouter 决定，无独立 GET/PUT | 下拉数据直接读 `/v1/models` |
| 启用某渠道插件 | `PUT /v8/management/config/plugins.configs.<id>`（body `{"enabled":true}`）或 `PATCH .../plugins.configs.<id>.enabled` | 热生效，见 v8 配置 API |
| 渠道插件具体参数 | `PUT /v0/management/plugins/<id>/config`（`server_management.go:41-42`） | 插件自定义配置 |
| 启用/禁用某账号 | `PATCH /v8/management/credentials/status`（`auth_files_fields.go:28`） | 运行时生效 |
| 新增/删除账号 | `POST/DELETE /v8/management/credentials` | 运行时生效（watcher 热加载） |
| 选号策略 | `PUT /v8/management/config/routing.strategy`（值 `round-robin`/`weighted-round-robin`/`fill-first`） | config_types.go:357 |
| 中转客户端密钥 | `PUT /v8/management/config/access.api-keys` | /v1 鉴权 |
| **检查/自检类能力** | 见下 | 后端枚举 |

**后端存在的「检查/自检」能力枚举：**
- `GET/HEAD /healthz`（`server_routes.go:52`）——存活探针，唯一标准健康端点。
- `POST /v8/management/requests/api-call`（`server_management_v8.go`）——手动发一次测试请求，可当「连通性自检」。
- `POST /v8/management/credentials/refresh`——刷新 token，可验证账号凭据有效性。
- 插件侧：`GET /v0/management/plugins/<provider>/credits`（实时额度）、`GET .../cooldowns`（账号冷却/不可用状态）——渠道级健康。
- `POST .../checkin`（签到，运营任务，非健康检查）。
- **`keepalive`**：是 SSE 流保活参数（`requests.stream-keepalive`），不是自检端点。
- **`scheduler_mode` / `checkin_auto`**：属插件内部配置，不在宿主管理路由里统一暴露；宿主侧没有通用定时任务调度 API。

> 即：配置页「检查」建议 = `/healthz`（存活）+ `POST /v8/management/requests/api-call`（连通性）+ 插件 `/credits`/`/cooldowns`（渠道健康）。

---

### 附：关键源码锚点（本轮新增）
- 执行分发：`sdk/api/handlers/handlers_stream.go:297`（`executeStreamWithAuthManagerFormats`）、:311 插件路径、:365 内置路径
- 模型→渠道解析：`sdk/api/handlers/handlers_routing.go:159`（`getRequestDetailsWithOptions`）、`internal/util/provider.go:46`（`GetProviderName`）、`handlers_routing.go:325`（`applyModelRouter`）
- 选号：`sdk/cliproxy/auth/conductor_execution.go:235`、`selector.go:27/39`
- executor 注册：`sdk/cliproxy/service_executors.go:245`（`registerExecutorForAuth`）、:319 插件接管分支
- /v1/models：`sdk/api/handlers/openai/openai_handlers.go:62`
- Windows 加载：`internal/pluginhost/loader_windows.go:81`（LoadDLL）、:128（shadow copy）
- 构建：`build-local.ps1`（CGO=1+MinGW，`go build -o cli-proxy-api.exe ./cmd/server`）
