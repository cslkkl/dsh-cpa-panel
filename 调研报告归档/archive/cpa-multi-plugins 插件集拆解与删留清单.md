# cpa-multi-plugins 插件集拆解与删留清单

> 调研对象：`cpa-multi-plugins`（main 分支，commit `cf5f6af`，该仓库为浅克隆仅 1 个提交）
> 对照后端：`CLIProxyAPI` @ `c121fde`（https://github.com/zlZayn/CLIProxyAPI/tree/local-autobrowser，下称 CPA）
> 调研性质：只读。目标场景 = CPA 后端收敛为「账号面板」用例（余额 / 签到 / 任务 / 启用禁用），插件集同步删到最小、开箱即用。

---

## 0. 一页结论（TL;DR）

- **加载方式**：插件 = Go 模块用 `CGO_ENABLED=1 go build -buildmode=c-shared` 编译出的 **C 共享库**（`.so`/`.dll`/`.dylib`）。CPA 用 **CGO + `dlopen`（Windows 为 LoadLibrary）** 动态加载，**不是** Go 自带 `plugin` 包。固定入口符号 `cliproxy_plugin_init`，之后通过方法字符串 RPC 通信（`sdk/pluginabi/types.go:36-112`）。
- **激活方式**：CPA 配置项 `plugins.enabled`（**默认 false**，`config.example.yaml:1104-1106`）+ `plugins.dir`（默认 `plugins/`）。把 `.so` 丢进该目录即被扫描加载；`registry.json` 只用于「插件商店」在线安装，与本地激活无关。
- **无插件 CPA 能否运行**：**能**。CPA 内置 claude / codex / gemini / vertex / aistudio / antigravity / devin / kimi / meta / xai / openai_compat 等供应商（`internal/runtime/executor/`）。本插件集提供的 CodeBuddy / Trae / Qoder / ZCode / MiMo 五个家族**全部不在内置之列**。
- **运行时是否需要编译工具链**：**不需要**（前提是用 CI Release 里预编译好的 `.so` 直接放入 `plugins/`）。`scripts/` 与各插件 `Makefile` 纯属构建期；且仓库内 `dist/` **只有 3 个 `.h` 头文件、没有任何二进制**（`*.so` 被 `.gitignore` 排除）。
- **签到与插件强相关**：是。签到 / 任务逻辑全部实现在插件侧（workbuddy `checkin.go`+`taskcenter.go`、trae `upstream/checkin*`、qoder `checkin.go`+`campaign.go`），CPA 宿主只提供面板壳与 `management.handle` 转发。**删掉对应插件 = 删掉该家族的签到/任务/余额能力**。
- **最小保留集**：账号面板用例至少保留 `workbuddy` + `trae` + `qoder`（三者都有签到+余额+面板页）；`zcode` 可选（只有余额/试用包领取、无每日签到、无 panel 自动签到）；`mimo` 建议删（纯聊天、无签到/无任务/无余额面板/无 panel.html/未登记 registry/未纳入 build.sh）。

---

## 1. 加载机制

### 1.1 插件产物形态（cpa-multi-plugins 侧）

- 每个插件是独立 Go module（`plugins/<name>/go.mod`），构建命令见 `scripts/build.sh:46` 与各插件 `Makefile`：
  ```
  CGO_ENABLED=1 go build -buildmode=c-shared -trimpath -ldflags="-s -w" -o <name>.so .
  ```
- 产物 = 共享库 + cgo 自动生成头文件。命名规律：`<pluginid>.so`（linux）/ `<pluginid>.dylib`（darwin）/ `<pluginid>.dll`（windows）。
- C ABI（`dist/linux-amd64/workbuddy.h`、各 `plugins/*/main.go` 顶部 cgo 注释块）：
  - 宿主 → 插件初始化：`int cliproxy_plugin_init(const cliproxy_host_api* host, cliproxy_plugin_api* plugin);`
  - 插件导出：`cliproxyPluginCall(char* method, uint8_t* request, size_t requestLen, cliproxy_buffer* response)`、`cliproxyPluginFree(void*, size_t)`、`cliproxyPluginShutdown(void)`。
  - 双方结构体首字段均为 `uint32_t abi_version`；当前 ABI 版本 = **1**（CPA 侧 `sdk/pluginabi/types.go:7` `ABIVersion uint32 = 1`；插件侧 `plugins/workbuddy/main.go:157` 写入 `pluginabi.ABIVersion`）。
  - 反向回调：宿主把函数表 `cliproxy_host_api{call, free_buffer}` 注入插件，插件借此回打 `host.http.do`、`host.stream.emit`、`host.auth.save` 等方法。

