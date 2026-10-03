# workbuddy-bridge-0.1.2-source 深潜与方案收敛

> 只读调研。仓库：`workbuddy-bridge-0.1.2-source`（main @ `a1536df`，tag `v0.1.2`，纯源码投放，无 scripts/.github/Makefile）。对照仓库：`cpa-multi-plugins`（workbuddy/qoder/trae）与宿主 `CLIProxyAPI`（本地已 checkout，module path 已是 `/v8`）。
>
> 行号均指当前磁盘文件。代码常量是唯一事实来源；注释/README 与代码冲突时逐条标注。

---

## 0. 先回答你点名的那处不一致：provider id 到底是什么

**结论：运行时 provider id 是 `workbuddy-bridge`，不是 `workbuddy-ai`。你亲读的 plugin.go:75 代码常量是对的；文件头 9–11 行注释是 stale（漂移）。README 与代码一致，应以代码+README 为准。**

证据（grep 全仓 `workbuddy-ai` / `providerName`）：

- 运行时常量：`plugin.go:75  providerName = "workbuddy-bridge"`（带注释 71–74 行解释命名由来：「"workbuddy-bridge" names the dsh-workbuddy-bridge origin … staying clearly distinct from the cpa-multi-plugins "workbuddy" plugin」）。
- **所有运行时行为都从这个常量派生**，没有一处硬编码 `workbuddy-ai` 当 id：
  - auth 文件认领前缀：`auth.go:28  strings.HasPrefix(lower, providerName+"-")` → 实际认领 `workbuddy-bridge-*.json`。
  - 写入 AuthData.Provider：`auth.go:58`、`auth.go:110`。
  - 出站剥模型前缀：`executor.go:44-45  HasPrefix(m, providerName+"/")` → 剥 `workbuddy-bridge/`。
  - 管理面板路由：`management.go:44-45  "/v0/management/plugins/"+providerName+"/accounts"`、`/panel`。
  - excluded-models 键：`models.go:67  req.Host.ExcludedModels[providerName]`。
  - 注册名 / identifier：`plugin.go:259, 315, 325`。
- `workbuddy-ai` 这个字符串只残留在三类**非身份**位置：
  1. **注释**：`plugin.go:1,5,10,11`、`auth.go:1,4,19,20`、`wire.go:3,46`。其中 `plugin.go:10-11`「owns `workbuddy-ai-*` auth files … exposes itself as provider `workbuddy-ai`」正是你发现的那句——它在常量改名后没跟着改。
  2. **go.mod module 名**：`go.mod:1  module workbuddy-ai`（Go 模块路径，与 CPA provider id 是两回事，c-shared 插件 `package main` 不导出模块名，对宿主不可见）。
  3. **面向人的 cosmetic 字符串**：登录报错文案 `plugin.go:319,321`、账号 label 兜底 `auth.go:83  "workbuddy-ai account"`。这些不参与认领/路由。
  4. 唯一一个「像行为」的残留：`auth.go:24` 的 `isOursAuthFile` 仍把声明 `type:"workbuddy-ai"` 列为可认领类型之一——这是**宽松认领**（方便把 cpa-multi-plugins 导出的 `type:"workbuddy-ai"` 文件也收编），不影响本插件自己写盘的文件名前缀。

**为什么注释与代码不一致**：作者把 provider id 从早期的 `workbuddy-ai` 改名为 `workbuddy-bridge`（对齐 dsh-workbuddy-bridge 血缘、并与 cpa-multi-plugins 的 `workbuddy` 三方互不冲突），但只改了常量本身 + README + 由常量派生的路由，漏改了文件头块注释和 go.mod 模块名。README（`README.md:33`「插件认领文件名前缀为 `workbuddy-bridge-`」、`:37` `"provider": "workbuddy-bridge"`、`:66` 模型名 `workbuddy-bridge/deepseek-v4.1-flash`）是改名后的版本，与代码自洽。**即：注释漂移，不是行为 bug；本插件运行时是自洽的 `workbuddy-bridge`。**

---

## 1. 构建逻辑全链：源码 → Windows .dll

### 1.1 根本原因：为什么宿主能「零 cgo」而插件必须 cgo

CPA 宿主与插件是**两个独立 Go 进程内的 Go runtime**，靠 C ABI 边界通信，不能用 Go 原生 `plugin` 包（Go `plugin` 仅支持 Linux、且要求主程序与插件同版本同编译，无法跨版本分发 .dll）。因此：

