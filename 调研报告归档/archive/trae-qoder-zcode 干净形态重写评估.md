# trae / qoder / zcode 干净形态重写评估

> 第四轮定向调研（只读）。参考形态：`workbuddy-bridge-0.1.2-source`（module `workbuddy-ai`，2331 行 / 10 文件：auth.go 124、billing.go 65、catalog.go 222、executor.go 418、httpclient.go 154、management.go 240、models.go 106、panel.go 67、plugin.go 338、wire.go 322）。
> 基准：新方案只需要「账号认证 + Chat 转发 + 模型目录 + 简单管理」，无签到/任务 UI、无余额面板。
> 对照：`cpa-multi-plugins` @ `cf5f6af` 的 `plugins/{trae,qoder,zcode}`（https://github.com/mmqz/cpa-multi-plugins）。

---

## 0. 一页结论

- **干净形态的可复制前提是「上游本来就是 OpenAI 形状 SSE」**：workbuddy-bridge 的 wire.go 直接打 `POST /v2/chat/completions` 透传（wire.go:10-14，上游就是 OpenAI-shaped SSE），所以它 322 行 wire + 418 行 executor 就够。三个渠道里**只有 zcode 的 coding-plan 路径天然满足这一点**。
- **verdict**：
  - **zcode → 重写（三渠道中最简单，用户判断成立，但有一个签名门禁风险点）**；
  - **trae → CN 重写可行 / Intl 保留原 dll（或删 Intl 变体）**；
  - **qoder → 「裁剪式重写」可行（不是 clean-room，而是搬运现有 Go wire 代码），工作量最大**。
- cpa-multi-plugins 仓库降级为**协议参考库 + 兜底 dll 源**；干净形态无内部调度器，`checkin_auto`/`tasks_auto` 配置开关**从配置页消失**，第三轮的约束解除。

---

## 1. 干净形态基准（从参考仓库提取的配方）

| 配方要素 | 证据 | 对重写的约束 |
|---|---|---|
| 不做浏览器登录，只收养账号文件 | `auth.go:3-4`「Login flows are deliberately unsupported in v1: credentials are adopted as files」 | 三个渠道的登录代码（oauth 浏览器流）全部可砍——前提是用户手里已有账号 token 文件 |
| wire 层纯函数、无 C ABI、可单测 | `wire.go:7-9`「pure: no C ABI, no host calls」 | 上游协议细节集中在一个文件，便于移植 |
| 上游 OpenAI 形状 SSE 逐帧清洗转发 | `wire.go:12` `/v2/chat/completions` + executor.go 418 行 | **协议翻译量 ≈ 0 是它小的根因** |
| 无调度器/无签到 | 全仓无 scheduler/checkin 文件 | 重写时天然不会引入 |
| 模型目录远程探测一次后缓存 | `catalog.go` 222 行 `/v3/config` | 可远程可静态 |

---

## 2. 逐渠道评估

### 2.1 zcode（GLM 编码套餐）——重写最简单，但注意两点

**执行路径真实需求**：
- 聊天双路由（`zcode/executor.go:28-75`）：
  - **coding-plan 账号 = OpenAI 兼容直连**：`https://api.z.ai/api/coding/paas/v4/chat/completions`（bigmodel 走 `open.bigmodel.cn/api/coding/paas/v4`），OpenAI 格式 body 透传，只加身份头 + trace 五件套（`executor.go:3-20` 注释自述）。**这正是 workbuddy-bridge 同款形状，干净形态最适配。**
  - **start-plan 账号 = Anthropic 网关**：`zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages`（`executor.go:31`），需要 anthropic 翻译层 `anthropic.go`(748) + `anthropic_sse.go`(546) + 官方 system 块 `system_prompt.go`(237) + `zcode_system.json`。
