# 产物 2-A：CLIProxyAPI 宿主改造详案

> 本文件是后续实施 agent 的**直接依据**，自包含、文件级精确。方向已锁定不可推翻。
> 基线：CLIProxyAPI @ `local-autobrowser`/`c121fde`（v8.0.7，module `.../v8`，go 1.26.0）。
> 跨仓库契约：插件集 cpa-multi-plugins（workbuddy 养号基座 + workbuddy-bridge A/B 对照）；控制面=dsh-cpa-panel（TS）。

---

## 0. 最终定位（一句话）

**把 CLIProxyAPI 裁剪成一个「绑 loopback、只服务 DSH 插件」的 Windows 单二进制数据面：对内提供带 pinned_auth_id 钉号的 OpenAI 兼容转发 + workbuddy 养号插件的签到/任务/保活，对外只暴露 v0/v8 Management JSON，无任何内置 UI。**

---

## 1. 目标目录树（裁剪后）

```
cli-proxy-api/
├─ cmd/server/main.go            # 服务入口（删登录子命令/TUI/discovery/home 分支）
├─ internal/
│  ├─ api/                        # Gin 装配：只留 /v1、/healthz、/readyz、/v8/management、/v0/management catch-all
│  │  └─ handlers/management/     # 账号 CRUD/启停/刷新/quota + ConfigV8 + plugins
│  ├─ config/                     # v8 配置定义/加载/热保存（原子写补丁）
│  ├─ pluginhost/                 # CGO-free Windows LoadDLL 加载 + 插件路由派发 + quota
│  ├─ watcher/                     # 监听 config + auths 热重载
│  ├─ access/config_access/        # access.api-keys 鉴权 + key→unit 映射注入点
│  ├─ runtime/executor/           # 只留 openai_compat_executor.go + helps/
│  ├─ cliproxy/auth 相关(sdk)      # Manager/Selector/conductor（选号+钉号）
│  ├─ logging, buildinfo, util, constant, credentialweight, interfaces, thinking(suffix)
├─ sdk/
│  ├─ cliproxy/auth, executor, session, usage, model_registry, service*.go
│  ├─ api/handlers/openai         # /v1 入口（+ base handlers_stream/routing/execution）
│  ├─ pluginabi, pluginapi, pluginhost, pluginstore
│  ├─ auth (file token store)
├─ plugins/*.dll                  # 运行时产物，不入仓库
├─ auths/*.json                   # 运行时账号
├─ config.yaml                    # 运行时配置
└─ logs/                          # 自动建
```

---

## 2. 删 / 留 / 改逐项清单（文件级）

### 2.1 删除面（每项含验证方法）
| 删除项 | 理由 | 「无人引用」验证方法 |
|---|---|---|
| `internal/tui` + charmbracelet/clipboard/open-golang | 终端 UI 不要 | `grep -rn "bubbles\|lipgloss\|tui\." internal/ cmd/ sdk/ \| grep -v _test` 应为空 |
| `internal/client/{claude,codex,grokbuild}` + WebRTC 路由 | realtime/live 转发不要 | `grep -rn "realtime\|live\b\|pion" internal/api/server_routes.go` 路由删后编译验证 |
| `internal/home`、`internal/homeplugins`、`cmd` home-jwt 分支 | Home 集群控制面不要 | `grep -rn "home-jwt\|HomeEnabled\|homeplugins" cmd/server/main.go` 删分支后编译 |
| `internal/store`（Postgres/Git/Object） | 只用 file token store | `grep -rn "PGSTORE\|GITSTORE\|OBJECTSTORE\|PostgresStore\|GitTokenStore\|ObjectTokenStore" cmd/` |
| `internal/discovery`（zeroconf/mDNS） | LAN 发现不要 | `grep -rn "discovery\|zeroconf" internal/cmd/ sdk/cliproxy/` |
| `Dockerfile`、`docker-compose*.yml`、`docker-build.ps1/.sh` | 纯容器封装，无原生复用 | 直接删（第三轮已确认零影响） |
| `internal/translator` 大部 | 纯插件渠道插件自译；只留 openai↔openai-compat 骨架 | 删 `_ "internal/translator"` 匿名 import（main.go:38）后编译报错点逐个裁决 |
| `internal/runtime/executor/{claude,codex,gemini,kimi,xai,devin,meta,antigravity,vertex,aistudio}_*` | 内置 OAuth 执行器，插件渠道不用 | `service_executors.go:281-313` switch 对应 case 删后，确认无 auth Provider 命中 |
| v0 冗余端点 ~90 条（server_management.go 单项配置 GET/PUT/PATCH 三元组） | 面板不用 | 见 §3.5 收敛清单；保留 `/v0/management/config`、`/plugins/:id/config`、插件 catch-all |
| `internal/managementasset`、`/management.html` 路由、workbuddy `panel.html`/`panel.go` UI、顶层 `assets/` | 内置 UI 全删 | `grep -rn "management.html\|managementasset\|panel.html" internal/ cmd/ sdk/` |
| `cmd/server/main.go:830-947` openControlPanel | local 分支增量，不要 | 删除该函数与调用 |