- **插件侧必须 `-buildmode=c-shared`**：它要导出 C 可解析符号（`cliproxy_plugin_init` / `cliproxyPluginCall` / `cliproxyPluginFree` / `cliproxyPluginShutdown`，见 `plugin.go:89,102,125,132`），供宿主按名字 dlsym/GetProcAddress 取出。c-shared 会把**一整套 Go runtime 打进 .dll**——这正是 cpa-multi-plugins `workbuddy/main.go:439-440` 的注释：「c-shared .so has its own Go runtime, so usage.PublishRecord would hit a separate empty DefaultManager」。
- **宿主侧 Windows 构建零 cgo**：本地宿主 `internal/pluginhost/loader_windows.go`（`//go:build windows`）用纯 syscall 加载——`syscall.LoadDLL(loadPath)`（`:81`）、`syscall.NewCallback(...)`（`:47-48`）、`syscall.SyscallN(...)`（`:303`），**整个 Windows 宿主 exe 不 import C**。宿主只在 Unix 才用 cgo：`loader_unix.go`（`//go:build cgo && (linux||darwin||freebsd)`，`#cgo LDFLAGS: -ldl`，`dlopen`）。
- **不对称的本质**：编译**宿主 exe** 不需要 mingw（Windows 版纯 Go）；但编译**插件 dll** 必须有 C 工具链——c-shared 的 cgo 导出机制需要一个外部 C 编译器来产出 PE 并接线。这就是「宿主零 cgo、插件必须 cgo」的根本原因。

### 1.2 准确命令序列（Windows，MSYS2 MinGW64）

与 `cpa-multi-plugins/scripts/build.sh:38-59` 及 `.github/workflows/release.yml:88-123` 逐项核对后，本仓库 README（`README.md:70-74`）给的 flags 与 CI 完全一致。Windows 构建机需要：

1. Go ≥ 1.26（release.yml:85 `go-version: '1.26'`；本仓库 `go.mod:3  go 1.26.0`）。
2. MSYS2，`msystem: MINGW64`，包 `mingw-w64-x86_64-gcc`（release.yml:92-93）。装好后 PATH 上的 `gcc` 即 `x86_64-w64-mingw32-gcc`。

命令形态（在 MSYS2 MINGW64 shell 里，对应 release.yml:97-123 的 Windows 分支）：

```bash
export GOOS=windows GOARCH=amd64 CGO_ENABLED=1
export CC=gcc          # MSYS2 MINGW64 把 x86_64-w64-mingw32-gcc 暴露成 gcc
cd workbuddy-bridge-0.1.2-source
go mod download
go build -buildmode=c-shared -trimpath -ldflags="-s -w" -o workbuddy-bridge.dll .
```

- **产物名**：`workbuddy-bridge.dll`（README:73 `-o workbuddy-bridge.dll`；与 cpa-multi-plugins 按插件名命名 `<plugin>.dll` 的约定一致，build.sh:58 `OUT_FILE="$OUT_DIR/${plugin}.${EXT}"`）。
- build.sh 本地脚本的默认 CC 写法（build.sh:46-48）是 `CC=x86_64-w64-mingw32-gcc`，而 release.yml 在 MSYS2 shell 里直接 `CC=gcc`（:103）——**两者等价**，因为 MSYS2 MINGW64 环境已把交叉 gcc 放到 `gcc` 这个名字上。
- 跨平台产物后缀矩阵（build.sh:30-35）：Linux `.so` / macOS `.dylib` / Windows `.dll`。release.yml 矩阵（:33-75）：linux-amd64、linux-arm64、darwin-arm64、darwin-amd64(optional 交叉)、**windows-amd64（唯一 Windows 目标）**。

### 1.3 与 cpa-multi-plugins CI 逐项对比

| 维度 | cpa-multi-plugins（有 CI） | workbuddy-bridge（本仓库） |
|---|---|---|
| 构建脚本 | `scripts/build.sh`（:59）一条 `go build -buildmode=c-shared -trimpath -ldflags="-s -w"` | README:73 同一条 flags，**逐字相同** |
| CI | `.github/workflows/release.yml` tag `v*` 触发，5 平台矩阵，`actions/setup-go@v5` + `msys2/setup-msys2@v2` | **无 .github、无 scripts、无 Makefile**——纯源码投放 |
| Windows runner | `windows-latest` + MSYS2 MINGW64 + `mingw-w64-x86_64-gcc`（:69-95） | 需自建同等环境 |
| 发布物 | `cpa-multi-plugins-windows-amd64.zip` 内含 5 个 dll，softprops/action-gh-release 发 GitHub Release（:151-262） | 无 Release、无 zip、无附件 |
| 构建插件数 | build.sh 列 3 个（workbuddy/qoder/trae，:19-23）；release.yml 实际构建 5 个（+zcode+mimo，:108,134）——**脚本与 workflow 已有漂移** | 单插件 |

### 1.4 「用户自编 vs Release 分发」结论

- 本仓库**没有 CI、没有 Release、没有预编译 dll**。当前形态下，谁要 `workbuddy-bridge.dll` 就得**自己在一台装了 Go1.26 + MSYS2 MinGW64 gcc 的机器上跑上面那条 go build**。
- 构建机要求很轻：一台 Windows（或 Linux 上装 mingw-w64 交叉链亦可）+ Go 1.26。不需要宿主源码、不需要 CGO 之外的东西。
- 这与 cpa-multi-plugins「发 Release zip、用户下载解压即投 plugins/」形成鲜明对比——后者把构建这件事从用户身上彻底拿掉了。**只要这份 clean-room 范本要真正落地给 DSH 用户用，就必须补上「CI 出 dll + Release 分发」这一环**（见 §4）。

