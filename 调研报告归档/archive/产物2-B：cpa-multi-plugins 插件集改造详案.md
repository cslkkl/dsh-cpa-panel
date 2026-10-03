# 产物2-B：cpa-multi-plugins 插件集改造详案

> 终局设计文档（只读，不改代码）。方向锁定：主功能 = **养号自动化**（签到 / 领取 / 做任务）；运行面 = **Windows + Release 预编译产物 + 用户机零工具链**。
> 前置调研：同目录《cpa-multi-plugins 插件集拆解与删留清单.md》《插件集中转视角删留与 Windows 产物.md》《trae-qoder-zcode 干净形态重写评估.md》《渠道养号能力矩阵.md》。

---

## 1. 最终定位与目标目录树

**一句话定位**：cpa-multi-plugins 改造为「养号自动化插件集」——4 个 C-shared 插件（workbuddy/qoder/trae/zcode），保留全部签到/领取/任务/保活协议实现，删除纯中转冗余与 mimo 渠道，预编译 .dll 从 Release 分发。

```
cpa-multi-plugins/                     # 改造后仓库
├── README.md                          # 保留（改写成养号定位）
├── LICENSE                            # 保留
├── registry.json                      # 保留（在线商店元数据；见 §5 注）
├── scripts/
│   └── build.sh                       # 保留（仅 CI/维护用；用户机不需要）
├── docs/
│   └── PROTOCOL.md                    # 保留（养号协议事实唯一载体）
├── .github/workflows/release.yml      # 保留（唯一的 Windows .dll 产线）
├── plugins/
│   ├── workbuddy/                     # 全保留（主养号渠道）
│   ├── qoder/                         # 保留（签到+领取+保活）
│   ├── trae/                          # 保留（CN 签到；Intl 仅转发）
│   ├── zcode/                         # 条件保留（见 §2.4 双路径）
│   └── mimo/                          # ★ 整目录删除
└── dist/                              # ★ 删除（仅 3 个 .h 头文件，无产物）
```

顶层决策：
- `dist/` 删：仓库内只有 `dist/linux-amd64/*.h` 三个 cgo 头文件，无任何二进制；真正产物由 CI 产线进 Release zip，dist 在仓库里是误导项。
- `docs/MIMO_AUTH.md`、`docs/MIMO_PRIVACY.md` 删（随 mimo）；`docs/PROTOCOL.md` 保留——签到 req_source、campaigns、桌面协议等全部逆向事实在里面。
- `registry.json` 保留但降级：仅服务 `plugins.store-sources` 在线安装；本地投放 .dll 不读它。注意它当前无 `install.artifacts`，在线商店安装实际需补 artifacts 或保持手动投放。

---

## 2. 文件级删/留/改清单

> 说明：`*_test.go` 全部随主文件保留（CI `go test` 用），不逐一列出。

### 2.1 plugins/workbuddy/（全保留，主养号渠道）

| 保留文件 | 职责 |
|---|---|
| `checkin.go` | 每日签到（`schedulerLoop` :29，上游 `/v2/billing/meter/daily-checkin`） |
| `taskcenter.go` + `task_auto.go` + `task_chat.go` + `task_events.go` | 成长中心任务循环七连（report/makeup/accept/travel/redeem/lottery/claim），`tasks_auto` 默认随签到 tick |
| `growth.go` | 成长中心上游面（任务列表/接受/奖励/ streak / 旅行 / 补偿） |
| `school.go` | 开学季活动券（窗口门控 `in_period`） |
| `keepalive.go` | 22:00 主动刷 token，防 Keycloak 会话 12153 全灭 |
| `lifecycle.go` | 积分耗尽自动 disabled / 签到回积分自动恢复 |
| `scheduler.go` | 双节奏定时器（0 点签到 + 22 点保活） |
| `management.go` + `panel.go` + `panel.html` | 管理端点与面板页 |
| `executor` 转发面（`stream.go`/`payload.go`/`models*.go`/`oauth.go`/`authfile.go`/`billing.go`/`credits_handler.go`/`cooldown` 系） | 转发+账号底座，养号端点依赖其上 |

**management 端点清单（DSH 详案引用，不变）**：`GET /accounts` · `POST /refresh` · `POST /checkin` · `GET /tasks` · `POST /tasks/run` · `GET /school/vouchers` · `POST /checkin/config` · `GET /credits` · `POST /trial` · `POST /keepalive` · `GET /keepalive/status` · `POST /select` · `POST /import` · `GET /models/groups`（base = `/v0/management/plugins/workbuddy`，注册于 `management.go:146-159`）。

可删：无（本渠道就是养号本体）。

### 2.2 plugins/qoder/（保留：签到 + claim-pro + 保活 + 桌面协议）

