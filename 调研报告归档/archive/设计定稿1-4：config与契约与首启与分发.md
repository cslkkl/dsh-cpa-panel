# 设计定稿 1-4：config 与契约与首启与分发

> 范围：CPA 宿主最小裁剪（数据面，Go 独立进程）+ dsh-cpa-panel（控制面，DSH 插件 TS）的落地设计。
> 证据基线：前四轮调研（v0/v8 路由表、v8 config 模板、生命周期、ABI 核验）。以下直接引用文件:行。
> **业务分支 A/B 标注规则**：A＝保留养号自动化（签到/任务/保活）；B＝纯反代（只 chat 中转+余额展示）。两份含分支的设计（1、3）显式标 A/B。

---

# 设计 1：最小 config.yaml schema（字段级）

## 1.1 两套配置要分清（关键认知）

| | CPA config.yaml（后端原生 v8） | DSH 插件侧「渠道配置数据模型」（new-api 风格） |
|---|---|---|
| 形态 | 后端进程启动即读的 YAML | 面板里用户看到的「渠道」对象 |
| 谁写 | DSH 插件首启原子写 + 运行时经 Management API 改 | DSH 插件内存态，落 DSH 自己存储 |
| 风格 | v8 嵌套布局 | new-api：类型/BaseURL/Keys[]/Priority/Weight/Models/ModelMapping/AutoDisable |
| 落点 | `server.*`/`management.*`/`access.*`/`oauth.*`/`plugins.*`/`routing.*` | 每个 new-api 字段 → CPA 一个概念（见 1.4 映射表） |

## 1.2 CPA config.yaml：首启生成的字段清单（v8 布局）

| 字段 | 类型 | 默认值 | 生成逻辑 |
|---|---|---|---|
| `config-version` | int | `8` | 写死，走 v8 嵌套布局（config.example.yaml:1） |
| `server.host` | string | `127.0.0.1` | 写死 loopback，不绑 0.0.0.0 |
| `server.port` | int | `8317` | 首启探测：8317 被占则 8318…递增直到空闲；**探测到的端口回写 config 并报给面板** |
| `management.secret-key` | string | — | **首启强随机生成**：`crypto/rand` 32 字节 → base64url。同时回显给面板并作为后续 `Authorization: Bearer` |
| `management.allow-remote` | bool | `false` | 写死 false（同机 loopback） |
| `management.disable-control-panel` | bool | `true` | 写死 true（DSH 自绘面板，不下载 management.html，省一次联网） |
| `management.disable-auto-update-panel` | bool | `true` | 写死 true |
| `access.api-keys` | []obj | `[{key: <随机>, ...}]` | 首启生成 1 个中转客户端 key：`sk-` + 32 字节 base64url；面板可再加 |
| `oauth.auth-dir` | string | `"./auths"` | 写死，相对 exe 工作目录 |
| `plugins.enabled` | bool | `true` | 写死 |
| `plugins.dir` | string | `"./plugins"` | 写死 |
| `plugins.configs.workbuddy.enabled` | bool | `true` | workbuddy 为养号基座，默认开 |
| `plugins.configs.workbuddy-bridge.enabled` | bool | `true` | A/B 对照并存 |
| `routing.strategy` | string | `"weighted-round-robin"` | 默认加权（配合 Weight） |
| `routing.session-affinity` | bool | `true` | 会话粘黏，缓存友好 |
| `requests.proxy-url` | string | `""` | 空；面板可选填上游代理 |

### 分支专属字段
- **分支 A（保留养号）**：`plugins.configs.workbuddy` 下保留签到/任务/保活开关（写入插件 config 子树，见 1.3）；**默认全关**（`checkin_auto=false`、`tasks_auto=false`、keepalive 按插件默认）。配置页加「自动签到/自动任务」开关，默认关，用户开才生效。
- **分支 B（纯反代）**：上述自动开关**写死 false 或干脆不写**——只保留 workbuddy 的 executor/model/management（余额展示）能力，不注册 checkin/tasks 定时；等价于「只启用 bridge 式纯反代」。面板不出现签到/任务入口。

## 1.3 示例 YAML（分支 A）