### 1.5 宿主 exe 与插件 dll 的版本兼容约束

- 插件 `go.mod:5` 钉 `github.com/router-for-me/CLIProxyAPI/v7 v7.2.30`，**仅 import `sdk/pluginabi` + `sdk/pluginapi`**（plugin.go:66-67）。
- 宿主本地源码 `go.mod` 已是 `module github.com/router-for-me/CLIProxyAPI/v8`，但它**仍对外发布同一套 `sdk/pluginabi`/`sdk/pluginapi`**（宿主 `internal/pluginhost/abi.go:4` import `.../v8/sdk/pluginabi`）。即宿主主模块升到 v8，SDK 子包保持 v7.2.30 的契约。
- 两个版本常量（宿主 `sdk/pluginabi/types.go`）：
  - `ABIVersion uint32 = 1`（:7）——**原生 C ABI 结构形态**（cliproxy_host_api / cliproxy_plugin_api 三个函数指针 + abi_version）。插件在 `plugin.go:95` 把 `pluginabi.ABIVersion` 回填进 `plugin.abi_version`。
  - `SchemaVersion uint32 = 6`（:20）——**plugin.register 时协商的 JSON-RPC 契约**。插件 `plugin.go:257` 回 `SchemaVersion: pluginabi.SchemaVersion`。
- **钉 v7.2.30 意味着**：插件声明自己只会用 SchemaVersion=6 这条 RPC 契约下的 method（见 §2）。宿主只要 ABIVersion 仍=1、SchemaVersion≥6，且 `sdk/pluginabi` 的 method 名字符串不变，旧 dll 就能加载。ABI 版本=1 是冻结的 C 结构形状；Schema 升到 6 后插件端用的 method 名都在 `types.go:36-112` 枚举内。**只要 DSH 用的宿主 exe 是 v7.2.30 或其后保持 SDK 向后兼容的版本，这份 v7.2.30 绑定的 dll 就能直接加载。**

---

## 2. 接口组合 / 架构设计（逐文件，接口级证据）

### 2.1 C ABI 外壳（plugin.go）

- 导出符号：`//export cliproxy_plugin_init`（:89，签名 `(host *C.cliproxy_host_api, plugin *C.cliproxy_plugin_api) C.int`）、`cliproxyPluginCall`（:102）、`cliproxyPluginFree`（:125）、`cliproxyPluginShutdown`（:132，**刻意 no-op**，注释 :134-135 说明 dlclose 后碰 Go runtime 会 SIGSEGV）。
- C 侧结构（:20-44）与宿主 `loader_unix.go:18-38` / `loader_windows.go` 定义**逐字段对应**：`cliproxy_host_api{uint32 abi_version; void* host_ctx; call; free_buffer}`；`cliproxy_plugin_api{uint32 abi_version; call; free_buffer; shutdown}`。
- **主 dispatch `handleMethod`（:306-339）分派的 method**（全部来自 `pluginabi` 常量，字符串值见宿主 types.go）：

| method 常量（插件用） | RPC 字符串 | 插件处理 | 行号 |
|---|---|---|---|
| `MethodPluginRegister` / `MethodPluginReconfigure` | `plugin.register` / `plugin.reconfigure` | 返回 `wbaiRegistration()` | :308-309 |
| `MethodModelStatic` | `model.static` | `handleModelStatic` | :310-311 |
| `MethodModelForAuth` | `model.for_auth` | `handleModelForAuth` | :312-313 |
| `MethodAuthIdentifier` | `auth.identifier` | `{identifier: providerName}` | :314-315 |
| `MethodAuthParse` | `auth.parse` | `handleParseAuth` | :316-317 |
| `MethodAuthLoginStart` | `auth.login.start` | **硬报错 unsupported**（只收编文件，不做浏览器登录） | :318-319 |
| `MethodAuthLoginPoll` | `auth.login.poll` | **硬报错 unsupported** | :320-321 |
| `MethodAuthRefresh` | `auth.refresh` | `handleRefreshAuth` | :322-323 |
| `MethodExecutorIdentifier` | `executor.identifier` | `{identifier: providerName}` | :324-325 |
| `MethodExecutorExecute` | `executor.execute` | `handleExecExecute` | :326-327 |
| `MethodExecutorExecuteStream` | `executor.execute_stream` | `handleExecStream` | :328-329 |
| `MethodExecutorCountTokens` | `executor.count_tokens` | 回 `{"input_tokens":0}` | :330-331 |
| `MethodManagementRegister` | `management.register` | `managementRegistration()` | :332-333 |
| `MethodManagementHandle` | `management.handle` | `handleManagement` | :334-335 |
| default | — | `errorEnvelope("unknown_method", ...)` | :336-337 |