保留核心：
- 养号：`checkin.go`（campaigns 签到）、`campaign.go`（campaigns 列表/claim）、`credits_handler.go`、`keepalive.go`、`lifecycle.go`。
- 转发/登录：`sign.go`（COSY 签名）、`encoding.go`（自定义 base64）、`body.go`、`stream.go`、`cosy_session.go`、`machine_identity.go`（umid 机器指纹，桌面协议必需）、`oauth.go`（device-flow + cf5f6af 桌面客户端 v0.4.3 协议，client_id `732aef47-...`）、`region.go`（CN/Intl 路由）。
- 面板：`management.go` + `panel.go` + `panel.html`。

**端点清单（base = `/v0/management/plugins/qoder`）**：`POST /checkin` · `POST /checkin/config` · `POST /claim-pro` · `POST /keepalive` · `GET /keepalive/status` · `GET /accounts` · `GET /credits` · `POST /refresh` · `POST /import` · `POST /select` · `GET /cooldowns` · `POST /cooldowns/clear` · `GET /models/groups`（`management.go:120-132`）。

可删：无必须删项。`usage_note.go` 等用量展示文件若 DSH 无用量页可后续裁剪，本期不动。

### 2.3 plugins/trae/（保留：CN 签到；Intl 仅转发，不做养号期待）

保留核心：
- 养号：`upstream/client.go` 中 checkin_credits 段（v2/ug/checkin_credits status/claim，Cloud-IDE-JWT + req_source 1→2 双探测）、`management.go` 的 `/checkin` 端点。
- 转发底座：`upstream/payload.go`（body 白名单）、`upstream/solosse.go`、`sse_convert.go`（SOLO SSE→OpenAI）、`intlupstream/` + `intl_main.go`（Intl Web SOLO remote 转发）、`auth/auth.go`、`variant.go`、`scheduler/`（账号池选号）。
- 面板：`management.go` + `intl_management.go` + `panel.html` + `intl_panel.html`。

**端点清单（base = `/v0/management/plugins/trae`）**：`POST /checkin`（CN）· `GET /accounts` · `GET /credits` · `POST /refresh` · `GET /status` · `POST /release` · `POST /import` · `GET /intl/accounts` · `GET /intl/status` · `POST /intl/import` · `GET /models/groups`（`management.go:91-101`）。

配置面：`checkin_auto` 布尔（`main.go:492`，default true，本地 09:00）——DSH 配置页保留此开关。

可删（可选，非必须）：`heal.go` 等自愈若 DSH 不展示健康状态可后续裁；本期保留。

### 2.4 plugins/zcode/（★ 双路径，待用户拍板）

**路径 A（养号保留面，推荐：新号池薅试用包）**：
- 保留：`claim.go` + `claim_scheduler.go`（试用包自动领取）、`preview.go`（可领试用计划）、`captcha_pool.go`（验证码池）、`panel.go`（面板）、`quota.go`（余额）、转发底座 `executor.go`/`stream.go`/`anthropic*.go`/`signing.go`/`oauth.go`/`auth_keyres.go`/`identity.go`/`system_prompt.go`/`offpeak.go`（错峰优惠通道）。
- 端点：`POST /claim` · `GET /preview` · `GET /claim_status` · `GET/POST /captcha_pool` · `GET /accounts` · `GET /credits`（`panel.go:295-307`）。

**路径 B（纯转发最小面，老号池）**：
- 删：`claim.go` · `claim_scheduler.go` · `preview.go` · `captcha_pool.go` · `offpeak.go` · `panel.go` 的领取路由段。
- 留：转发全套 + `quota.go` 余额。
- 与第四轮"砍 2250 行"一致；但养号主功能下默认走路径 A。

### 2.5 plugins/mimo/（★ 整目录删除）

理由：养号矩阵全空（无签到/领取/任务/保活）；management 仅 `/oauth_submit`、`/cookie_submit` 两个登录补登页；未登记 registry.json；不服务养号主功能。同步删 `docs/MIMO_AUTH.md`、`docs/MIMO_PRIVACY.md`；`release.yml` 的 PLUGINS 列表去掉 `mimo`（构建仍编 4 个）。

---

## 3. 改名映射与借鉴边界

### 3.1 改名映射表（默认全部保持原名）

| 原名 | 新名 | 说明 |
|---|---|---|
| `plugins/workbuddy/` | 不变 | provider id `workbuddy`，auth 文件 `workbuddy-*.json` |
| `plugins/qoder/` | 不变 | id `qoder` |
| `plugins/trae/` | 不变 | id `trae` |
| `plugins/zcode/` | 不变（路径 A/B 均不变） | id `zcode` |
| `plugins/mimo/` | 删除 | — |

