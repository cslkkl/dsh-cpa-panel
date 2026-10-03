# Windows 纯启动服务与生命周期托管

> 调研对象同前：`CLIProxyAPI` @ `local-autobrowser`/`c121fde`（`go 1.26.0`）。
> 本轮目标形态：**纯 Windows、无任何容器/编排**，一个 `cli-proxy-api.exe` 直接跑，DSH 插件一键拉起/停止进程。只读调研。

---

## 0. 一页结论

1. **Docker 五文件全删，Windows 原生运行零影响**——它们只是容器封装，没有任何原生流程复用的步骤；唯一要迁移进 DSH 认知的是**运行时目录布局**（config/auths/logs/plugins）。
2. **产物就是单个 `cli-proxy-api.exe`**；运行时必需侧件 = `config.yaml` + `plugins\*.dll` + `auths\*.json`。`management.html` 不编译进二进制、按需从 GitHub 下载到静态目录，`disable-control-panel: true` 时完全不需要。
3. **宿主本体零 cgo 坐实**：Windows 上 `loader_windows.go` 用纯 `syscall.LoadDLL`，两个 `import "C"` 文件都是 unix-only build tag。运行时用户机器**零工具链、零 MinGW**。
4. **生命周期**：SIGINT/SIGTERM 优雅停机已具备（`run.go:45`），但**没有 HTTP shutdown/stop 端点**——DSH 停止进程只能靠发 Ctrl-C/杀进程；单实例靠 TCP 端口绑定（无锁文件）；`/healthz` 在监听绑定后即返回 200，可作就绪探针。

---

## 1. Docker 删除边界确认

逐文件看：

| 文件 | 内容 | 原生运行是否复用 | 删除影响 |
|---|---|---|---|
| `Dockerfile` | 两阶段：`golang:1.26-bookworm` 里 `go build` → debian 运行；装 tzdata/ca-cert；`EXPOSE 8317`；`CMD ["./CLIProxyAPI"]` | 否。`go build` 步骤与 `build-local.ps1` 等价，已被原生脚本覆盖；tzdata/ca-cert 是 Linux 容器需要的，Windows exe 不需要 | 零 |
| `docker-compose.yml` | 镜像/端口映射 8317+WebRTC/discovery 一堆端口、卷挂载、`restart: unless-stopped` | **卷挂载揭示原生布局**（见下），但 compose 本身不复用 | 零 |
| `docker-compose.cluster.yml` | Home 集群模式（`HOME_JWT`、`-home-jwt` 命令） | 否，集群模式 | 零 |
| `docker-build.ps1` | 交互选 1/2，调 `docker compose build/up` | 否 | 零 |
| `docker-build.sh` | 同上 Linux 版 | 否 | 零 |

**compose 卷映射里要迁移进 DSH 认知的运行时布局**（不是要保留文件，而是记住这些相对路径）：

```yaml
# docker-compose.yml volumes 等价到原生 cwd：
config.yaml          -> ./config.yaml          （启动时 --config 指定）
auths                -> ~/.cli-proxy-api       （默认 auth 目录；repo 用 ./auths 覆盖）
logs                 -> ./logs
plugins              -> ./plugins
```

> 即原生运行 = 在某个工作目录里放 `config.yaml` + `auths/` + `plugins/` + `logs/`（自动建），exe 在同目录启动。compose 的 `restart: unless-stopped` 是容器重启策略——原生场景下由 **DSH 插件自己负责拉起/重启**，不需要它。
> 结论：5 个文件全删，无任何片段需要保留/迁移。

---

## 2. 单 exe 确认与运行时侧件

### 2.1 产物
`go build -o cli-proxy-api.exe ./cmd/server` → **单个 exe**。ldflags 注入 `main.Version/Commit/BuildDate`（可选）。