### 1.2 CPA 服务端加载代码（具体文件）

| 环节 | 文件：位置 | 说明 |
|---|---|---|
| dlopen 打开 | `internal/pluginhost/loader_unix.go:48-52`（`static void* cliproxy_dlopen` → `dlopen(path, RTLD_NOW \| RTLD_LOCAL)`）；`loader_unix.go:114` `dynamicLibraryLoader.Open` | Linux/darwin/freebsd（build tag `cgo && (linux\|darwin\|freebsd)`） |
| Windows 加载 | `internal/pluginhost/loader_windows.go:76`（LoadLibrary + `shadowCopyPlugin`，先复制再加载） | 规避 dll 占用 |
| dlsym 入口 | `loader_unix.go:60-65`（`cliproxy_dlsym`），调用 `cliproxy_call_init(fn, host, plugin)` | 解析 `cliproxy_plugin_init` |
| 文件扫描 | `internal/pluginhost/platform.go:114` `selectPluginFiles` → `:103 pluginExtension`（darwin→`.dylib`、windows→`.dll`、默认 `.so`）→ `:candidateDirs`（先扫 `<dir>/<goos>/<goarch>/`，再扫 `<dir>` 根） | 只收规则文件 + 当前平台后缀 |
| 文件→插件 ID | `platform.go:140 pluginFileFromPath`：去扩展名即 ID；文件名形如 `<id>-v0.9.47.so` 时解析出版本号 | 决定 capability 映射 key |
| 启动装配 | `internal/pluginhost/host.go:238 selectPluginFiles` → `:454 startPluginLoad`；`host.go:228-237`：`plugins.enabled=false` 时直接清空 maps 返回（**空插件集不影响启动**） | 热加载/热替换也走这里 |
| RPC 方法表 | `sdk/pluginabi/types.go:36-112`（见 §4.2） | 双向方法名常量 |
| 配置解析 | `internal/config/config_types.go:28 PluginsConfig`；`internal/config/plugin_path.go:10` `defaultPluginsDir = "plugins"` | 见 §1.3 |
| 插件商店（registry.json 消费方） | `internal/pluginstore/registry.go:30 Registry{SchemaVersion, Plugins[]}`、`:50 Plugin{ID,Name,Description,Author,Version,Versions[],Repository,Logo,Homepage,License,Tags,Install,AuthRequired}`、`:64 InstallPlan{Type, Artifacts[]}`、`:71 Artifact{GOOS,GOARCH,URL,SHA256,Size}`；默认官方源 `registry.go:12` `https://raw.githubusercontent.com/router-for-me/CLIProxyAPI-Plugins-Store/main/registry.json` | 在线安装/版本管理，不参与本地启动 |

### 1.3 运行时激活（CPA 侧配置项）

`config.example.yaml:1104-1119`：
```yaml
plugins:
  enabled: false            # 总开关，默认关
  dir: "plugins"            # 扫描目录，支持 ~ 展开（plugin_path.go:14 ResolvePluginsDir）
  # store-sources:          # 追加第三方商店 registry.json（本仓库 registry.json 即挂这里）
  #   - "https://example.com/.../registry.json"
  # store-auth:             # 商店鉴权，token 从环境变量读
  configs:                  # 按插件 ID 单独开关/排序
    workbuddy:
      enabled: true
      priority: 10
```
- 账号文件落在 CPA 的 `auths/` 目录，文件名即插件内收养逻辑产出：`workbuddy-<uid>.json`、`workbuddy-intl-<uid>.json`、`qoder-cn-<uid>.json`、`trae-*`、`zcode-<provider>-<uid>.json`、`mimo-<lane>-<uid>.json`（见各插件 `authfile.go`）。CPA 宿主按「auth 文件归属哪个插件 auth provider」路由，此映射由插件在 `plugin.register` 阶段声明（`auth.identifier`）。