不改名的理由：provider id 变更会引起宿主 auth 文件归属重扫与存量账号文件失配；养号端点路径形态（`/v0/management/plugins/<id>/...`）是 DSH 详案的引用接口，保持不变即零迁移成本。

### 3.2 workbuddy-bridge-0.1.2-source 借鉴（不合并仓库，仅借鉴模式）

明确：**不合并仓库、不改 provider id**。借鉴点只有一个——**wire 纯函数边界模式**：
- 对方 `wire.go:7-9` 的做法：上游协议层（URL/header/body 组装）写成无 C ABI、无 host call 的纯 Go 文件，可单测。
- 落地位置（未来实施时新建同名/同类模式，不在本期改代码）：
  - trae：`upstream/payload.go` 已经是近纯函数，继续保持；把 `upstream/client.go` 里混杂的 checkin 段与聊天段在重构时拆清。
  - qoder：`sign.go`/`encoding.go` 已是纯函数，保持；`body.go` 同理。
  - workbuddy：`payload.go` 已是纯函数式（reasoning_effort 裁剪在 :239）。
- 对方的「auth 只收养文件、不做浏览器登录」做法**不借鉴**——本方案养号需要桌面协议登录触发首登奖励（qoder cf5f6af）与 OAuth 登录流，登录面必须保留。

---

## 4. 废接口 / 废函数清单

| 废项 | 位置 | 处理 |
|---|---|---|
| `plugins/mimo/` 全部 RPC 分发（`main.go:274-310` 的 auth/executor/management case） | mimo 整目录删 | 随目录删除 |
| `docs/MIMO_AUTH.md` / `docs/MIMO_PRIVACY.md` | docs/ | 删 |
| `dist/linux-amd64/*.h` ×3 | dist/ | 删目录 |
| `release.yml` PLUGINS 列表中 `mimo` | CI 配置 | 改：`PLUGINS="workbuddy qoder trae zcode"` |
| trae Intl 的"签到期待"（PROTOCOL.md 明确 Intl 无签到端点） | 文档认知 | DSH 界面不对 Intl 变体渲染签到按钮（Intl 面板仅 accounts/status/import） |
| zcode"每日签到"期待 | 认知修正 | zcode 无每日签到；其养号动作 = 试用包/错峰领取，UI 分组为「领取」而非「签到」 |

非废项（易误删，保留）：
- qoder legacy `daily-check-in/status` 只读展示端点（上游已禁用 claim，插件仅读 status 补 streak 展示）——保留，因为面板仍要显示连续签到天数。
- workbuddy `/school/vouchers` 活动窗口外自动 `in_period=false`——保留代码，UI 折叠。

---

## 5. 依赖处理

### 5.1 Go 模块依赖
- 每插件独立 `go.mod`，统一依赖 `github.com/router-for-me/CLIProxyAPI/v7 v7.2.30`（插件 SDK：pluginabi/pluginapi）。删 mimo 后其 `go.mod` 一并消失，不影响其余 4 个模块。
- zcode `modernc.org/sqlite` 等依赖仅服务 mimo 的 cookie SQLite 读取——随 mimo 删除。

### 5.2 构建链依赖（CI 保留，用户机零依赖）

| 角色 | 依赖 | 说明 |
|---|---|---|
| CI 构建机（release.yml） | Go 1.26 + linux gcc / darwin clang / windows MSYS2 `mingw-w64-x86_64-gcc` | 仅 CI；产物 = `cpa-multi-plugins-windows-amd64.zip`（扁平 4 个 .dll，改造后去掉 mimo.dll） |
| 用户运行机 | **零工具链** | 只需 cgo 版 CPA windows 二进制 + 投放所需 .dll 到 `plugins/` 目录 + `plugins.enabled: true`。Go runtime 已打进 .dll；宿主 Windows 加载时 shadow-copy 再 LoadLibrary |
| `scripts/build.sh` | Go + C 编译器 | 维护者本地构建用；注意其插件清单当前只有 workbuddy/qoder/trae 三个，改造时需补上 zcode（与 CI 对齐）——这是唯一要改的脚本行 |

---

## 6. 验证点清单（冒烟用）