### 2.2 运行时必需侧件
| 侧件 | 必需？ | 说明 |
|---|---|---|
| `cli-proxy-api.exe` | 是 | 本体 |
| `config.yaml` | 是 | 无则用默认值/环境变量；DSH 生成 |
| `plugins\*.dll` | 渠道需要时是 | cpa-multi-plugins 产物；无插件则无渠道 |
| `auths\*.json` | 有账号时是 | 渠道账号凭据；可由 Management API 运行时写 |
| `management.html` | **否** | 见下 |
| `logs/` | 自动创建 | 非必需手动准备 |

### 2.3 management.html 来源（关键）
- **不编译进二进制**。`internal/managementasset/updater.go`（:31 `managementAssetName="management.html"`）在启动后**从 GitHub release 下载**（:262/:383，10MB 上限），缓存到 config 旁边的静态目录（:228 MkdirAll）。
- `remote-management.disable-control-panel: true` → **不下载、不提供该页**，`/management.html` 也不注册（DSH 自绘面板时关掉即可，省一次联网）。
- 无资源目录依赖：除上述 config/auths/plugins/logs 外，exe 不要求其它 `assets/` 目录。

### 2.4 exe 运行时写盘路径规律（托管进程关键）
| 写什么 | 位置 | 代码 |
|---|---|---|
| 应用日志 | `./logs/`（cwd 下，默认）；或 `authDir/logs` | `internal/logging/global_logger.go:185` |
| 请求日志/流式日志 | `logs/` 下子目录，MkdirAll | `internal/logging/request_logger_body_source.go` |
| config 写回（管理 API/PATCH） | `./config.yaml`（原地覆盖，保留注释） | handler.go persistLocked |
| 账号文件 | `auths/`（auth-dir） | token store |
| 插件 shadow-copy | `%TEMP%\cliproxy-pluginhost\pid-<pid>\` | loader_windows.go:193（进程退出即清） |
| management.html 缓存 | config 旁静态目录 | updater.go |
| **无 `.lock` 锁文件** | — | 全库未见 lockfile；单实例靠 TCP 端口绑定 |

> DSH 托管要点：把 exe + config + auths + plugins 放一个**固定工作目录**，用该目录作为进程 cwd 启动，日志就集中在 `./logs/`。

---

## 3. CGO 结论坐实

- **宿主 `import "C"` 全量清单**（`grep -rln '"C"' internal/ sdk/ cmd/`）：
  - `internal/pluginhost/loader_unix.go`、`host_callbacks_unix.go` —— build tag `cgo && (linux||darwin||freebsd)`，**Windows 不编译**。
  - 其余命中均为 `*_test.go`（测试，不进产物）或 `internal/tui/oauth_tab.go`（TUI，删除项）。
  - **→ Windows 生产宿主本体零 cgo。**
- `loader_windows.go`（`//go:build windows`）全程纯 Go：`syscall.LoadDLL` + `FindProc` + `syscall.NewCallback`，不链接 libc。

### 两种 Windows 构建命令
```powershell
# 路径 A（proven，已验证）：CGO=1 + 自带 MinGW（即 build-local.ps1）
$env:CGO_ENABLED="1"; $env:GOOS="windows"; $env:GOARCH="amd64"
go build -ldflags="-s -w" -o cli-proxy-api.exe ./cmd/server

# 路径 B（理论可行，需实测冒烟）：零工具链纯 Go
$env:CGO_ENABLED="0"; $env:GOOS="windows"; $env:GOARCH="amd64"
go build -ldflags="-s -w" -o cli-proxy-api.exe ./cmd/server
```
- 路径 B 成立依据：loader_windows.go 无 cgo 门禁、宿主零 cgo；若 `go mod tidy` 后无任何 windows+cgo 依赖，B 可行。**建议先用路径 A 出可用包，再试 B 去掉 MinGW 依赖并用一条插件请求冒烟。**
- **运行时用户机器零 CGO/零工具链**：用户只跑 exe，不需要 gcc/MinGW/Go。

---

## 4. 生命周期托管可行性