```yaml
config-version: 8
server:
  host: "127.0.0.1"
  port: 8317
management:
  secret-key: "<base64url 32B>"
  allow-remote: false
  disable-control-panel: true
  disable-auto-update-panel: true
access:
  api-keys:
    - key: "sk-<base64url 32B>"
oauth:
  auth-dir: "./auths"
routing:
  strategy: "weighted-round-robin"
  session-affinity: true
plugins:
  enabled: true
  dir: "./plugins"
  configs:
    workbuddy:
      enabled: true
      priority: 0
      # 分支 A：自动签到/自动任务默认关（具体键名随插件 config schema，经插件 config 端点下发）
      checkin_auto: false
      tasks_auto: false
    workbuddy-bridge:
      enabled: true
      priority: 0
```

## 1.4 DSH「渠道配置数据模型」→ CPA 概念映射表

| new-api 渠道字段 | 落到 CPA 哪个概念 | 落点/API |
|---|---|---|
| 类型（type） | provider id（workbuddy / workbuddy-bridge / …） | 插件 provider，不可改 |
| BaseURL | 插件内部上游地址（写死在 dll），一般不暴露给用户；如插件支持则写 `plugins.configs.<id>.base_url` | `PUT /v0/management/plugins/<id>/config` |
| Keys[] | **一个 key = 一个 auth 文件**（`auths/*.json`） | `POST /v8/management/credentials` 上传；`DELETE` 删除 |
| Priority | 账号 `priority`（int，数字小优先） | `PATCH /v8/management/credentials/fields` |
| Weight | 账号 `weight`（加权轮询权重，internal/credentialweight） | 同上；配 `routing.strategy=weighted-round-robin` |
| Models | 该渠道可用模型清单（插件自报 + 宿主注册表） | 读 `GET /v1/models`；限制用 excluded-models |
| ModelMapping | 用户模型名→上游真实模型名 | 插件 ModelRouter `TargetModel`（插件侧）；或 OpenAI-compat 别名 |
| AutoDisable | 账号不可用自动冷却（CPA 内置 cooldown 即做）；手动启停用 `PATCH /v8/management/credentials/status` | 启停：`PATCH .../credentials/status`；冷却宿主自动 |

## 1.5 字段可改性矩阵

| 字段 | 首启后能否 Management API 改 | 改法 | 需重启？ |
|---|---|---|---|
| `server.host/port` | 只读 | — | 需重启（绑定） |
| `trusted-proxies` | 只读 | — | **需重启**（config.go 注释明示） |
| `management.secret-key` | 可改 | `PATCH /v8/management/config/management.secret-key` | 热改（改后插件须换 key 重连） |
| `access.api-keys` | 可改 | `PATCH /v8/management/config/access.api-keys` | 热改 |
| `routing.strategy` / `session-affinity` | 可改 | `PATCH .../config/routing.strategy` | 热改 |
| `plugins.configs.<id>.enabled` | 可改 | `PATCH .../config/plugins.configs.<id>.enabled` | 热改（watcher） |
| 插件业务配置（checkin_auto/tasks_auto/BaseURL） | 可改 | `PUT/PATCH /v0/management/plugins/<id>/config` | 热改 |
| 账号 Keys[]/Priority/Weight/启停 | 可改 | `/v8/management/credentials*` | 热改（watcher 热加载） |
| `disable-control-panel` | 一般不动 | `PATCH .../config/management.disable-control-panel` | 热改 |

---

# 设计 2：插件 ↔ CPA 通信契约

## 2.1 端点清单