### 2.2 保留面
`cmd/server`（瘦身后）、`internal/api`（仅 management 组 + /v1 + /healthz + /readyz）、`handlers/management`、`internal/config`、`internal/pluginhost`、`internal/watcher`、`internal/access`、`sdk/cliproxy/auth`、`sdk/cliproxy/executor`、`sdk/api/handlers/openai`、`openai_compat_executor.go`+`helps/`、`internal/credentialweight`、`internal/thinking`(suffix)。

---

## 3. 自研补丁详设（接口级）

### 3.1 原子写 ×2（temp+fsync+rename）
- **config 写**：`internal/config/config_yaml.go:102` `os.WriteFile(configFile,data,0600)` →
  ```
  tmp := configFile + ".tmp"
  f,_ := os.OpenFile(tmp, O_CREATE|O_WRONLY|O_TRUNC, 0600)
  f.Write(data); f.Sync(); f.Close()
  os.Rename(tmp, configFile)
  ```
  防 watcher 读半截（watcher 监听 configPath，rename 原子替换避免读到半截 YAML）。
- **auth 写**：`internal/api/handlers/management/auth_files_crud.go:272` 同法改 `os.WriteFile(dst,data,0600)` → temp+Sync+rename。

### 3.2 /readyz 语义
- `internal/api/server_routes.go` 仿 healthz 加 `GET /readyz`。
- 语义：插件 host 初始化完成（`pluginHost.ApplyConfig` 返回 + 至少一个 enabled 插件 dlopen 成功）前返回 **503**，完成后 **200**。
- 数据源：`pluginHost` 暴露 `Ready() bool`（或已加载插件计数 >0）。

### 3.3 POST /v8/management/shutdown
- 注册在 `server_management_v8.go`（management 组，走 `mgmt.Middleware()` 鉴权）。
- 实现：handler 内异步 `go service.Shutdown(context.Background())`（service_lifecycle.go:228 已有），先回 200 再停。复用现有优雅停机路径。

### 3.4 key→unit 映射（方案甲，约 10 行）
- 数据结构：`map[apiKey]unit{provider, authID, model}`，由 DSH 经 Management API 写（首启注入）。
- 注入点：
  - 常量已存在：`sdk/cliproxy/executor/types.go:35 PinnedAuthMetadataKey="pinned_auth_id"`。
  - 选择器已只认该 auth：`conductor_selection.go:1203/1295`。
  - 写入点：`sdk/api/handlers/handlers.go:229` 已在读 `pinnedAuthIDFromContext`。
- 补丁：在 access 中间件校验 key 后，若 key 命中 unit 映射，则 `WithPinnedAuthID(ctx, unit.authID)`（handlers_context.go:69 现成 helper）。→ 请求经 `requestExecutionMetadata`（handlers.go:229-231）自动写 `pinned_auth_id`，selector 钉死该号。
- **单元 API key 字段名统一为 `units[].apiKey`**；authRef 语义 = auths 文件 id/label。

### 3.5 v0 冗余端点收敛
- **保留**：`/v0/management/config`(GET)、`/v0/management/plugins/:id/config`(GET/PUT/PATCH)、`/v0/management/plugins/:id/quota*`、插件 catch-all（`pluginManagementNoRoute`，挂 workbuddy 的 `/checkin /tasks /tasks/run /credits /accounts`）。
- **删除**：其余 ~90 条单项配置 GET/PUT/PATCH（api-keys/routing/debug/proxy-url/各 *-api-key 组）——DSH 只走 `/v8/management/config` 子树。

---

## 4. 改名映射表
默认保持原名。需重命名者无（保持 CPA 原名）；仅新增符号：
- `Ready()`（pluginhost 新增）、`ShutdownHandler`（management 新增）、`unitMapping`（access 新增）。
- 三仓库统一：单元 API key = `units[].apiKey`；authRef = auths 文件 id；管理前缀 `/v0/management` 与 `/v8/management` 双轨并存；checkin/tasks/credits 路径保持 cpa-multi-plugins 注入形态（`/v0/management/plugins/workbuddy/{checkin,tasks,tasks/run,credits,accounts}`）不变。

---

## 5. 废接口/废函数清单
| 项 | 处置 |
|---|---|
| `/v1/images/*`、`/v1/videos*`、`/v1/realtime/*`、`/backend-api/codex/*`、`/v1beta/*` | 删路由 |
| OAuth 回调 `/anthropic/callback` 等 5 条 | 删 |
| 内置各 provider executor 的 Exported 构造函数 | 删包即随包删 |
| `management.html` 静态 handler | 删 |
| `internal/translator` 非 openai 格式 | 删；保留但不导出 |

