# ABI 与 SDK 版本兼容核验

> 宿主：CLIProxyAPI 本地检出 `local-autobrowser`/`c121fde`（v8.0.7 基座，module `.../v8`）。
> 插件：`workbuddy-bridge-0.1.2-source`（module `workbuddy-ai`，go 1.26.0，依赖 `.../v7 v7.2.30`，**SDK v7**）。
> v7 SDK 已拉到本地模块缓存比对（`Go module 缓存 .../v7@v7.2.30`）。只读调研。

---

## 0. 一页结论

**这份插件 DLL 可以原样加载到 v8 宿主上，无需重编译、无需对齐 SDK。**

- **C ABI 完全一致**：导出符号、host_api/plugin_api 结构体布局、buffer 结构、`ABIVersion`（两边都 = **1**）逐字段吻合，宿主 `LoadDLL` 后的版本校验直接通过。
- **RPC 方法面吻合**：插件只调用 4 个 host 回调（auth.list/get、stream.emit/close），宿主 v8 全部派发；宿主向插件发的 method 严格按插件自报能力子集发送，插件 switch 全覆盖，**不会命中 unknown_method**。
- **唯一版本差**：`SchemaVersion` v7=**1** vs 宿主 v8=**6**——这是注册时协商的 RPC 行为版本，宿主对旧 schema 向后兼容（自动退回旧的逐 chunk 行为），**不是加载阻塞项**。
- **建议**：先原样加载跑通；若要吃到 v8 的新 RPC 行为（如 management 响应不做 HTML 转义、流式 chunk 精简），再把插件 go.mod 重钉到 v8 SDK 重编译即可，非必需。

---

## 1. C ABI 符号与签名比对

### 1.1 导出符号
| 项 | 宿主期望（loader_windows.go） | 插件导出（plugin.go） | 一致？ |
|---|---|---|---|
| 初始化符号 | `FindProc("cliproxy_plugin_init")`（loader_windows.go:86） | `//export cliproxy_plugin_init`（plugin.go:89） | ✅ |
| 调用 | `proc.Call(hostAPI, &pluginAPI)` → 插件填 plugin_api | `cliproxy_plugin_init(host, plugin) C.int`（:90） | ✅ |
| 插件 call/free/shutdown | 经 plugin_api 函数表调用 | `cliproxyPluginCall/Free/Shutdown`（:102/125/132） | ✅ |

### 1.2 结构体布局（C 层，逐字段顺序/类型）
`cliproxy_host_api`（插件 plugin.go:28-33）vs 宿主（loader_unix.go:43-50 / windowsHostAPI）：

| 顺序 | 插件 C 定义 | 宿主侧 | 一致？ |
|---|---|---|---|
| 1 | `uint32_t abi_version` | `uint32 abiVersion` | ✅ |
| 2 | `void* host_ctx` | `uintptr hostCtx` | ✅ |
| 3 | `host_call_fn call` | fn 指针 | ✅ |
| 4 | `host_free_fn free_buffer` | fn 指针 | ✅ |

`cliproxy_plugin_api`（插件 :39-44）vs 宿主（windowsPluginAPI loader_windows.go:37-42）：`uint32 abi_version; call; free_buffer; shutdown` —— ✅ 逐字段一致。

buffer（`cliproxy_buffer{void* ptr; size_t len}` 插件 :20-23）vs 宿主 `windowsBuffer{ptr uintptr; len uintptr}`（loader_windows.go:25-28）—— ✅。

### 1.3 ABI 版本常量（决定能否加载的硬校验）
| 侧 | 常量值 | 文件:行 |
|---|---|---|
| 插件 SDK v7 | `pluginabi.ABIVersion uint32 = 1` | v7 `sdk/pluginabi/types.go:7` |
| 宿主 v8 | `pluginabi.ABIVersion uint32 = 1` | 宿主 `sdk/pluginabi/types.go:7` |
| 宿主运行时校验值 | `pluginHostABIVersion = pluginabi.ABIVersion` (=1) | 宿主 `internal/pluginhost/abi.go:9` |
| 插件上报 | `plugin.abi_version = pluginabi.ABIVersion` | 插件 `plugin.go:95` |
| 宿主校验点 | `if client.api.abiVersion != pluginHostABIVersion { 报错 }` | 宿主 `loader_windows.go:117-119` |

**两边都 = 1 → 校验通过，DLL 可被加载。**

---

## 2. host 回调 method 面比对

### 2.1 插件 → host（插件主动调用的 method）
插件 `grep hostCall(...)` 全清单（plugin.go / management.go）：

| method 字符串 | 插件调用点 | 宿主 v8 是否派发 |
|---|---|---|
| `host.stream.emit` | plugin.go:170,184 | ✅（host 流式桥） |
| `host.stream.close` | plugin.go:190 | ✅ |
| `host.auth.list` | management.go:191 | ✅（host_callbacks.go:174） |
| `host.auth.get` | management.go:223 | ✅（host_callbacks.go:176） |

> 共 4 个，宿主 v8 全部实现。没有宿主不认识的 method。

### 2.2 host → 插件（宿主按插件能力派发的 method）
插件自报能力（plugin.go:268-279）：`model_provider, auth_provider, executor, management_api`；**未报** scheduler / usage / interceptor / thinking / model-router。

宿主据此只会向插件发：