| 端点 | 方法 | 用途 | 分支 |
|---|---|---|---|
| `/healthz` | GET/HEAD | 存活/监听就绪 | 共用（已有） |
| `/readyz`（**建议新增**） | GET | 插件 dlopen 完成才算就绪 | 共用（需小改宿主） |
| `/v0/management/config` | GET | 鉴权握手验证 | 共用 |
| `/v8/management/config` | GET/PUT/PATCH | 读/写后端配置子树 | 共用 |
| `/v8/management/credentials` | GET/POST/DELETE | 账号 Keys 列表/增/删 | 共用 |
| `/v8/management/credentials/status` | PATCH | 启用/禁用账号 | 共用 |
| `/v8/management/credentials/fields` | PATCH | 改 priority/weight/label | 共用 |
| `/v8/management/credentials/refresh` | POST | 刷新 token / 连通性自检 | 共用 |
| `/v8/management/plugins/<id>/quota` | GET/POST | 读/实时拉余额 | 共用 |
| `/v0/management/plugins/<id>/config` | GET/PUT/PATCH | 插件业务配置 | 共用 |
| `/v0/management/plugins/workbuddy/accounts` | GET | 账号+积分面板数据 | 共用 |
| `/v0/management/plugins/workbuddy/checkin` | POST | **手动/自动签到** | 仅 A |
| `/v0/management/plugins/workbuddy/tasks`、`/tasks/run` | GET/POST | **任务列表/执行** | 仅 A |
| `/v0/resource/plugins/workbuddy/panel` | GET | 面板 HTML 资源 | 共用（DSH 自绘则不用） |
| `/v8/management/shutdown`（**建议新增**） | POST | 优雅停进程 | 共用（需小改宿主） |

## 2.2 鉴权握手
1. 首启：DSH 生成 `management.secret-key` → 原子写 config.yaml → 拉起 CPA。
2. DSH 之后所有 management 请求带头 `Authorization: Bearer <secret-key>`（或 `X-Management-Key`）。
3. 验证：`GET /v0/management/config` 返回 200 即握手成功；宿主侧 bcrypt 校验（handler.go:276-296）。
4. **loopback/Host/Origin 校验建议**：CPA 绑 127.0.0.1 已天然隔离；DSH 侧额外校验响应来源为 loopback。可选宿主小改：校验 `Host` 头 = `127.0.0.1:<port>`、拒绝非 loopback 来源（`allow-remote=false` 已是默认）。

## 2.3 错误码与超时约定

| 情形 | CPA 行为 | DSH 处理 |
|---|---|---|
| 未配 secret-key | Management API 整体 404（server.go:243） | 视为「未初始化」，走首启 |
| 错 key | 401/403 + 5 次失败 30 分钟 IP 封禁（handler.go） | 不重试，提示密钥错 |
| 成功 | 2xx + `{ok,result}` 信封 | 正常 |
| 调用超时默认值 | — | management 请求 5s；拉余额 10s；流式转发作 DSH 不介入（DSH 只控制面） |

## 2.4 轮询探活策略
- **TCP 探活**：起服务后先探 `127.0.0.1:port` TCP 连通。
- **监听就绪**：TCP 通 + `GET /healthz` 200。
- **插件就绪**：`GET /readyz` 200（建议加：插件 host init 完成前返回 503）。
- 间隔/退避：0ms→100ms→300ms→1s→2s，上限 5s 一轮；总等待 15s 超时。
- 区分：TCP/healthz 通但 readyz 503 =「监听就绪、插件加载中」，面板可先显示后端在线但渠道未就绪。

---

# 设计 3：首启引导状态机

## 3.1 流程（每步含失败处理）

| 步 | 动作 | 失败处理 |
|---|---|---|
| 1 定位 exe | `exePath` 配置 → 探测常见位置 → 都没有则从 Release 下载 | 下载失败：报「未找到/无法下载 cli-proxy-api.exe」，重试 3 次 |
| 2 校验 exe | 文件名/平台（windows-amd64）/SHA-256 对清单 | 校验不过：删除重下；仍失败终止并报错 |
| 3 拉 dll | 从 Release zip 拉 `plugins/*.dll` | 校验 SHA-256；失败重下 |
| 4 生成 config.yaml | 原子写：`config.yaml.tmp` → fsync → rename（防 watcher 读半截） | 写失败回滚删 tmp，重试；仍失败报「配置写入失败」 |
| 5 拉起 | 非 shell spawn，固定参数数组 `[exe, --config, configPath]`，挂 Job Object | 启动失败退避重启（指数+抖动，上限 5 次/5 分钟窗） |
| 6 探活 | TCP→/healthz→/readyz（2.4 策略） | 15s 超时未就绪 → 读日志最后行回显错误 |
| 7 面板回显 | 握手 GET /v0/management/config → 渲染渠道页 | 握手失败报「后端已起但管理接口不可用」 |