- 认证：服务端中转 CLI 登录（`oauth.go` 374）+ KeyResolver 链（`auth_keyres.go` 464：`z/login → getCustomerInfo → api_keys → copy`，终态永久 key `{id}.{secret}`）。干净形态按参考配方**砍掉浏览器登录、收养已解析 key 文件**即可。
- 模型目录：**静态钉死表**（PROTOCOL.md「模型目录」节：glm-4.5-air…glm-5.3-flash 共 10 个），无需远程 config 探测——比 workbuddy 的 catalog.go 还简单。
- **可砍包袱**：`offpeak.go`(691) + `offpeak_test`、`claim.go`(272) + `claim_scheduler.go`(283) + `panel.go`(711) + `preview.go`(292) + `quota.go`/`plane.go` ≈ **2250 行管理/错峰/领取逻辑，占全量 10726 的 ~21%**，且这部分与 Chat 转发完全正交。
- **风险点（1 个）**：V4 签名门禁（`signing.go` 529 行：Ed25519 握手 + PoW）。PROTOCOL.md 自述签名层 **fail-open**（门禁关/不可达即无签名发送），干净版可以**先发无签名请求**；但 coding-plan 网关一旦强制签名就会 401/3012。处置：干净版先无签名上线，遇 3012/VERIFY_SIGNATURE_INVALID 再补握手逻辑（算法已在 signing.go 里，可整段搬）。
- **verdict：重写 ✅**。预估干净版 ≈ auth 文件收养(150) + OpenAI 透传 executor(300) + 身份/trace 头(150) + 静态模型表(80) + anthropic 翻译层(若用户有 start-plan 账号，~1300)。coding-plan-only 形态 < 800 行。用户判断「zcode 是 token 单号渠道、无签到，重写尤其简单」**成立**。

### 2.2 trae——CN 可重写，Intl 是重灾区

**执行路径真实需求**：
- **CN 变体（trae-cn / trae-solo-cn）**：单调用 `POST trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat`（`upstream/client.go` 1551 行——但该文件混杂了 ExchangeToken/checkin/quota，纯聊天约占一半）；上游 SSE **不是 OpenAI 形状**，事件为 `metadata/timing_cost/output/extra_info/token_usage/done/error`，需要转换器 `sse_convert.go`(145)「SOLO SSE → OpenAI SSE real-time converter」。body 白名单归一化在 `upstream/payload.go`(356)，SOLO 消息体重排 `upstream/solosse.go`(490)。
- **Intl 变体**：**两次调用的 Web SOLO remote 协议**——`POST core-normal.trae.ai/api/remote/v1/chat_sessions` 建会话，再 `GET .../events` 长轮询累积 `plan_item` 事件（`intlupstream/client.go` 818 行 + `intl_main.go` 1306 行）。这不是一次流式响应，而是「建会话+拉事件流」的 poll 模型，且 mode/strategy 解析、plan_item 最长累积规则全部是从 TS（OmniRoute `trae.ts`）+ JS（9router）逆向来的。
- 认证：OAuth 浏览器流 + 本地 callback（`oauth_callback.go` 466）+ refresh；token 文件收养可替代。
- **可砍包袱**：`management.go`(1314) + `intl_management.go`(494) + `usage_note.go`(651) + `heal.go`(155) + `panel.html`(1096) ≈ **3700 行，占 15058 的 ~25%**（签到实现在 `upstream/client.go` 内的 checkin_credits 段 + v2 pay 配额段，一并砍）。
- **风险**：
  - CN 侧低风险：协议形状已被 sse_convert.go 证明可翻译，搬运即可。
  - Intl 侧高风险：chat_sessions/events 双调用 + 事件累积语义，是「悄悄坏」型协议（事件漏一个 plan_item 就静默丢字），clean-room 重写极易复现偏差。
- **verdict：CN 重写 / Intl 保留原 dll（或删 Intl 变体）⚠️**。干净版 CN 预估 1200-1500 行（client 聊天段 + payload 白名单 + sse_convert + variant 路由）。Intl 若要保留渠道，直接用现有 `trae.dll`（1551+818+1306 的 wire 是踩坑踩出来的），不必重写。

### 2.3 qoder——裁剪式重写可行，工作量最大

**执行路径真实需求**：
- 聊天每请求**三件套协议，缺一不可**（无法像 zcode 那样"裸奔"）：
  1. **COSY 签名**：`sign.go`(219) — `Authorization: Bearer COSY.{payloadB64}.{md5sig}` + 17 个 `Cosy-*` 头；
  2. **自定义 base64**：`encoding.go`(52) — 特殊字母表 `_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!`，`=`→`$`，三段重排；
  3. **信封解包**：`stream.go`(1059) — `{statusCodeValue, body}` 信封必须 peek 首事件拆出内层标准 OpenAI SSE。
  body 组装在 `body.go`(364)。这三件套都**小而确定**（219+52+364），且是从现有 Go 代码搬运，不是再逆向——这是「裁剪式重写」而非 clean-room。