### 1.4 `dist/` 实际内容（逐文件核实）

```
dist/linux-amd64/qoder.h
dist/linux-amd64/trae.h
dist/linux-amd64/workbuddy.h
```
- **只有 3 个 cgo 导出头文件，没有任何 `.so/.dll/.dylib` 二进制**。`.gitignore` 明确忽略 `*.so / *.dll / *.dylib` 及 `plugins/*/dist/`。
- 头文件是构建副产品，运行时**无用**；Linux 下 CGO 动态加载不需要宿主侧头文件。
- 真实预编译产物由 CI 产出：`.github/workflows/release.yml`（tag `v*` 触发），矩阵 = linux-amd64 / linux-arm64 / darwin-amd64（clang cross `-arch x86_64`）/ darwin-arm64 / windows-amd64；构建全部 5 个插件（`release.yml:108,134` `PLUGINS="workbuddy qoder trae zcode mimo"`），打包为 `cpa-multi-plugins-<os>-<arch>.zip` 附在 GitHub Release。根 README 亦称「Tagged commits are built by CI; per-platform artifacts are attached to each release」。
- 注意：`scripts/build.sh:18` 的插件清单只有 `workbuddy qoder trae` 三个（注释「v0.12.0 收敛为 3 个统一插件」），与 CI 的 5 个不一致——zcode/mimo 不被本地脚本构建。

---

## 2. 逐插件拆解

> 版本号取自各插件 `VERSION` 文件；家族/地区事实优先引用 `plugins/<name>/README.md` 与 `docs/PROTOCOL.md`，再以源码佐证。

### 2.1 workbuddy（v0.9.47）——腾讯 CodeBuddy / WorkBuddy 家族

- **合并的地区变体**（`README.md` + registry.json description）：三 realm 共用一个额度池——`copilot.tencent.com`（CN）、`workbuddy.ai`（Global）、`codebuddy.ai`（Intl）；双登录平台 CLI + CodeBuddy IDE（`login_platform` 配置选择）。历史上的 `codebuddy-cn`（v0.9.0 并入）、`codebuddy-intl`（v0.10.x 并入）均被收养。
- **向 CPA 提供**：
  - provider/auth id：`workbuddy`；auth 文件 `workbuddy-<uid>.json` / `workbuddy-intl-<uid>.json`，启动时自动收养 legacy `codebuddy-cn-<uid>.json`（`plugins/workbuddy/authfile.go:42,269`）。
  - 聊天：OpenAI 兼容 `POST copilot.tencent.com/v2/chat/completions`，强制 `stream=true`（PROTOCOL.md）。
  - 模型目录：双路 `/v3/config` 探测（`models.go`），nonChatModel 过滤。
  - **余额**：`billing.go`（`/v2/billing/meter/get-user-resource`）→ `quota.fetch`。
  - **签到 ✅**：`checkin.go` — `POST /v2/billing/meter/checkin-activity-status` + `POST /v2/billing/meter/daily-checkin`；指数退避调度（默认 0 点）。
  - **任务 ✅**：`taskcenter.go`（growth-center 每日任务循环）——`GET /tasks`、`POST /tasks/run`；五状态任务机（accept/.../claim），`tasks_auto` 默认随签到 tick 触发。这是五插件中**唯一明确承载「任务」协议**的插件。
  - 面板：`panel.html` + `management.register/handle`（`main.go:272-288`）。

### 2.2 trae（v0.12.71）——字节 Trae 家族

- **合并的地区变体**（registry description + PROTOCOL.md）：三变体合一——
  - Trae Code CN（`api.trae.cn`，`llm_utils_chat`，v0.12.79 起 function 统一 `solo_work_lite`，client_id `ono9krqynydwx5`）；
  - Trae SOLO CN（client_id `en1oxy7wnw8j9n`）；
  - Trae Intl（`api.marscode.com` OAuth + `core-normal.trae.ai` Web SOLO remote `chat_sessions`/`events` SSE）。
  - 自动收养 legacy `trae-cn` / `trae-solo-cn` / `trae-intl` auth 文件。