### 「已在跑就复用」
起服务前先 TCP+`/healthz` 探活：通则不重复拉起，直接复用（记录其端口）。无锁文件，探活是唯一判据（第三轮结论）。

### 分支 A/B 在本流程的差异
- **A**：首启 config 含 `checkin_auto/tasks_auto: false`；拉起后面板出现签到/任务页签。
- **B**：config 不含自动开关（或写死 false）；workbuddy 插件可只启用反代能力；面板无签到/任务页签。

## 3.2 卸载/关闭停止序列
1. 首选：`POST /v8/management/shutdown`（建议新增的优雅端点）。
2. 否则：向进程发 Ctrl-C/SIGINT（CPA `run.go:45` 已优雅停机）。
3. 兜底：超时 5s 后 `taskkill /PID <pid>`；再 3s 仍存活 `taskkill /F`。
4. **Job Object 父退子亡**：DSH 插件退出时，Job Object 确保 CPA 子进程一并清理，杜绝孤儿。

---

# 设计 4：分发 / 校验流程

## 4.1 产物来源
| 产物 | 来源 | 备注 |
|---|---|---|
| `cli-proxy-api.exe` | 宿主最小裁剪后自建发布 | `CGO_ENABLED=1 go build -ldflags="-s -w" -o cli-proxy-api.exe ./cmd/server`（proven）；零工具链用户只拿 exe |
| `workbuddy.dll` 等 | cpa-multi-plugins Release zip 已有 | windows-amd64 产物 |
| `workbuddy-bridge.dll` | **0.1.2-source 无 CI，需自建** | `-buildmode=c-shared` 编译，随宿主产物一起发布 |

workbuddy-bridge 构建命令（插件侧，需 cgo 工具链）：
```
go build -buildmode=c-shared -o workbuddy-bridge.dll ./...
```

## 4.2 平台/文件名校验规则
- 平台：`windows-amd64`。
- exe 名：`cli-proxy-api.exe`。
- 插件：`<id>.dll` 放 `plugins/`（宿主 shadow-copy 加载，不锁原文件）。

## 4.3 SDK 版本兼容矩阵（宿主 × 插件）

| 宿主 SDK | 插件 SDK | ABIVersion | SchemaVersion | 结论 |
|---|---|---|---|---|
| v8.0.7 | v7.2.30（本 bridge） | 两边 1 ✅ | 1 vs 6 协商兼容 | **可加载**；插件按旧 schema 行为，宿主自动适配（已核验） |
| v8.0.7 | v8.x（重钉后） | 1=1 ✅ | 6=6 | 可加载 + 享新 RPC 行为 |
| 宿主未来 v9 | v7.2.30 | 若 v9 ABIVersion 变 | — | **可能加载失败** → 必须成对升级 |
| 宿主 v8.0.7 | 更早插件（ABIVersion≠1） | 不等 | — | loader 报 abi_version 不支持（loader_windows.go:117） |

## 4.4 成对升级规则
宿主升 SDK → 插件 go.mod 重钉到同版 → 双产物（exe + dll）同发同验。DSH 首启「拉 dll + 校验 SHA-256」为**必加步骤**（不能假设用户自备 dll）。

## 4.5 DSH 首启拉取 dll 步骤设计
1. DSH 记录所需 `(exe 版本, dll 清单 + 各自 SHA-256)`。
2. 启动时比对本地 `plugins/*.dll`：缺失或哈希不符 → 从 Release 拉对应 zip → 解压 → 校验 SHA-256 → 落到 `plugins/`。
3. 任一 dll 校验失败：删除并重拉一次；仍失败则提示「插件完整性校验失败」，不启动带损坏插件的后端。

---

### 附：关键证据锚点
- v8 config 布局：`config.example.yaml`；路由：`server_management.go:31-42`、`server_management_v8.go`
- 热改/重启：`handler.go:189-235`、config.go trusted-proxies 注释
- 优雅停机/单实例：`run.go:45`、`server.go:293`
- ABI 兼容：`sdk/pluginabi/types.go:7`、`loader_windows.go:117`
