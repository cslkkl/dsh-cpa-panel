# dsh-cpa-panel 架构说明

> 读者：改本仓代码的开发者与 agent。
> 范围：不变的设计决策、契约边界、防错清单（"为什么"）。
> 不含：文件级清单（见子目录 `README.md`）、步骤式 how-to（见 [PLAN.md](PLAN.md)）、实施细节（见 `../调研报告归档/核心文档集/`）。

---

## 0. 一句话

本仓是 DSH 插件，用作 CLIProxyAPI（下称 CPA）的**唯一控制台**：托管 CPA 进程、管理「渠道 × 账号 × 模型」独立调用单元、执行养号（签到 / 任务 / 保活）。

---

## 1. 现状与目标的区别

**本仓当前是已发布的可用插件，不是空骨架。** 目标形态（TS 工程化 + 单元机制 + 首启托管）尚未开工，规划见 [PLAN.md](PLAN.md)。

| 维度 | 现状（`0.1.0`，已发布） | 目标（未开工） |
|---|---|---|
| 代码形态 | 手写 JS，无构建步骤 | 宿主半端 TS + tsdown；`client.js` 保留 JS |
| 配置界面 | `client.js` 手工拼 DOM | schemastery 驱动表单 |
| 调用粒度 | 整渠道账号列表 | `units[]`：渠道 × 账号 × 模型 |
| 单账号锁定 | 「选择」= 启用一个 + 禁用同渠道其余 | 每单元独立 apiKey + `pinned_auth_id` 钉号 |
| 首启 | 探测 exe，找不到即报错 | 自动下载 exe 与 dll、校验 SHA-256、写最小 config |
| 进程托管 | `spawn` + 端口探活 | Job Object 父退子亡 + 三级退避 |
| 测试与门禁 | 无 | vitest + ESLint + Prettier + 只读 CI |

**现状不是要被丢弃的野路子**：`index.js` 中已验证的「插件 ↔ CPA」通话约定（路由契约、密钥边界、探测逻辑）是目标形态的地基，迁移时必须保形。

---

## 2. 系统三层与职责

界面与实现分离，密钥不下发浏览器。这三条是锁定决策，不因实现改动而变。

| 层 | 实体 | 职责 | 不做什么 |
|---|---|---|---|
| ① 浏览器 | DSH 插件页（`client.js`） | 渲染状态、发用户操作 | 不持有管理密钥、不直连 CPA |
| ② 宿主半端 | `index.js` | 持有密钥、表达 HTTP 路由、托管进程 | 不下发密钥、不做渠道协议翻译 |
| ③ 渠道适配 | `adapters.js` | 收敛四个渠道的接口差异 | 不碰 UI、不碰进程 |

第③层单独成文件的理由：四渠道（WorkBuddy / Trae / Qoder / ZCode）的余额单位、能力集、端点形态各不相同。渠道差异集中在一处，新增渠道不改路由层与 UI 层。

---

## 3. 三条数据流

### 3.1 用户操作链

浏览器调插件自己的 `/api/v1/cpa/*` → 宿主半端带密钥调 CPA `/v0/management/*` → 响应经 `adapters.js` 归一 → 回浏览器渲染。

### 3.2 进程生命周期链

DSH 启用插件 → 探测 CPA（已在跑则复用）→ 未跑则 `spawn` → 端口探活 → 就绪回显。
DSH 关闭时只关自己启的那个进程。

### 3.3 养号链

插件启动 → 读当天 stamp → 未补签则对支持签到的渠道发一次 → 写 stamp。
平日签到依赖 CPA 自带的 09:00 / 21:00 定时。

---

## 4. 契约边界（改动必须保形）

### 4.1 密钥边界

- 管理密钥只在宿主半端（`index.js`）内存与 DSH 凭据库中。
- 浏览器侧路由一律不带密钥参数。
- **破坏此边界 = 安全缺陷**，不是风格问题。

### 4.2 插件 HTTP 路由

浏览器半端只调本插件路由，路由清单以代码为唯一事实源（`index.js` 的 `path:` 声明）。

> 路由是**可枚举实体**，文档不复制清单：本文件与根 `README.md` 只讲规则，具体路由查代码。

新增路由时同步根 `README.md` 的路由表。

### 4.3 CPA 侧约定

- 只调用 CPA 的管理接口与转发面，**不改 CPA 的 `config.yaml` 路由策略**。
- CPA 管理面路径前缀 `/v0/management/`。
- 插件自身路由前缀 `/api/v1/cpa/`，两段前缀不得混用。

### 4.4 `disabled` 是唯一可靠的「单账号」手段

