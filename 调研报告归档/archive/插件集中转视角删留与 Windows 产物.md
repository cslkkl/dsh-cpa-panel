# 插件集中转视角删留与 Windows 产物

> 第二轮定向调研（只读）。修正上一轮基准：后端收窄为「多渠道中转 ProxyAPI」（账号/鉴权 + 请求转发 + 渠道选择 + 模型映射），非账号面板；且只部署 Windows。
> 对照：`cpa-multi-plugins`（commit `cf5f6af`）与 `CLIProxyAPI@c121fde`。

---

## 0. 一页结论

- **五个插件全部是完整中转渠道**，无一例外。每个插件都注册了同一套执行栈（见 `plugins/*/main.go` 的 `case pluginabi.Method*` 分发表）：`plugin.register` + `model.static` + `model.for_auth` + `auth.identifier/parse/login.start/login.poll/refresh` + `executor.identifier/execute/execute_stream/count_tokens`。
- **mimo 反转上一轮结论**：它有完整的转发执行通道（`plugins/mimo/executor.go` + `stream.go`，双 lane 都输出标准 OpenAI SSE），是合格中转渠道；它的 `management.*` 也不是签到面板，而是**登录兜底路由 `/oauth_submit`**（远程服务器/ Docker 下 loopback 回调不可达时的粘贴补登）——这对中转部署反而是有用的。verdict 从「删」改为**可选渠道**。
- **模型映射**：插件通过 `model.static`/`model.for_auth` 向宿主注册自己的模型目录（`pluginapi.ModelInfo` 列表，见 `workbuddy/models.go:981,1430`），路由时宿主按「请求 model → 哪个插件的目录」分派。CPA 内置的 `internal/registry/model_updater.go:24`（远程 `models.json`）**只服务内置供应商，与插件模型表互不依赖**。
- **管理路由取舍**：checkin/tasks/credits 路由本身无人调用即零成本；但**后台调度器编译在 .so 内、且默认开启**（trae `checkin_auto` 明示 default true；workbuddy `tasks_auto` 默认 on；workbuddy `checkin.go:29` `go schedulerLoop` 插件启动即跑）。不删代码也能停：在 `plugins.configs.<id>` 里把 `checkin_auto`/`tasks_auto` 置 false 即可。**整库打包不可分割**——`go build -buildmode=c-shared` 一个 .so 就是整个插件，要「只留执行部分」必须改源码重编译。
- **Windows**：CI 确有 `windows-amd64` 产物（`release.yml` matrix：`windows-latest` + MSYS2 MINGW64 + `mingw-w64-x86_64-gcc`，ext=`dll`），5 个插件各产 `<id>.dll`，打平包 `cpa-multi-plugins-windows-amd64.zip`。**运行时只需把 .dll 丢进 CPA 的 `plugins/` 目录**；MinGW/Go 只在「自己重编译」时才需要，开箱用 Release 产物零工具链。

---

## 1. 中转视角：逐插件重评

### 1.1 五个插件的执行栈对照（读 `plugins/<id>/main.go` 分发表）

| 能力（pluginabi 方法） | workbuddy | trae | qoder | zcode | mimo |
|---|---|---|---|---|---|
| `plugin.register`（能力声明） | ✅ :245 | ✅ :339 | ✅ :258 | ✅ :239 | ✅ :274 |
| `model.static`（静态模型表） | ✅ :248 | ✅ :343 | ✅ :262 | ✅ :243 | ✅ :281 |
| `model.for_auth`（按账号模型表） | ✅ :250 | ✅ :348 | ✅ :264 | ✅ :245 | ✅ :283 |
| `auth.*`（登录/刷新/解析） | ✅ :252-260 | ✅ :354-385 | ✅ :266-274 | ✅ :247-255 | ✅ :285-293 |
| `executor.execute_stream`（**转发通道**） | ✅ :266 | ✅ :400 | ✅ :280 | ✅ :261 | ✅ :299 |
| `executor.execute` / `count_tokens` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `scheduler.pick`（多账号选号） | ✅ :284 | ✅ :409 | ✅ :298 | ✅ :279 | ❌ |
| `usage.handle`（用量上报） | ✅ :286 | ✅ :357 | ✅ :300 | ✅ :281 | ❌ |
| `management.*`（面板路由） | ✅ 签到+任务 | ✅ 签到 | ✅ 签到 | ✅ 余额/领取 | ✅ **登录补登页** |
| 上游协议 | OpenAI 兼容（copilot.tencent.com） | CN `llm_utils_chat` + Intl Web SOLO remote | COSY 签名 SSE | OpenAI 网关 + Anthropic 翻译层 | 双通道 OpenAI SSE |

