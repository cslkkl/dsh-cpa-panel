# dsh-cpa-panel

把 **CLIProxyAPI（CPA）** 的账号管理搬进 **DeepSeek Harness（DSH）** —— 看余额、签到、跑任务、切账号，日常不用再开 CPA 的网页控制台。

## 它做什么

打开 DSH 的 **插件 → CPA 中转站面板**，四个渠道各一个标签：

- **账号余额**：可用 / 已用 / 额度池 / 套餐包数；token 与积分分开算，不混加
- **一键操作**：全部签到、全部任务、刷新；每账号可单独签到 / 任务
- **启用 / 禁用账号**：禁用后该号完全不参与调度 —— 这是「只用一个号」的可靠办法
- **账号使用顺序**：拖动卡片排序，用满一个再切下一个
- **自动签到开关**：读取并切换 CPA 的 `checkin_auto`
- **活跃账号检测**：按真实请求统计标出「使用中」
- **进程生命周期**：DSH 开则 CPA 起（已在跑就复用），DSH 关则只关自己启的那个
- **开机补签**：CPA 自带的 09:00 / 21:00 定时会因 DSH 未开而漏，插件启动时补一次

### 支持四个渠道

| 渠道 | 账号数 | 余额单位 | 签到 | 任务 |
|---|---|---|---|---|
| WorkBuddy | 多号 | 积分 | ✅ | ✅ |
| Trae | 多号 | 积分池 | ✅ | — |
| Qoder | 单号 | 积分 | ✅ | — |
| ZCode | 单号 | **token** | — | — |

**按能力降级**：插件不支持的功能不渲染，不给"点了没反应"的按钮。

## 前置条件

⚠️ **本插件不含 CPA 本体**（只有约 108 KB 的 JS），它只是 CPA 的管理界面。

你需要先有：

1. **DSH**（DeepSeek Harness）
2. **CLIProxyAPI 本体** —— 从官方仓库获取
3. **对应的渠道插件**（`workbuddy.dll` / `trae.dll` / `qoder.dll` / `zcode.dll`）—— 放在 CPA 的 `plugins/` 目录
4. **CPA 的管理密钥** —— 配置项 `adminKey`，或写进凭据库 `CPA_ADMIN_KEY`

## 安装

```
plugin_manager action: install_bundle
target: <本目录绝对路径>
```

插件必须放在 **profile 的 `node_modules/` 下，且是真实目录**（不是符号链接）。

**为什么不能用 `link:` 指到 profile 树之外**：DSH 的 runtime resolution 按**真实目录**判定链接作用域。profile 外的链接会让插件的 `@deepseek-ai/*` 导入退回原生 Node 解析，而 `profiles/node_modules` 不在其祖先链上 → `ERR_MODULE_NOT_FOUND` → 插件显示"未运行"。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `adminKey` | 空 | CPA 管理密钥；留空则走凭据引用 |
| `adminKeyRef` | `CPA_ADMIN_KEY` | 凭据库里的引用名 |
| `port` | `8317` | CPA 监听端口 |
| `exePath` | 空 | CPA 可执行文件路径；留空按常见位置探测 |
| `manageLifecycle` | `true` | 是否由本插件负责 CPA 启停 |
| `autoCheckinOnStart` | `true` | 启动时是否补签 |
| `openControlPanel` | `false` | 是否让 CPA 启动时自动打开它自带的管理控制台 |
| `startTimeoutSeconds` | `30` | 等待 CPA 就绪的最长秒数 |

## 安全

**管理密钥只在宿主半边，永远不下发到浏览器。**

浏览器侧只调插件自己的 `/api/v1/cpa/*` 路由，由宿主带密钥去调 CPA。浏览器看不到也拿不到密钥。

## 已知限制

- **仅 Windows**：CPA 目前以 Windows 可执行文件 + DLL 插件形式提供。
- **不改动 CPA 的配置**：插件只调用 CPA 的管理接口。路由策略等仍由 CPA 的 `config.yaml` 决定。
- **`disabled` 是唯一可靠的"单账号"手段**：`priority` 只是"尽量先用高的"，
  `fill-first` 取"第一个可用凭据" —— 两者都会在首选号不可用时降级到别的号。
  只有禁用是"根本不参与"。

## 文件

| 文件 | 作用 |
|---|---|
| `index.js` | 宿主半端：生命周期、HTTP 路由、持有密钥 |
| `adapters.js` | 四个渠道的接口差异收敛层 |
| `client.js` | 浏览器半端：面板 UI（CJS bundle） |
| `cordis.patch.yml` | 把本插件插入 profile 的 Loader 行 |
| `locale/*.json` | 插件卡片标题与描述 |

## 内部 HTTP 路由

浏览器半端只调这些路由，**不带任何密钥**：

| 路由 | 方法 | 作用 |
|---|---|---|
| `/api/v1/cpa/status` | GET | CPA 运行状态、端口、是否已配密钥 |
| `/api/v1/cpa/plugins` | GET | 已装渠道列表与能力 |
| `/api/v1/cpa/accounts?plugin=` | GET | 账号 + 余额 + 活跃账号 |
| `/api/v1/cpa/action` | POST | `{plugin, kind, authIndex}` → 签到 / 任务 |
| `/api/v1/cpa/account-enabled` | POST | `{plugin, authIndex, enabled}` → 启用 / 禁用账号 |
| `/api/v1/cpa/account-intent` | GET/POST | 读 / 恢复「用户上次的账号选择」 |
| `/api/v1/cpa/auth` | GET/DELETE | 起登录（`?plugin=`）/ 查进度（`?state=`）/ 取消 |
| `/api/v1/cpa/auto-checkin` | GET/POST | 自动签到开关 |
| `/api/v1/cpa/routing` | GET/POST | 路由策略 + 各渠道 `scheduler_mode` |
| `/api/v1/cpa/scheduler-mode` | POST | 把各渠道 `scheduler_mode` 归一到 `off` |
| `/api/v1/cpa/priority` | GET/POST | 账号使用顺序 |
| `/api/v1/cpa/start` | POST | 手动拉起 CPA |

## 许可

MIT