- **向 CPA 提供**：
  - provider/auth id：`trae`；按账号变体路由。
  - 聊天：CN 走 `llm_utils_chat` 自定义 SSE（`sse_convert.go` 转 OpenAI 信封）；Intl 走 Web SOLO remote 协议（`intlupstream/`）。
  - **余额 ✅**：`upstream/` v2 pay 端点（`ide_user_pay_status` / `ide_user_ent_usage` / `user_current_entitlement_list`）→ `quota.fetch`。
  - **签到 ✅（仅 CN）**：`upstream/checkin_*` — `GET /trae/api/v2/ug/checkin_credits/status?did=` + `POST .../claim`，body `{"req_source":N}` 双探测（1→2），鉴权 `Cloud-IDE-JWT` 优先、Bearer 回退；Intl **无签到**（PROTOCOL.md 明确）。
  - 面板：`panel.html` + `intl_panel.html` + `management.*`（`main.go:414-425`）。

### 2.3 qoder（v0.8.45）——Qoder 家族（本次最新提交主角）

- **合并的地区变体**：CN（`qoder.cn` 登录 / `openapi.qoder.com.cn`、`gateway.qoder.com.cn` API）与 Intl（`qoder.com` / `openapi.qoder.sh`、`api3.qoder.sh`）合一，按账号 region 路由；收养 legacy `qoder-cn` / `qoder-intl`。
- **登录**：device-flow（PKCE S256 + machine_id）+ PAT→jobToken 导入。
- **聊天**：COSY 签名（`sign.go` 17 个 `Cosy-*` 头 + 自定义 base64 编码），`agent_chat_generation` SSE 信封解包。
- **余额**：`billing.go`（`/api/v2/quota/usage`、`/user/plan`）→ `quota.fetch`。
- **签到 ✅**：`checkin.go` + `campaign.go` —— v0.12.80 起 CN 与 Intl 统一走 **campaigns 系统**（`GET /sash/api/v1/me/campaigns` + `POST .../campaigns/{id}/claim`）；legacy `daily-check-in` 已被上游禁用（恒 409），插件只读其 status 做展示。
- **cf5f6af 修复根因**（README + PROTOCOL.md「qoder-cn」节）：旧插件逆向的是 qoderwork IDE 插件协议（client_id `1c5e33e1-...`、`qoder-work-cn://` 回调），而**官方桌面客户端 v0.4.3** CN+Intl 共用 client_id `732aef47-9cf2-46a2-95fe-4cebb5d0d1fa`、`biz_variant=qoder`、CN auth host 是 `qoder.cn`（非 `qoder.com.cn`）。服务端把「14 天 Pro 试用 + 300 Credits 新人福利」挂在**桌面客户端登录事件**上发放——旧 IDE 协议登录永远触发不了，这就是「qoder cn/init 无法签到也无法领取首登奖励」的根因。v0.8.45 起 CN/Intl 默认都用桌面客户端协议。
- 面板：`panel.html` + `management.*`（`main.go:286-296`）。

### 2.4 zcode（v0.2.0）——智谱 GLM 编码套餐家族

- **合并的地区变体**：Z.AI 国际（`api.z.ai`）+ BigModel 国内（`open.bigmodel.cn`）合一，按账号 `provider` 路由；控制面/网关统一走 `zcode.z.ai`。收养 legacy 单文件 `zcode.json`（`authfile.go:49`）。
- **登录**：服务端中转 CLI 登录（`/api/v1/oauth/cli/init` + poll），**无本地回调**；凭据链解析出永久 API Key（`{apiKeyId}.{apiKeySecret}`）+ 无 exp 的 plan JWT。
- **聊天**：OpenAI 兼容 coding-plan 网关 + Anthropic 翻译层（start-plan）+ Signing V4（Ed25519 + PoW，fail-open 重试梯）+ off-peak 错峰票务通道。
- **余额 ✅**：`quota.go`（`billing/balance`，TV 身份头 + 稳定 `X-Device-Mid`）→ `quota.fetch`；试用套餐 `billing/claim`（`claim.go`，验证码在面板页由用户浏览器铸造）。
- **签到**：**无每日签到**（PROTOCOL.md 标注「—（claim 需验证码侧车）」）；面板动作是「领取试用包/周末包」而非每日打卡。
- 面板：`panel.html` + `management.*`（`main.go:267-277`）。
- 注：registry.json 中其 homepage 指向 `tree/zcode` 分支；未纳入 `scripts/build.sh`（仅 CI 构建）。