- **JSON-RPC 载荷 / 错误信封**：`rpcEnvelope{ok bool; result?; error?}`（:203-207），错误 `envelopeError{code; message}`（:198-201）。成功 `okEnvelope`（:209）、失败 `errorEnvelope`（:214）、handler 抛错统一包成 `code:"internal"`（:219-221）。**注意：bridge 的错误信封只有 `code/message`，没有 cpa-multi-plugins workbuddy 的 `http_status` 字段**（对比 workbuddy main.go:303-313 的 `HTTPStatus`）——即 bridge 不向上层回传上游 HTTP 状态做 per-status 冷却，host 只会当 1 分钟瞬态重试。

### 2.2 能力自报（registration，:255-280）

`Capabilities`：`ModelProvider/AuthProvider/Executor = true`；`ExecutorModelScope = ExecutorModelScopeOAuth`；输入输出格式均 `["chat-completions"]`；**`Scheduler=false`、`ManagementAPI=true`、`UsagePlugin=false`**。ConfigFields 仅 1 个：`app_version`（桌面 app UA 版本，默认 5.5.2，:264-266）。

### 2.3 cliproxy_host_api 回调在插件里被用到的能力

`hostCall`（:144）经 `wbai_call_host`（C 侧包装 :46-48）调宿主。bridge **只用到 4 个 host method**：

| host method 常量 | 字符串 | 用途 | 插件调用点 | 宿主实现文件 |
|---|---|---|---|---|
| `MethodHostStreamEmit` | `host.stream.emit` | 异步推一帧 chunk / 推错误 | plugin.go:170,184 | 宿主 `internal/pluginhost/host_callbacks.go:168` |
| `MethodHostStreamClose` | `host.stream.close` | 关异步流 | plugin.go:190 | host_callbacks.go:170 |
| `MethodHostAuthList` | `host.auth.list` | 列宿主认证文件（面板用） | management.go:191 | host_callbacks.go:174 → auth_callbacks.go |
| `MethodHostAuthGet` | `host.auth.get` | 按 auth_index 读单条凭据 JSON | management.go:223 | host_callbacks.go:176 → auth_callbacks.go |

- **bridge 没有用** `host.http.do` / `host.http.do_stream`（请求日志桥）、`host.auth.save`、`host.log`——它在 `httpclient.go:6-9` 明确写：「v1 deliberately uses a plain net/http client instead of the host bridge … If CPA request logs for this provider are wanted, swap later」。这是与 cpa-multi-plugins workbuddy 的一个**有意识的简化取舍**（少一条 ABI seam，但丢了宿主侧请求日志抓取）。

### 2.4 wire.go 协议适配点（纯函数，无 C ABI，:6-7 自述 unit-testable）

- 端点常量（:17-26）：`globalBase=https://www.workbuddy.ai`；chat `/v2/chat/completions`；refresh `/v2/plugin/auth/token/refresh`；catalog `/v3/config`；billing `/v2/billing/meter/get-user-resource`；`appVersionFallback="5.5.2"`；`clientUA="CLI/2.63.2 CodeBuddy/2.63.2"`；`systemPrompt="You are a helpful assistant."`。
- **UA 拆分**：chat/catalog 用桌面形 UA `appUserAgent(version)="WorkBuddy/<v> WorkBuddy AI/<v>"`（:103-105），网关按它拆 `/v3/config` roster；而 commonHeaders（:107-115）里的默认 `User-Agent` 是 CLI 形。catalog 头 `catalogHeaders`（:177-188）显式用 `appUserAgent`。
- **token / cookie 处理**：
  - chat：`chatHeaders`（:119-141）`Authorization: Bearer <accessToken>`，外加 `X-User-Id`/`X-Enterprise-Id`/`X-Domain`（空则发 `X-No-*`）、`X-Product: SaaS`。**绝不带 refresh token**。
  - refresh：`refreshHeaders`（:145-153）把 refresh token 放 `X-Refresh-Token` 头，**不设 Authorization**（:143-144 注释镜像 bridge）。
  - 无 cookie jar——纯 Bearer/header 鉴权。
- **请求体适配**：
  - `prepareChatBody`（:198-207）：强制 `obj["stream"]=true` → `normalizeDeveloperRole` → `normalizeToolChoice`。
  - `prepareIntlBody`（:215-232）在其上再加国际版两条：`dropUnsupportedEffort` + 首条非 system 则前置 `systemPrompt`。

### 2.5 executor.go SSE 清洗管线（逐帧，行号）

请求侧清洗全在 wire.go；executor.go 负责**出站 HTTP + 响应 SSE 逐帧清洗**：