| method | 插件 handleMethod 是否接住 |
|---|---|
| `plugin.register` / `plugin.reconfigure` | ✅ plugin.go:308 |
| `model.static` / `model.for_auth` | ✅ :310/:312 |
| `auth.identifier` / `auth.parse` / `auth.refresh` | ✅ :314/:316/:322 |
| `executor.identifier` / `executor.execute` / `execute_stream` / `count_tokens` | ✅ :324-330 |
| `management.register` / `management.handle` | ✅ :332/:334 |

**不会发给它的 v8 新 method**（因能力未注册，宿主不触发）：`request.translate/intercept*`、`response.intercept*`、`thinking.apply`、`usage.handle`、`scheduler.pick`、`model.route`、`websocket.response_event`、`request.complete`。
> 插件 default 分支返回 `unknown_method`（:336），但这些 method 根本不会被派发 → 静默不触发，无副作用。

---

## 3. SDK v7 vs v8 字段漂移

### 3.1 信封与版本
| 项 | v7.2.30 | v8.0.7 | 漂移影响 |
|---|---|---|---|
| `ABIVersion` | 1 | 1 | 无（见 §1.3） |
| `SchemaVersion` | **1**（types.go:11） | **6**（types.go:20） | 插件注册时报自己的 1；宿主按"旧 schema"兼容路径处理（保留逐 chunk 请求体等），**非阻塞** |
| JSON Envelope | `{ok, result, error}` | `{ok, result, error}` | 一致 |

### 3.2 插件实际用到的 pluginapi 结构体（v7 vs v8 逐字段比对）
全部**逐字段一致**：

| 结构体 | 结论 |
|---|---|
| `Metadata{Name,Version,Author,GitHubRepository,Logo,ConfigFields}` | 一致 |
| `ConfigField{Name,Type,EnumValues,Description}` | 一致 |
| `ConfigFieldTypeString = "string"` | 一致（v7:41 / v8:44） |
| `ExecutorRequest{AuthID,AuthProvider,Model,Format,Stream,Alt,Headers,Query,OriginalRequest,SourceFormat,Payload,Metadata}` | 一致 |
| `ExecutorResponse{Payload,Headers,Metadata}` | 一致 |
| `ExecutorStreamChunk{Payload,Err}` | 一致 |
| `ManagementRoute{Method,Path,Menu,Description,Handler}` | 一致 |

### 3.3 关键 RPC 载荷字段名
- **execute_stream 信封**：插件读 `stream_id` / `host_callback_id`（plugin.go:289-293）；宿主 v8 发的正是这两个 JSON tag（host_callbacks.go:46、rpc_schema.go:62）—— ✅。
- **management.register 响应**：宿主期望 `{routes[], resources[]}`（internal/pluginhost rpcManagementRegistrationResponse）；插件返回 `{Routes:[{GET /accounts}], Resources:[{/panel}]}`（management.go）—— ✅。
- **quota**：本插件未实现 quota provider（未报该能力），无漂移面。

> 结论：无字段级破坏性漂移。加载不会失败；方法派发正常；运行时不会因字段名不一致报错。

---

## 4. 结论与最小对齐清单

### 判定：**直接加载可行**，无需重编译、无需改宿主。

依据链：C ABI 版本号相等(1) → LoadDLL+init 握手通过；结构体布局一致 → 内存安全；method 字符串一致 → 派发命中；payload 结构体一致 → JSON 编解码对齐；SchemaVersion 差由宿主向后兼容吸收。

### 建议动作（按优先级）
1. **直接把 `workbuddy-bridge.dll` 放进宿主 `plugins/` 目录**，`plugins.configs.workbuddy-bridge.enabled=true`，启动跑一条 `workbuddy-bridge/<model>` 请求冒烟。
2. **冒烟要点**：① `GET /v0/management/plugins/workbuddy-bridge/accounts`（验 management.register/handle）；② 一次 `executor.execute_stream` 流式请求（验 stream_id + host.stream.emit/close 异步流）；③ `host.auth.list/get` 返回的账号列表。
3. **（可选，非必需）**若要吃到 v8 的新 RPC 行为（management 响应不 HTML-转义、流式 chunk 精简到 schema v6），把插件 `go.mod` 的 `.../v7 v7.2.30` 重钉到宿主同版 SDK 后用 `-buildmode=c-shared` 重编译；**宿主侧不用动**。
4. **宿主侧无需任何改动**。

### 唯一需留意的运行时行为差
- 插件报 `SchemaVersion=1`，宿主会按 v8 注释里的"旧 schema"路径，在每个流式 chunk 拦截调用里多传 `OriginalRequest/RequestBody/HistoryChunks`（v8 仅 schema≥3/5 才省）。本插件不注册 stream 拦截器，所以这一差异**实际不影响它**，只是宿主侧多做一点序列化。

---

### 附：关键源码锚点
- ABI 常量：宿主 `sdk/pluginabi/types.go:7`；插件 v7 `.../v7@v7.2.30/sdk/pluginabi/types.go:7`
- 加载校验：宿主 `internal/pluginhost/loader_windows.go:86,117`
- C struct：插件 `plugin.go:28-44,90-100`
- host method 派发：宿主 `internal/pluginhost/host_callbacks.go:174-176`
- host→plugin 方法表：宿主 `internal/pluginhost/rpc_client.go:410-640`、`rpc_client_stream.go:24`
- 插件能力与 switch：插件 `plugin.go:268-279,306-338`