### 4.1 已有能力
| 能力 | 状态 | 证据 |
|---|---|---|
| 优雅停机 | **有** | `run.go:45 signal.NotifyContext(ctx, SIGINT, SIGTERM)`；`service_lifecycle.go:228 Shutdown(ctx)` 停后台 worker + 关 HTTP server + `pluginHost.ShutdownAllContext` |
| 就绪探针 | **有** | `GET/HEAD /healthz` 返回 200（`{"status":"ok"}`），在 `net.Listen` 绑定成功后即可用（server.go:293） |
| 单实例 | **靠端口绑定** | server.go:293 `net.Listen("tcp", addr)`；端口被占→`errListen`→Run 返回错误→**进程直接退出**。无锁文件 |
| 停机管理端点 | **没有** | 全库无 `/shutdown` `/stop` `/restart` 管理路由 |

### 4.2 DSH 一键拉起/停止的行为推论
- **拉起**：DSH 启动 exe（cwd=固定目录）。若端口已被占用，新进程绑定失败、打印错误并退出 → **不会出现两个实例互踩**。
- **"已在跑就复用"**：DSH 启动前先 `GET http://127.0.0.1:8317/healthz`；通 = 已有实例，直接复用，不重复拉起；不通 = 拉起新进程。**TCP 探活足够**（无锁文件可查，探活是最可靠的判活手段）。
- **停止**：因无 HTTP shutdown 端点，DSH 必须**发 Ctrl-C（SIGINT）或结束进程树**。Windows 下推荐 `taskkill /PID <pid>`（不带 `/F` 先试优雅，再兜底 `/F`）。
- **就绪时机**：DSH 拉起后轮询 `/healthz`，200 即就绪（绑定成功即 200，不等插件完全加载——若要等插件，需另加探针，见下）。

### 4.3 连续启停残余状态
- 插件 shadow-copy 在 `%TEMP%\...pid-<pid>\`，按 pid 隔离，退出清理（loader_windows.go:362）。
- 配置写盘是原子覆盖 + watcher 重载，**无跨进程持有的文件锁**；auths 同样。
- 日志句柄：lumberjack 轮转，进程退出即释放。
- **结论：干净启停，无残留锁/状态阻塞二次启动**。唯一注意：Windows DLL 映射——宿主从 shadow 副本加载，不锁 `plugins\` 原文件，因此二次启动可替换 `plugins\*.dll`。

### 4.4 DSH 托管 CPA 生命周期需满足的条件清单
1. 固定工作目录（exe+config+auths+plugins 同目录，日志落 `./logs`）。
2. 启动前 TCP 探活 `/healthz`，通则复用、不通则拉起。
3. 停止：SIGINT/Ctrl-C 优雅退出，超时（如 5s）再 `taskkill /F` 兜底。
4. 记录 pid，避免误杀。
5. （可选）`server.host` 绑 `127.0.0.1`，不暴露公网。

### 4.5 需要小改的钩子点（若要更顺滑）
- **[推荐] 新增一个管理停机端点**，如 `POST /v8/management/shutdown`（需鉴权），内部调 `service.Shutdown(ctx)`——这样 DSH 可优雅停进程而不必依赖 Ctrl-C/杀进程。当前缺这个，是唯一明显缺口。
- **[可选] 就绪探针区分"监听就绪"与"插件就绪"**：现 `/healthz` 在端口绑定后即 200，此时插件可能还在 dlopen；如需"插件就绪才算好"，可加一个 `/ready` 或让 `/healthz` 在插件 host 初始化完成前返回 503。
- **[可选] 启动失败（端口占用/配置错）时把退出码与错误写到一个固定文件**，便于 DSH 区分"启动中/已崩溃/已在跑"。

---

### 附：关键源码锚点（本轮）
- 优雅停机：`internal/cmd/run.go:45`、`sdk/cliproxy/service_lifecycle.go:228`
- 端口绑定/单实例：`internal/api/server.go:293` `net.Listen("tcp", addr)`
- 健康探针：`internal/api/server_routes.go:44-52`
- 日志目录：`internal/logging/global_logger.go:185`
- 面板下载：`internal/managementasset/updater.go:31,262`
- Windows 插件加载：`internal/pluginhost/loader_windows.go:81,193`
- Docker 布局参照：`docker-compose.yml` volumes 段