- 剥 provider 前缀：`upstreamBody`（:38-49）把入站模型 `workbuddy-bridge/deepseek-v4.1-flash` 剥成 `deepseek-v4.1-flash`（注释 :35-37 说明带前缀会 400/11102）。
- 异步流式（`handleExecStream`，:81-136）：`req.StreamID != ""` 时起 goroutine `pumpCleanedSSE`（:111-121），**上游 body 在 pump goroutine 内关闭**（:115，注释 :107-110 警告提前 close 会让客户端看到 http2 closed）；无 stream id 时同步收集 chunks（:126-135）。
- **逐帧清洗 `walkCleanedSSE`（:167-195）步骤**：
  1. `bufio.Scanner`（buffer 64KB→4MB，:169）逐行；
  2. `upstreamSSEFrame`（:206-215）：空行/`: `开头的 keep-alive 注释行丢弃（`meaningful=false`）；剥掉 `data:` 前缀；
  3. **`[DONE]` 透传与否**：`:174  if content=="" || content=="[DONE]" { continue }`——**主动丢弃上游 `[DONE]`**，由宿主自己补结束符（注释 :163-166「the host appends its own stream terminator」）；
  4. `cleanChunkJSON`（:220-270）：剥空壳 delta——空 `function_call`（:239-242）、空 `tool_calls` 数组（:243-248）、空 `extra_fields`/`refusal`/`reasoning_content`（:249-254），空 delta 且无 finish_reason 的整帧丢弃（:255-259）；
  5. 按需加 `data: ` 帧头（:181-183，由 `clientNeedsSSEFrame` :152-160 决定：`/v1/chat/completions` 不加，宿主自己加）。
- **developer→system / tool_choice 扁平 / reasoning_effort off 丢弃 / 首条 system 前置都在请求侧（wire.go）**，不在 SSE 响应侧：`normalizeDeveloperRole`（wire.go:250-264）、`normalizeToolChoice`（:268-312，对象 `function`→函数名、`none`→删 tools+tool_choice、`auto/required`→小写串）、`dropUnsupportedEffort`（:318-322，仅删字面 `"off"`）、首条 system 前置（:226-230）。
- 非流式聚合 `aggregateCompletion`（:292-408）：把 SSE 折成单个 `chat.completion`，补 id/model/created/finish_reason/usage。

### 2.6 catalog.go + models.go 模型映射规则

- `parseCatalog`（catalog.go:49-106）：`envelopeData` 拆 `{code,msg,data}`（:110-121）；取 `cliRoster`（:126-142，**只认 `agents[].name=="cli"` 那一组的 models 列表**）；与 `data.models` 逐行**取交集**（:69 `if id=="" || !roster[id] { continue }`）；丢 disabled 行（:72-74）、丢 cap≤0 行（:88-90）。
- **与宿主 excluded-models 过滤**：`handleModelForAuth`（models.go:50-106）读 `req.Host.ExcludedModels[providerName]`（:67），大小写不敏感地剔除（:70-78）。
- **最终模型名组装**：插件上报的 `ModelInfo.ID = mi.ID`（=上游裸 id 如 `deepseek-v4.1-flash`，models.go:93），**provider 前缀由宿主自动加**成客户端可见的 `workbuddy-bridge/deepseek-v4.1-flash`（README:66）；插件出站再用 `upstreamBody` 剥回（executor.go:44-45）。`OwnedBy="workbuddy"`（:97）。静态模型为空（`handleModelStatic` 只回 provider 名，:46-48），roster 是 per-account 实时抓 + 5 分钟 `sync.Map` 缓存（:18,25-44）。

### 2.7 auth.go + billing.go 认证与积分

- **token 来源**：`parseCredential`（wire.go:68-92）从 CPA auth 文件的 `auth.accessToken` 读；`isGlobal`（:96-99）只收 `domain==workbuddy.ai` 或 `*.workbuddy.ai`，CN 域名拒收（:88-90）。
- **认领**：`isOursAuthFile`（auth.go:21-29）认声明 type ∈ {`workbuddy-ai`,`workbuddy-global`,`workbuddy`}，或无类型文件名带 `workbuddy-bridge-` 前缀；`handleParseAuth`（:31-69）只有「是我们的文件 **且** 能解析成国际版凭据」才 `Handled:true`。
- **刷新**：`handleRefreshAuth`（:86-124）调 `refreshCredential`（httpclient.go:60-102，`X-Refresh-Token` 头、信封 `{code,msg,data{accessToken,refreshToken,expiresIn,domain}}`），patch 回 auth 文件，`NextRefreshAfter = +24h`（:123）。
- **billing→quota 映射**：`fetchCreditsBytes`（httpclient.go:127-146）GET `/v2/billing/meter/get-user-resource`；`parseEnvelope`（billing.go:21-30）拆 `{code,msg,data}`；`parseCredits`（billing.go:43-65）**保守地**在 `credits/totalCredits/balance/total` 四个键里找余额（字符串或数值），认不出就归零（:32-34 自述「verified live once deployed; until then unrecognized reads as zero」）。

### 2.8 management.go + panel.go 管理面板注入