- `priority` 只是"尽量先用高的"，`fill-first` 取"第一个可用凭据"，两者都会在首选号不可用时降级到别的号。
- 只有禁用是"根本不参与"。
- 面板的「选择」做的就是禁用同渠道其余账号。

---

## 5. 防错清单

以下每一条都来自真实事故或已核实的源码行为，改动前先读。

| # | 防错项 | 原因 |
|---|---|---|
| F1 | 插件必须放在 profile 的 `node_modules/` 下，且是**真实目录** | DSH 按真实目录判定链接作用域；`link:` 到 profile 外会让 `@deepseek-ai/*` 导入退回原生解析 → `ERR_MODULE_NOT_FOUND` → 插件显示"未运行" |
| F2 | 改 `index.js` / `adapters.js` 后**必须重启 DSH** | 宿主半端不热重载；`client.js` 相反，刷新页面即可 |
| F3 | 插件 `inject` 必须列全 `client.js` 实际 `require` 的包 | 漏列会在运行时才暴露，不报编译错 |
| F4 | 停 CPA 不要依赖插件 shutdown 清理调度器 | 插件 shutdown export 是 no-op；从 c-shared runtime 触碰 Go sync 原语会在重启时 SIGSEGV。走「shutdown 端点 → Ctrl-C → `taskkill /F` 兜底」 |
| F5 | 被限流的号看不出异常 | 上游模型级限流（code 6004）下 CPA 仍报 `status: active`。面板显示"启用" ≠ "现在能用" |
| F6 | 按能力降级渲染，不给"点了没反应"的按钮 | 各渠道能力集不同（如 Trae 无任务、ZCode 无签到） |
| F7 | 所有外部仓库引用按 SHA 钉住，不追 `main` | 上游前移会让行号锚点与删留清单整体失效 |

---

## 6. 文档网络

### 6.1 分层约定

- 根 `README.md`：门面，面向使用者（用途 + 安装 + 配置 + 路由规则）。
- 根 `AGENTS.md`：维护索引，面向 agent（规则 + 命令 + 待办 + 活跃坑）。
- 本文件：设计圣经，写"为什么"。
- [PLAN.md](PLAN.md)：进行中的计划，写"什么时候做什么"。
- `../调研报告归档/`：调研与设计产物，**只读历史**，不参与持续维护。
- 每个可维护目录要有 `AGENTS.md`（规则层）+ `README.md`（文档层）。

### 6.2 引用约定

- 引用一律用相对路径，禁止写本机绝对路径（盘符、用户名目录）。
- 跨文档引用默认指向整个文档，不写"第 n 节"。
- 每条规则后跟精确引用，不用"见上文 / 详见下方"。
- 文档网络改动后跑链接校验，命令见根 [AGENTS.md](../AGENTS.md)。

### 6.3 信息 home 划分

同一事实只写一处，别处链接。

| 事实 | home |
|---|---|
| 怎么用、怎么装 | 根 `README.md` |
| 为什么这样设计 | 本文件 |
| 下一步做什么 | [PLAN.md](PLAN.md) |
| 现在什么状态、有什么坑 | 根 `AGENTS.md` |
| 调研结论与源码锚点 | `../调研报告归档/核心文档集/` |

---

## 7. 上游依赖坐标

基线 commit 一律以 SHA 钉住。上游前移时按 SHA 取快照，不追 `main`。

| # | 仓库 | 关系 | 地址 |
|---|---|---|---|
| 1 | CLIProxyAPI | 宿主本体（Go exe），只裁剪不重写 | https://github.com/zlZayn/CLIProxyAPI/tree/local-autobrowser |
| 2 | cpa-multi-plugins | 渠道插件集（4 个 dll） | https://github.com/mmqz/cpa-multi-plugins |
| 3 | 本仓 | 控制面 | https://github.com/cslkkl/dsh-cpa-panel |
| 4 | dsh-workbuddy-bridge | TS 工程范本（仅参考） | https://github.com/zlZayn/dsh-workbuddy-bridge |
| 5 | workbuddy-bridge-0.1.2-source | Go clean 范本（仅参考） | https://github.com/ki11a-Conton/workbuddy-bridge-0.1.2-source |

基线 SHA 与逐仓库职责详见 [99-入口索引](../调研报告归档/核心文档集/99-入口索引.md)。

---

## 8. 范围边界

- **仅 Windows**：CPA 以 Windows 可执行文件 + DLL 插件形式提供。
- **无 Docker**：单机单用户，不需要容器层。
- **DSH 宿主零改动**：一切通过插件实现，沿用 `cordis.patch.yml` 机制。
- **五仓库独立不合并**：唯一例外是无源码的 `.dll` 等二进制按 Release 预编译分发。
- **本仓不发布 CPA 本体**：本插件只是管理界面。