1. **workbuddy 签到冒烟**：`POST /v0/management/plugins/workbuddy/checkin` 带 `{auth_index}`，期望返回今日已签/领取积分；连跑两次验证幂等（二次应报已签而非报错）。
2. **workbuddy 任务七连冒烟**：`POST /tasks/run` 单账号跑完整循环（accept→travel→redeem→lottery→claim），核对五状态机每步返回与 `GET /tasks` 扫描一致，失败步不中断其余步。
3. **workbuddy 保活冒烟**：观察 schedulerLoop 22:00 tick 是否刷 token；故意把 refresh token 改旧，确认次日账号不再 12153 全灭。
4. **qoder 签到冒烟**：`POST /checkin` 走 campaigns（`/sash/api/v1/me/campaigns`），确认 claimStatus=CLAIMABLE 的项被领取、replayed=true 幂等；legacy status 只读展示 streak。
5. **qoder claim-pro 冒烟**：`POST /claim-pro` 对一个账号，确认 Pro 升级包 campaign 被领取；二次调用应报已领。
6. **qoder cf5f6af 首登奖励实测**（关键）：用新账号走 v0.8.45 桌面客户端协议登录（client_id `732aef47-...`，CN=`qoder.cn` 省略 redirect_uri），**实测确认服务端发放 14 天 Pro + 300 Credits**；若未发放即协议又被上游改动，触发 §7 回滚评估。
7. **trae CN 签到冒烟**：`POST /checkin` 对 CN 账号，确认 status/claim 双探测（req_source 1→2）；`checkin_auto=true` 时观察 09:00 自动 tick；Intl 账号不出现签到端点。
8. **zcode claim 冒烟（路径 A）**：`GET /preview` 列出可领试用计划 → 面板页过阿里云验证码铸 verify param → `POST /claim` 领取；`GET /claim_status` 看自动调度状态。路径 B 则跳过。
9. **keepalive 行为冒烟（qoder）**：`POST /keepalive` 手动刷全部 token，`GET /keepalive/status` 返回最近运行摘要；确认不影响在途 chat。
10. **reasoning_effort 各渠道差异实测**：workbuddy `payload.go:239` 会 strip "none"/"off"（腾讯拒绝），发这两个值验证被改写而非报错；trae `payload.go:219` v0.12.49 起透传（生产实证上游容忍），验证透传不被 400；zcode GLM-5.3 家族走 `output_config.effort` 而非 reasoning_effort，验证 effort 预算配对生效；qoder body 翻译层确认 reasoning 字段按 chat_task 形状丢弃/保留与上游一致。
11. **Windows 投放冒烟**：解压 Release zip 的 4 个 .dll 放入 cgo 版 CPA 的 `plugins/`，启动日志确认 4 个插件 `plugin.register` 成功、auth 文件收养正常、`/v0/management/plugins/<id>/accounts` 可访问。

---

## 7. 风险与回滚

| 渠道 | 风险 | 回滚 |
|---|---|---|
| workbuddy | 上游成长中心/签到端点改版（旅行/抽奖字段变动）导致 tasks/run 某步 4xx | 保留旧版 workbuddy.dll 不升级；DSH 侧可单独关闭 `tasks_auto`，签到与保活不受影响 |
| qoder | 上游再次改桌面客户端协议（cf5f6af 已逆过一次），签到 campaigns 或首登奖励失效 | 保留旧版 qoder.dll；登录可回退 PAT 导入（`POST /import` 走 jobToken exchange）；claim-pro 可停 |
| trae | 签到活动校验收紧（历史已出现 9074），req_source 双探测双双被拒 | 保留旧版 trae.dll；`checkin_auto` 关掉，转发不受影响（Intl 本就无签到） |
| zcode | 阿里云验证码挑战升级 / 试用包活动结束 | 路径 A 切路径 B：删 claim 路由段重编，或直接不投放 zcode.dll |
| 全局 | CI 产线故障发不出 Windows zip | 用 GitHub 上一个 Release 的 zip；`scripts/build.sh` 本地（补编 zcode 后）应急 |
| ABI | CPA 升级后 pluginabi v2 | 宿主侧 `pluginHostABIVersion` 校验挡加载；保留旧 dll 等插件集跟进 ABI |

**回滚总则**：一切按 .dll 文件粒度回退——DSH 只是调用方，插件行为全在 dll 内；出问题的渠道换旧 dll，其余渠道 dll 不动即完成单渠道回滚，无需重编用户机任何东西。

---

## 附：DSH 详案接口锚点（保持不变）

管理端点 base：`/v0/management/plugins/<provider>`（`management.go:122` base 常量 + `:143` provider 前缀）；面板页：`/v0/resource/plugins/<provider>/panel`。
- workbuddy：`checkin / tasks / tasks/run / school/vouchers / trial / keepalive / keepalive/status / checkin/config / credits / accounts`
- qoder：`checkin / claim-pro / keepalive / keepalive/status / checkin/config / credits / accounts`
- trae：`checkin(CN) / credits / accounts / refresh / release`
- zcode（路径 A）：`claim / preview / claim_status / captcha_pool / credits / accounts`

---

注：R13 已并入——插件渠道登录/auth/凭证验证全部保留；宿主内置 provider 族（internal/runtime/executor 内置族 + sdk/auth 内置族 + browser.go + OAuth callback 5 条）为宿主侧删除面，见《产物2-融合》§11 R13；本插件集零牵连。