- 注册形态（management.go:48-57）：`Routes` 1 条（`GET /accounts`）+ `Resources` 1 条（`/panel`，菜单名 `"WorkBuddy Bridge"`）。
- 绝对路径由 providerName 拼出：`mgmtAccountsPath=/v0/management/plugins/workbuddy-bridge/accounts`、`mgmtPanelPath=/v0/resource/plugins/workbuddy-bridge/panel`（:44-46）。
- `handleManagement`（:59-72）按 `req.Method+req.Path` 分发到这两条，其余 404。
- 面板 `panelHTML`（panel.go:7-67）：单文件自包含 HTML，fetch `/v0/management/plugins/workbuddy-bridge/accounts`，渲染 账号/UID/域名/积分/状态 表 + 手动刷新按钮。
- 列账号经 `hostAuthList`（management.go:190-219，调 `host.auth.list`，再按 `workbuddy-bridge-` 前缀本地过滤）→ 逐账号并发（信号量 6，20s 预算，:100-126）拉积分。

---

## 3. 与 cpa-multi-plugins workbuddy 插件对比

> 对照源：`cpa-multi-plugins/plugins/workbuddy`（module `github.com/mmqz/cpa-multi-plugins/plugins/workbuddy`，go 1.26.0，同样 require `CLIProxyAPI/v7 v7.2.30` + yaml.v3）。

### 3.1 四维结构化对比表

| 维度 | workbuddy-bridge（本 clean-room） | cpa-multi-plugins/workbuddy | 证据 |
|---|---|---|---|
| **协议正确性** | **同协议、更窄**。同打 `www.workbuddy.ai` 的 `/v2/chat/completions`，同 OpenAI 形状 SSE 逐帧转发；请求侧清洗（developer→system、tool_choice 扁平、reasoning_effort off 丢弃、首条 system 前置）与 workbuddy 的 `prepareUpstreamBody` 对齐（bridge wire.go:198-232 ↔ workbuddy main.go:814 注释「forceStream+normalizeTools+rewriteSystem+ensureSystemMessage+rewriteModel in ONE pass」）。**但 bridge 是单 realm（global only），错误信封不带 http_status，不用 host.http 桥**。 | **同协议、三 realm**。CN `copilot.tencent.com` / Global `www.workbuddy.ai` / Intl `www.codebuddy.ai` 三套 base 自动按 token domain 路由（main.go:83-90, 569-579）；错误信封带 `http_status` 驱动宿主 per-status 冷却（402→30m/429/401，main.go:303-313）；走 `host.http.do_stream` 抓请求日志（main.go:822）；有 model 别名回解、model 级 6004 限流快失败、stream head gate。 | bridge wire.go:17 / executor.go:44-45；workbuddy main.go:83-104, 569-640, 810-850 |
| **代码规模与可维护性** | **~2.3k 行纯源码**（plugin 338/wire 322/executor 418/catalog 222/models 106/auth 124/billing 65/management 240/panel 67/httpclient 154 + 2 测试）。wire.go 刻意「pure: no C ABI, no host calls, unit-testable」（wire.go:6-7）。零额外依赖（go.sum 只有 CLIProxyAPI）。 | **~25.1k 行**（含 ~60 个测试文件）。单文件最大：models.go 1462、growth.go 863、stream.go 842、payload.go 799、billing.go 715、taskcenter.go 712、lifecycle.go 594、task_events.go 585……go.mod 多依赖 yaml.v3。 | bridge `wc -l` 合计 2331；workbuddy `wc -l` 合计 25107 |
| **管理面板深度** | **2 条路由**：`GET /accounts` + `/panel` 静态页。展示 昵称/UID/域名/积分/状态 + 手动刷新。无鉴权、无限流。 | **14 条路由**（management.go:145-160）：accounts/refresh/**checkin**/checkin config/**tasks**/tasks run/**school vouchers**/credits/import/trial/select/keepalive/keepalive status/models groups；外加插件层 Bearer `management_key` 鉴权（:268-282）+ per-IP token-bucket 限流（:287-319）。面板是真 dashboard。 | bridge management.go:50-55 vs workbuddy management.go:145-164 |
| **签到 / 任务能力** | **完全没有**。`Scheduler=false`、`UsagePlugin=false`（plugin.go:275-277）；无 checkin/growth/task/scheduler/keepalive/lifecycle 任何文件。只收编文件 + chat/catalog/billing。 | **整套 CN 增长自动化**：checkin.go（每日 09:00/21:00 自动签到，:1-6）、growth.go（成长中心 task accept/claim、streak、抽奖、buddy travel、活跃度上报、补签卡，三上游域）、taskcenter.go（10 步每日循环，:1-26）、task_chat.go（真实对话类任务）、task_events.go（CLI/桌面/web/小程序四通道行为指纹上报）、task_auto.go（自动点亮编排）、school.go（开学季活动）、scheduler.go（CPA scheduler.pick）、keepalive.go（每日 22:00 刷新 token 防 Keycloak 离线会话过期）、lifecycle.go（积分耗尽自动 disable/delete）。 | bridge 无对应文件；workbuddy checkin.go/growth.go/taskcenter.go/keepalive.go/lifecycle.go 文件头注释 |