### 2.5 mimo（v0.2.17）——小米 MiMo 家族

- **变体**：双通道而非地区变体——sk 主通道（`platform.xiaomimimo.com` 浏览器 OAuth，X25519 + loopback 回调解 AES-256-GCM blob）+ cookie 副通道（收养桌面 app SSO 会话，Chromium `persist:xiaomi-account` partition，无 Authorization 头直连 `route/chat/completions`）。
- **向 CPA 提供**：仅聊天执行器（`stream.go`/`executor.go`）+ auth 登录（`oauth.go`/`cookies_*.go`）；`cmd/probe/` 是 Windows DPAPI 解 cookie 的开发侧车工具。
- **签到/任务/余额**：**均无**（全目录 grep 无 checkin/签到 代码；无 `panel.html`；无 quota 文件）。
- **登记状态**：**不在 registry.json**（registry 仅 workbuddy/qoder/trae/zcode 四条）；不在 `scripts/build.sh`；仅在 CI `release.yml` 的 5 插件矩阵中。`docs/MIMO_AUTH.md` / `docs/MIMO_PRIVACY.md` 是其协议与隐私边界文档。

---

## 3. 依赖与删留

### 3.1 无插件时 CPA 能否运行？

**能。** 证据：
- `plugins.enabled` 默认 `false`（`config.example.yaml:1105`）；`host.go:228-237` 在 disabled 分支直接置空 capability maps 返回，不报错。
- CPA 内置供应商执行器位于 `internal/runtime/executor/`：`claude_executor`、`codex_executor`、`gemini_executor`、`gemini_vertex`、`aistudio_executor`、`antigravity_executor`、`devin_executor`、`kimi_executor`、`meta_executor`、`xai_executor`、`openai_compat`。
- 本插件集的 5 个家族在上述内置列表中**一个都没有**——插件集是纯粹的「新增供应商」，不是 CPA 启动的必要条件。

### 3.2 账号面板用例需要哪些插件？

账号面板 = 余额 / 签到 / 任务 / 启用禁用。对照各插件能力：

| 插件 | 余额(quota) | 每日签到 | 任务循环 | 面板页(panel.html) | 面板用例结论 |
|---|---|---|---|---|---|
| workbuddy | ✅ billing.go | ✅ checkin.go | ✅ taskcenter.go | ✅ | **核心保留** |
| trae | ✅ upstream v2 pay | ✅ CN only | ❌ | ✅ | **核心保留** |
| qoder | ✅ billing.go | ✅ campaigns | ❌ | ✅ | **核心保留** |
| zcode | ✅ quota.go + claim | ❌（仅试用包领取） | ❌ | ✅ | **可选**：只在用户有 GLM 套餐账号时保留 |
| mimo | ❌ | ❌ | ❌ | ❌ | **删除候选**：面板无任何可操作面 |

### 3.3 保留 dist 预编译产物后，运行时还需要 Go/C 工具链吗？

**不需要。** 链路：CPA 二进制本身（已发布的静态/带 cgo 二进制）→ `dlopen` 用户放入 `plugins/` 的 `.so` → 插件内部一切网络请求自包含。Go runtime 被打进 `.so`，glibc/系统 libdl 由宿主 OS 提供。
- `scripts/build.sh`、各插件 `Makefile`、`.github/workflows/release.yml` 全部是**构建期资产**，运行时零引用。
- 用户侧开箱步骤 = 从 Release zip 取 `<plugin>.so` 放进 CPA 的 `plugins/` 目录 + `plugins.enabled: true`。
- 注意点：① `.so` 与宿主 CPA 必须同为 cgo 构建（CPA 的 `pluginhost` 只在 `build tag cgo` 下编译，非 cgo 构建无插件功能——`loader_unsupported.go`）；② 平台/架构必须与运行机匹配（linux-amd64 的 `.so` 不能在 windows 跑）。