---

## 6. 依赖处理（go.mod 逐条，删除前 grep 验证）
| 依赖 | 判定 | grep 验证 |
|---|---|---|
| `pion/webrtc*` | 删 | `grep -rln "pion" internal/ sdk/` 空才删 |
| `charmbracelet/*`+clipboard+open-golang | 删 | 同法 |
| `jackc/pgx*` | 删（去 Postgres store） | `grep -rln "pgx" internal/store/ cmd/` |
| `minio-go` | 删 | `grep -rln "minio" internal/store/` |
| `go-git/v6`+go-billy | 删 | `grep -rln "go-git\|go-billy" internal/store/` |
| `redis/go-redis` | 删（去用量队列） | `grep -rln "go-redis" internal/redisqueue/` |
| `libp2p/zeroconf` | 删 | `grep -rln "zeroconf" internal/discovery/` |
| `refraction-networking/utls` | 删 | `grep -rln "utls" internal/` 空才删 |
| `tiktoken` | 删 | `grep -rln "tiktoken" internal/ sdk/` |
| `logrus`、`gin`、`fsnotify`、`godotenv`、`yaml.v3`、`bcrypt`、`gjson/sjson`、`uuid`、`x/sys/windows` | **留** | 核心运行时 |
> 每删一组跑 `go mod tidy` + `go build ./cmd/server` 验证。

---

## 7. 验证点清单

> **注：V1/V2/V5 的 provider 以《产物2-融合》§8 为准 = `workbuddy` / `workbuddy.dll`**（`workbuddy-bridge` 是不发布的范本仓库）。下列条目里的 `workbuddy-bridge` 字样一律读作 `workbuddy`。

1. **ABI 冒烟-账号面板**：起服后 `GET /v0/management/plugins/workbuddy-bridge/accounts` 带 `X-Management-Key`，预期 200 JSON 账号列表；验证插件 management.register/handle 被宿主正确派发。
2. **ABI 冒烟-流式**：发一条 `workbuddy-bridge/<model>` `/v1/chat/completions`，预期 SSE 流式回传；验证 execute_stream + host.stream.emit/close 异步流通。
3. **ABI 冒烟-auth 回调**：插件调 `host.auth.list/get`，预期宿主返回账号 JSON；验证 host_callbacks.go:174 派发。
4. **Windows 构建链**：跑 `build-local.ps1`（CGO=1+MinGW），预期产出 `cli-proxy-api.exe`；常见报错=缺 `.toolchain/mingw64/gcc.exe` 或端口占用，按提示处理。
5. **CGO=0 纯 Go（可选）**：`CGO_ENABLED=0 go build ./cmd/server` 后加载 workbuddy-bridge.dll，预期正常（loader_windows 纯 syscall）。
6. **key→unit 端到端**：用单元 key 调 `/v1`，预期仅该 unit 的 auth 被用；DSH 配置映射生效。
7. **pinned 不混用**：同 provider 配两个 auth，pinned 到其一后发请求，预期日志只出现该 auth，不出现另一个；失败时不 failover 到同 provider 其它号。
8. **删除端点无人调用**：对每个删端点 `grep -rn "<path>" internal/ sdk/ test/` 无业务引用。
9. **原子写**：写 config/auth 后立即 kill 重启，预期文件无半截、watcher 加载正常。
10. **/readyz**：插件 dlopen 中 503、完成后 200。
11. **shutdown 端点**：POST 后进程优雅退出（run.go:45 路径）。

---

## 8. 风险与回滚
| 阶段风险 | 回滚 |
|---|---|
| 误删被引用包（如 translator 匿名 import 牵连） | `git checkout` 恢复该文件；保留编译报错逐个裁决，不一次删干净 |
| v0 收敛破坏旧调用 | 保留 `/v0/management/config` 与 `/plugins/:id/config` 双轨，不一次性删 catch-all |
| 删内置 executor 影响插件渠道 | 先验证插件走 executor-candidate 分支（service_executors.go:319）再删；删前跑冒烟 1-3 |
| key→unit 映射写错 authID | 映射表由 DSH 校验后写入；错误时 pinned 无效回落 selector（不崩） |
| CGO=0 在某机器加载 dll 失败 | 回退 CGO=1+MinGW 路径（proven） |

---

### 附：关键锚点
- 原子写：`config_yaml.go:102`、`auth_files_crud.go:272`
- 钉号：`executor/types.go:35`、`conductor_selection.go:1203/1295`、`handlers.go:229`、`handlers_context.go:69`
- access 无绑定：`config_access/provider.go:30`
- 插件执行分支：`service_executors.go:319`
- 优雅停机：`run.go:45`、`service_lifecycle.go:228`
- ABI：`sdk/pluginabi/types.go:7`、`loader_windows.go:117`