### 3.2 结论：workbuddy 渠道以谁为基座

**以 cpa-multi-plugins 的 `workbuddy` 插件为基座，clean-room bridge 作为「global-only、无签到」的精简 A/B 对照并存，不替换。** 理由（落到接口/文件证据）：

1. **协议层两者同源**（都移植自 dsh-workbuddy-bridge / workbuddy2api），bridge 已把 global 这条 wire 单独提纯、单测覆盖（wire_test/catalog_test + testdata/intl-config.json），证明 global 路径可独立成立——这正是 bridge 的价值：**它把 global 从 workbuddy 的三 realm 巨型耦合里剥出来，证明「单 realm 纯反代」能压到 2.3k 行**。
2. **但 workbuddy 插件是唯一带签到/任务/保活/生命周期/三 realm/错误状态机的实现**（§3.1 第 3、4 维）。这些是「养号」刚需，bridge 一个都没有。若用 bridge 替换 workbuddy，等于把 25k 行验证过的增长自动化全扔掉。
3. **两者 auth 文件名前缀天然不冲突**（bridge 认 `workbuddy-bridge-*`，workbuddy 认 `workbuddy-*`/`codebuddy-*`/`workbuddy-intl-*`，workbuddy main.go:651-674），provider id 也不撞（`workbuddy-bridge` vs `workbuddy`），README:5 自述「完全独立并存，适合 A/B 对比」。**所以正确姿态是 A/B 并存**：日常走 workbuddy（带养号），把 bridge 当作「global 纯净反代」的受控对照组，或在只需 global 反代、不想引入 CN 签到副作用的部署里单独启用 bridge。
4. bridge 可反哺 workbuddy 的点：它的 `parseCatalog`（cli roster ∩ product rows，catalog.go:49-106）与 `cleanChunkJSON`（executor.go:220-270）是 workbuddy 同名函数的提纯对照实现，可用于回归校验 workbuddy 那条更复杂的解析。

### 3.3 trae / qoder 能否也用同样 clean 形态重写（方向性判断）

读 `cpa-multi-plugins/plugins/{trae,qoder}` 的 chat/执行路径复杂度后粗判（详细重写评估另有子代理）：

- **trae：~21.7k 行，main.go 2568 + intl_main.go 1306 + management.go 1314 + pending_persist.go 761 + oauth_callback.go 466/473**。复杂度集中在**多变体 OAuth 设备流 + CN/Intl 双套登录回调 + pending 持久化**，chat/exec 路径本身并不比 workbuddy 脏，但它的价值几乎全在登录态生命周期，不在反代。**若目标只是「纯 chat 反代、凭据改文件收编」，trae 可以重写成 bridge 那样的 clean 形态；但若要保留设备流登录，重写收益有限。**
- **qoder：~19.7k 行，main.go 958 + stream.go 1059 + campaign.go 1327 + checkin.go 862 + oauth.go 692 + lifecycle.go 589 + machine_identity.go 525**。qoder 带 **pro-upgrade campaign（活动税率/券码）+ 862 行 checkin + machine_identity 指纹**，耦合点比 trae 还多。**chat 反代主干（body.go 364/stream.go）本身可 clean 化，但 machine_identity + campaign 是 qoder 特有的养号资产，重写会丢掉。**
- **方向判断**：clean-room 形态最适合「**上游就是 OpenAI 形状 SSE、登录态靠收编现成文件、不需要签到/活动/设备流**」的渠道——workbuddy-global 恰好是这个最优情形。trae/qoder 的复杂度大头在**登录流与养号活动**而非反代协议，它们能 clean 的只是反代那一段，整体重写不如 bridge 那么「一压就瘦」。建议：trae/qoder **保留现有实现**，仅在需要「global 纯反代对照」时参照 bridge 模式做旁路，不做整体重写。

---

## 4. 方案收敛影响

### 4.1 「插件 .dll 从 Release 分发」的结论是否被改变

**被强化，而非改变。** 这份范本（无签到/任务/调度器，2.3k 行）恰恰说明：插件源码本身可以很干净，但**构建这件事（CGO + mingw + c-shared）仍然是用户自己搞不定的硬门槛**——本仓库连 CI/Release 都没有，等于把构建负担完全甩给了用户。cpa-multi-plugins 已经用 `.github/workflows/release.yml` 证明了正确姿势：tag 触发、MSYS2 矩阵、出 zip、发 GitHub Release、用户解压投 `plugins/`。

**结论不变、且更坚定：插件 dll 必须从 Release 预编译分发，绝不能让 DSH 用户本地 go build。** bridge 范本只是把「要分发的那个产物」做小了、做干净了，没有改变「产物必须预编译好」这一结论。

### 4.2 DSH 插件首启是否要包含「拉取 / 校验插件 dll」步骤

**要。** 既然 dll 从 Release 分发，DSH 首启/升级就需要一个「拉 dll + 校验 + 落 plugins/」步骤。校验三件套（对应 §1.5 的兼容约束）：