### 1.2 逐插件 verdict（中转标准）

- **workbuddy —— 必须（若用户有 CodeBuddy 渠道）**：完整转发 + OpenAI 兼容信封，上游错误/限流模型级处理成熟。中转唯一额外注意点：`.so` 内 `schedulerLoop` 默认开（`checkin.go:29`），部署时把 `checkin_auto`/`tasks_auto` 关掉即纯转发。
- **trae —— 必须（若用户有 Trae 渠道）**：CN/Intl 三变体合一执行器，`sse_convert.go` 把上游自定义 SSE 转成 OpenAI 信封——这正是「中转」最需要的协议适配层。
- **qoder —— 必须（若用户有 Qoder 渠道）**：COSY 签名 + 自定义 base64 编码 + 信封解包全在插件侧完成，宿主只管转发；无插件则 Qoder 渠道完全不可接入。
- **zcode —— 可选**：协议最重（签名 V4/Ed25519/PoW + anthropic 翻译 + off-peak 票务），但只要接 GLM coding-plan 渠道就必须整插件引入——它不可部分裁剪。
- **mimo —— 可选（本轮改判）**：**有执行通道**（`executor.go` 双 lane 转发、`stream.go` 标准 OpenAI SSE 输出），可当中转渠道；上一轮因「无签到/任务/余额」判删，那是面板标准，不适用。保留理由 = 多一个小米 MiMo 渠道；其 `management` 仅 `/oauth_submit` 登录补登页（`management.go:1-7`：远程部署 loopback 回调失败时粘贴 blob 完成登录），对无头 Windows 中转服务器实际有用。删它 = 放弃 MiMo 渠道，无技术风险。

> 「必须/可选」均以**该渠道是否在用户的账号池里**为前提；对中转后端而言，五个插件是五条互斥的渠道，保留集合 = 用户实际持有的账号集合。

---

## 2. 模型映射数据从哪来

- **插件侧来源**：注册阶段宿主发 `model.static`（静态目录）与 `model.for_auth`（按账号动态目录）。例如 workbuddy：`handleModelStatic`（`models.go:1430`）、`handleModelForAuth`（:1446），目录来自双路 `/v3/config` 探测后转成 `[]pluginapi.ModelInfo`（:981）。宿主据此把外部请求的 `model` 名路由到对应插件执行器（`internal/pluginhost/model_router.go` 按 target_kind=plugin 分派）。
- **CPA 侧模型远程更新与插件无关**：`internal/registry/model_updater.go:24-25` 后台从 `raw.githubusercontent.com/router-for-me/models` / `models.router-for.me` 拉 `models.json`——这是**内置供应商**（claude/codex/gemini/kimi/xai…）的模型目录更新器。插件渠道的模型表完全由插件自己上报，不读这份远程 JSON。
- **对后端裁剪的含义**：若 DSH 只服务这五个插件渠道、不保留内置供应商，则 `internal/registry` 远程更新器可以一并去（它管不到插件渠道）；反之若还要内置渠道，它独立保留、与插件删留无联动。registry.json（本仓库根目录）里也没有模型字段——它只有 id/name/version/tags，模型数据不经它传递。

---

## 3. 管理路由取舍（checkin / tasks / credits）

### 3.1 保留成本 vs 删除风险

- **运行时成本**：`management.register` 只是向宿主登记一批路由（`{method, path}`），DSH 若不渲染/不调用，这些路由**零流量、零开销**。真正的隐藏成本是 **.so 内自启动的后台调度器**：
  - workbuddy `checkin.go:29` 插件加载即 `go schedulerLoop`，由 `checkinAuto`/`tasksAuto` 门控（默认 on；`usage_config.go:261-265` 从插件配置读）；
  - trae 配置字段明示 `checkin_auto`「default true」（`main.go:492`）；
  - qoder 同款 `checkinAuto` 标志位（`usage_config.go:217`）。