### 3.4 删留 verdict 清单

| 对象 | verdict | 理由 / 对账号面板与 CPA 启动的影响 |
|---|---|---|
| `plugins/workbuddy/` | **保留** | 唯一同时承载签到+任务+余额的插件；删掉 = CodeBuddy 面板全失（余额/签到/任务三失）。源码测试文件（`*_test.go`）可在裁剪版中删，不影响运行。 |
| `plugins/trae/` | **保留** | CN 签到+余额面板；Intl 变体共享同一 .so，删了 Trae CN 签到即失。 |
| `plugins/qoder/` | **保留** | cf5f6af 刚修的签到/首登奖励是面板核心场景；删了 Qoder 签到即失。 |
| `plugins/zcode/` | **可选（建议保留）** | 无每日签到，但有余额面板+试用包领取；若账号面板要覆盖 GLM 套餐则保留，否则删。`zcode_system.json`、`signing.go` 等运行时必需，勿只删目录不删引用。 |
| `plugins/mimo/` | **删除** | 无签到/无任务/无余额/无 panel.html；未登记 registry、未入 build.sh；与「账号面板」用例零交集。删后若 CI 矩阵引用需同步改 `release.yml`（本地裁剪版无所谓）。 |
| `registry.json` | **可选（建议保留）** | 仅在线商店安装用；本地放 `.so` 到 `plugins/` 不读它。但它是 CPA `plugins.store-sources` 指认的目录清单，保留它才有「面板里安装/升级」的入口；注意当前文件**只有元数据、无 install.artifacts**，商店安装实际不可直接下载，需补 artifacts 或保持手动投放。 |
| `dist/` | **删除** | 现仅 3 个 `.h` 头文件（cgo 构建副产品），运行时无用；真实产物在 Release zip。保留它们反而误导用户以为「仓库里有预编译产物」。 |
| `docs/PROTOCOL.md` | **可选** | 493 行逆向协议事实表，是维护签到/任务字段解析的唯一参考；运行时不需要，维护期建议留（或挪进对应插件目录）。 |
| `docs/MIMO_AUTH.md` / `docs/MIMO_PRIVACY.md` | **删除** | 随 mimo 插件一起删。 |
| `scripts/build.sh` | **删除（运行时仓库）/ 保留（源码仓库）** | 纯构建脚本；且清单已落后于 CI（只编 3 个、漏 zcode/mimo）。交付给最终用户的最小仓库不需要它。 |
| `.github/workflows/release.yml` | **删除（用户侧）** | CI 发布管线；用户开箱无需。若本仓库继续维护则保留（它是预编译产物的唯一来源）。 |
| `README.md` / `LICENSE` | 保留 `LICENSE`；`README.md` 可选 | README 主要是协议溯源声明，运行时无用。 |
| `plugins/*/main.go` 等非测试源码 | 保留（若保留源码形态）；或直接用 Release 的 `.so` 替代整个 `plugins/` | 最小化交付形态 = 只放 N 个 `.so`，连源码都不用带。 |

> 最小交付形态建议：`CPA 二进制 + plugins/workbuddy.so + plugins/trae.so + plugins/qoder.so（+ 可选 zcode.so）+ plugins.enabled:true + auths/*.json`。一个 Go/C 工具链都不装。

---

## 4. 契约：CPA 启动时从插件读什么 / 最小插件必须提供什么

### 4.1 启动时的交互时序

1. CPA 扫 `plugins/` 目录 → 按文件名得 `<id>`。
2. `dlopen` → `dlsym("cliproxy_plugin_init")` → 传入 host_api（`abi_version=1` + host 回调函数表）。
3. 插件填回 plugin_api（`call / free_buffer / shutdown`）。
4. 宿主发 **`plugin.register`**（`sdk/pluginabi/types.go:36`）→ 插件返回 capability 声明：auth providers、executors、models、quota provider、management routes、scheduler 等。此后宿主按声明把该家族的 auth 文件路由给它。
5. 运行期按方法名调用：登录 `auth.login.start` / `auth.login.poll` / `auth.refresh`；聊天 `executor.execute_stream`；余额 `quota.fetch`；面板动作（签到/任务领取）走 `management.handle`，面板 UI 由插件 `management.register` 注册、宿主渲染 `panel.html`。