1. **文件名 / 平台**：必须是 `workbuddy-bridge.dll`（产物名，README:73），且平台匹配 Windows amd64（release.yml 唯一 Windows 目标）。放对目录（cpa-multi-plugins README 安装说明：`plugins/windows/amd64/` 之类）。
2. **ABI 兼容**：dll 由 SDK v7.2.30 构建（`ABIVersion=1`、`SchemaVersion=6`）。DSH 应记录 dll 的 SDK 绑定版本，与宿主 exe 的 SDK 版本比对——宿主若升到 ABIVersion≠1 或 SchemaVersion>6 且不向后兼容，旧 dll 要拒绝加载。
3. **哈希**：Release 发布时应附带 dll 的 SHA-256（宿主 `loader_windows.go` 已经 import `crypto/sha256`，说明宿主侧具备哈希校验的先例），DSH 拉取后比对 Release 公布的 hash，防中间人/坏包。

> 即：首启步骤 = 从 Release URL 拉 `workbuddy-bridge-windows-amd64.zip` → 校验平台/文件名 → 校验 SHA-256 → 解压落 `plugins/` → 写 config.yaml 启用 → 重启宿主。

### 4.3 插件 go.mod 钉 v7.2.30 与宿主 SDK 版本如何对齐

- 插件钉 `CLIProxyAPI/v7 v7.2.30`（go.mod:5），只用 `sdk/pluginabi`+`sdk/pluginapi`。
- 宿主主模块现已 `.../CLIProxyAPI/v8`，但**仍发布同一套 `sdk/pluginabi`（ABIVersion=1、SchemaVersion=6）+ `sdk/pluginapi`**（宿主 abi.go:4 import `.../v8/sdk/pluginabi`）。
- **对齐规则**：插件编译时 import 的 SDK 版本（v7.2.30）决定它**声明**的 `ABIVersion`/`SchemaVersion`；宿主加载时用自己的 `pluginHostABIVersion`（abi.go:6）比对。只要宿主 SDK 不把 ABIVersion 从 1 抬走、SchemaVersion 保持 ≥6 的向后兼容，v7.2.30 编译的 dll 在新宿主上照跑。**DSH 侧只需把「插件 SDK 版本」与「宿主要求的最低 SDK 版本」做成一张兼容表，发布时成对升级**：宿主升大版本（ABIVersion 变）时，所有插件 dll 必须用新 SDK 重编。

### 4.4 cpa-multi-plugins 在整体方案中的角色是否因重写改变

**不删除、不降级为「仅参考」。** 收敛结论：

- **workbuddy 插件保留为养号基座**（§3.2）：三 realm + 签到/任务/保活/生命周期是它不可替代的资产。
- **bridge 作为独立 A/B 对照组并存**：global 纯反代、无养号副作用，适合做协议正确性基准和轻量部署。
- **trae/qoder 保留现有实现**（§3.3）：clean 重写只值回反代那一段，登录流与活动耦合太重，不整体重写。
- 因此 cpa-multi-plugins **整体保留**，角色 = 「生产养号发行版」；bridge = 「clean-room 协议基准 / global 旁路」。两者 auth 前缀与 provider id 不冲突（`workbuddy-*` vs `workbuddy-bridge-*`），可同机共存。**既不是删除，也不是只留 A/B——是「保留全家 + 新增 bridge 旁路」。**

---

## 附：关键事实速查（核验你给的背景）

- ✅ 纯源码投放：无 scripts/.github/Makefile（仓库树确认，仅 .git/testdata/LICENSE/README/go.mod/go.sum + 9 个 .go + 2 测试）。
- ✅ module `workbuddy-ai`、go 1.26.0、唯一依赖 CLIProxyAPI/v7 v7.2.30（go.mod 逐字一致；go.sum 仅 1 行依赖）。
- ✅ 行数：plugin 338 / wire 322 / executor 418 / catalog 222 / models 106 / auth 124 / billing 65 / management 240 / panel 67 / httpclient 154 = **2331**（与你给的数字一致）。
- ✅ C ABI 形态：`//export cliproxy_plugin_init(host *C.cliproxy_host_api, plugin *C.cliproxy_plugin_api) C.int`（plugin.go:89-90）；结构字段与你亲读一致；导出 `cliproxyPluginCall/Free/Shutdown`（:102/125/132）；import `sdk/pluginabi`+`sdk/pluginapi`（:66-67）。
- ⚠️ **你发现的不一致坐实为「注释漂移」**：代码常量 `providerName="workbuddy-bridge"`（plugin.go:75）是运行时唯一真相；文件头 9-11 行注释「provider workbuddy-ai / auth 前缀 workbuddy-ai-*」是改名后漏改的 stale 注释，README 与代码一致。**以代码 + README 为准：真实 provider id = `workbuddy-bridge`，auth 文件命名 = `workbuddy-bridge-<uuid>.json`。**