- 认证：device-flow + machine_id（`machine_identity.go` 525：优先官方 umid 二进制，缺失则模拟身份）+ cf5f6af 刚定的**官方桌面客户端 v0.4.3 协议**（client_id `732aef47-...`，CN redirect_uri 省略、`biz_variant=qoder` 包装，auth host CN=`qoder.cn`/Intl=`qoder.com`）。干净形态按配方砍浏览器登录、收养 `dt-` token 文件。
- 模型目录：远程 `GET gateway.qoder.com.cn/algo/api/v2/model/list`（`models.go` 518 + persist 308），保留远程探测。
- **可砍包袱**：`campaign.go`(1327) + `checkin.go`(862) + `keepalive.go`(350) + `lifecycle.go`(589) + `credits_handler` + `billing.go`(333) ≈ **3500 行，占 13570 的 ~26%**。
- **风险**：不是协议知识风险（已全部在仓库里），而是**搬运精度风险**——COSY 签名的 tempKey 取法（UUID 去横线前 16 位）、base64 三段重排、信封 peek 顺序，任何一步抄错就是 401/解包失败。另一个隐性风险：桌面客户端协议是 cf5f6af 刚从 RPM asar 逆出来的，上游桌面端升级可能再变。
- **verdict：裁剪式重写 ✅（搬运现有 wire 代码）**。预估干净版 ≈ sign+encoding+body+stream 段(~2000) + oauth token 收养(~200) + models 远程目录(~400) ≈ **2500-3000 行**，是三渠道里最大的，但仍比原 13570 行砍掉约 75%。若追求最小，也可**直接保留原 qoder.dll** 当兜底，不动它。

---

## 3. 对 cpa-multi-plugins 整体角色的影响

| 问题 | 结论 | 证据 |
|---|---|---|
| 三渠道都走 clean 重写后，仓库角色 | **降级为协议参考库 + 兜底产物源**：`docs/PROTOCOL.md`（493 行协议事实表）是唯一知识载体；原 .dll 作为"重写出问题时的回退渠道"保留 | PROTOCOL.md 记录了全部 header/body/错误码 |
| workbuddy 是否留作 A/B | **不需要**——workbuddy 渠道已有干净版（即参考仓库本身），原 workbuddy 插件可删 | 参考仓库 module `workbuddy-ai` |
| 调度器约束是否消失 | **消失 ✅**。干净形态无 `go schedulerLoop`、无 checkin tick——配置页**删掉 `checkin_auto`/`tasks_auto` 两个开关**；第三轮"必须在 plugins.configs 写 false 关调度"的处置不再需要 | 参考仓库全文件清单无 scheduler；原调度器证据 `workbuddy/checkin.go:29` `go schedulerLoop` |
| zcode 重写是否尤其简单 | **是**。无签到/任务、静态模型表、coding-plan 路径 OpenAI 形状；唯一风险是 V4 签名门禁（fail-open 可裸奔，被拦再搬 signing.go） | `zcode/executor.go:3-20`、PROTOCOL.md「Client Request Signing V4」fail-open 段 |

---

## 4. 汇总 verdict 表

| 渠道 | 上游是否 OpenAI 形状 SSE | 协议翻译量 | 可砍管理包袱（占比） | 重写预估行数 | verdict | 主要风险 |
|---|---|---|---|---|---|---|
| zcode | coding-plan ✅ / start-plan ❌(anthropic) | 小 | ~2250（21%） | <800（纯 coding-plan）；+1300（含 start-plan） | **重写** | V4 签名门禁突然强制 |
| trae CN | ❌（自定义 SOLO SSE） | 中（sse_convert 已存在） | ~3700（25%） | 1200-1500 | **重写** | body 白名单/function 取值偏差 |
| trae Intl | ❌（双调用 chat_sessions/events 累积） | 大 | （含在上面） | 不建议重写 | **保留原 dll 或删变体** | 事件累积语义静默偏差 |
| qoder | ❌（COSY 签名+自定义 base64+信封） | 中（三件套小而确定） | ~3500（26%） | 2500-3000 | **裁剪式重写，或保留原 dll** | 搬运精度；桌面协议上游变动 |

**落地建议**：先重写 zcode（最便宜、最快验证干净形态流水线）；trae 只重写 CN 变体；qoder 视人力选"裁剪重写"或"原 dll 兜底"。cpa-multi-plugins 仓库在新方案中只留 `docs/PROTOCOL.md` 与 CI Release 产物地址。