### 4.2 方法清单（`sdk/pluginabi/types.go:36-112`）

- 生命周期：`plugin.register` / `plugin.reconfigure` / `plugin.quiesce` / `plugin.shutdown`
- 模型：`model.register` / `model.static` / `model.for_auth` / `model.route`
- 账号：`auth.identifier` / `auth.parse` / `auth.login.start` / `auth.login.poll` / `auth.refresh`（另有 `frontend_auth.*`）
- 执行：`executor.identifier` / `executor.execute` / `executor.execute_stream` / `executor.count_tokens` / `executor.http_request`
- 转换/拦截：`request.translate|normalize|intercept_before|intercept_after|complete`、`response.*`、`websocket.response_event`、`thinking.*`
- 调度：`scheduler.pick`
- 用量：`usage.handle`
- 面板/CLI：`management.register` / `management.handle`、`command_line.register` / `command_line.execute`
- **余额/配额：`quota.identifier` / `quota.describe` / `quota.fetch` / `quota.reset`**
- 反向回调（插件→宿主）：`host.http.do(_stream)`、`host.model.execute(_stream)`、`host.stream.emit/close`、`host.log`、`host.auth.list/get/save`、`host.affinity.lookup` 等。

### 4.3 「账号面板用例」最小插件必须实现的面

一个只做账号面板（余额展示 + 签到/任务按钮 + 启停）的最小插件，C ABI v1 之上至少要：

1. 导出 `cliproxy_plugin_init / cliproxyPluginCall / cliproxyPluginFree / cliproxyPluginShutdown`，回写 `abi_version=1`。
2. 响应 `plugin.register`：声明
   - **auth provider**（`auth.identifier` + `auth.parse` + `auth.login.start/poll` + `auth.refresh`）——否则 CPA 面板里根本没有这个账号类型；
   - **executor**（至少 `executor.execute_stream`，否则账号无法被路由/上线；面板启停依赖账号存活）；
   - **quota provider**（`quota.identifier/describe/fetch`）——余额数字来源；
   - **management routes**（`management.register/handle`）——签到/任务等自定义 POST 动作的落点，配套内嵌 `panel.html`。
3. 可选但面板体验需要：`model.static/for_auth`（展示账号可用模型）、`usage.handle`（用量明细）。
4. 对签到场景的特殊要求：签到/任务是**插件侧自有的 HTTP 协议**（如 workbuddy 的 `/v2/billing/meter/daily-checkin`、qoder 的 campaigns claim），CPA 宿主不认识这些端点——插件必须自己用 `host.http.do` 回调或自带 HTTP client 完成，并把结果经 `management.handle` 返回面板。**这就是「签到与插件强相关」的契约含义**：删插件 = 删该家族全部签到协议实现，宿主侧无任何兜底。

---

## 附：关键文件索引

- 插件集：`registry.json`、`scripts/build.sh`、`.github/workflows/release.yml`、`docs/PROTOCOL.md`、`plugins/{workbuddy,trae,qoder,zcode,mimo}/`（各自 `main.go`=RPC 分发、`authfile.go`=账号文件名、`checkin.go`/`taskcenter.go`/`campaign.go`=签到任务、`billing.go`/`quota.go`=余额、`panel.html`=面板页）
- CPA 侧：`config.example.yaml:1104`（plugins 配置）、`internal/config/config_types.go:28`（PluginsConfig）、`internal/config/plugin_path.go`（dir 解析）、`internal/pluginhost/loader_unix.go`（dlopen）、`internal/pluginhost/platform.go:114`（目录扫描/文件名解析）、`internal/pluginhost/host.go:228`（enabled 开关）、`sdk/pluginabi/types.go:36-112`（方法表）、`internal/pluginstore/registry.go:50`（registry.json schema）、`internal/runtime/executor/`（内置供应商）