- **不删代码的停法**：插件配置以原始 YAML 子树整体保留（CPA 侧 `PluginInstanceConfig.Raw`，`config_types.go`），DSH 只需在 `plugins.configs.<id>` 下写 `checkin_auto: false`（workbuddy 另加 `tasks_auto: false`），调度器即空转。**无需重编译、无运行风险**。
- **删除风险**：要在 .so 里去掉管理路由/调度器，必须删源码 case 分支后**重新 `go build -buildmode=c-shared`**——Windows 用户得先装 Go + MinGW（见 §4.2），且删 `management` 分发会牵连 `panel.go`/`credits_handler.go` 的编译依赖，引入回归。结论：**整包保留 .so + 配置关闭自动调度，是成本最低的方案**。

### 3.2 能否「只编执行部分」？

**不能按函数裁剪，只能按插件整编。** `scripts/build.sh:46`（及 CI）粒度 = 整个插件目录一次 `go build -buildmode=c-shared -o <id>.<ext> .`，入口 `cliproxyPluginCall` 一个分发函数带全部 case。想减体积只能整删某个插件目录（如不要 mimo 就不编 mimo），或改源码。体积敏感时更务实的做法是：只保留用户实际渠道对应的插件 .dll，其余不放进 `plugins/` 目录——宿主扫不到就不加载。

---

## 4. Windows 产物与工具链

### 4.1 Release 产物确认（`.github/workflows/release.yml`）

- matrix 含 `windows / amd64`：runner=`windows-latest`，goos=windows goarch=amd64，`ext: dll`（release.yml:71-76）。
- 构建链（Windows job）：先 `msys2/setup-msys2` 装 `mingw-w64-x86_64-gcc`（MINGW64），再 `CGO_ENABLED=1 CC=gcc go build -buildmode=c-shared`（release.yml:84-118）。
- **5 个插件全编**：`PLUGINS="workbuddy qoder trae zcode mimo"`，输出 `dist/windows-amd64/<id>.dll`。
- 打包：PowerShell `Compress-Archive dist/windows-amd64/*.dll → cpa-multi-plugins-windows-amd64.zip`——**zip 内是扁平 5 个 .dll**（无目录层，`.h` 头文件只在非 Windows job 被 `rm -f *.h` 排除，Windows job 本就不产头文件）。
- 命名规律：与平台无关，永远 `<插件id>.dll`（宿主 `platform.go pluginFileFromPath` 按文件名取 ID；可附 `-v0.9.47.dll` 版本后缀）。
- 对照：仓库内 `dist/` 当前**没有任何 windows-amd64 产物**（只有 linux-amd64 的 3 个 .h 头文件），windows .dll 只存在于 GitHub Release 附件。

### 4.2 运行时最小集合

- 用户侧只需：**CPA 的 windows 发行二进制（必须是 cgo 构建版，否则 `pluginhost` 走 `loader_unsupported.go` 不支持插件）+ 需要的若干个 `<id>.dll` 放进 `plugins/` 目录** + `config.yaml` 里 `plugins.enabled: true`。
- ABI 匹配：.dll 与宿主同为 ABI v1（`sdk/pluginabi/types.go:7`）；宿主 Windows 加载时先 shadow-copy 再 LoadLibrary（`internal/pluginhost/loader_windows.go:128 shadowCopyPlugin`），避免 .dll 被占用无法升级。
- **本地不需要装 MinGW/Go**：MinGW（MSYS2 MINGW64 gcc）只出现在 CI 构建机；.dll 内已打包 Go runtime。用户机器零编译工具链即可跑——这正满足「开箱即用」。

---

## 附：第二轮新增关键索引

- 执行栈分发：`plugins/{workbuddy,trae,qoder,zcode,mimo}/main.go` 的 `case pluginabi.Method*` 段
- mimo 执行器：`plugins/mimo/executor.go`（双 lane 转发）、`stream.go`（OpenAI SSE 出口）、`management.go:1-7`（/oauth_submit 补登）
- 模型注册：`plugins/workbuddy/models.go:981,1430,1446`；宿主路由 `internal/pluginhost/model_router.go`
- 内置模型远程更新：`internal/registry/model_updater.go:24-25`
- 自动调度器：`plugins/workbuddy/checkin.go:29`、`plugins/trae/main.go:492`、插件配置门控 `usage_config.go`
- Windows CI：`.github/workflows/release.yml:71-118`（matrix + MSYS2）、`:156`（Compress-Archive 打 zip）
