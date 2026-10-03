# dsh-cpa-panel — 维护索引

> 本文件是 agent 的自动注入入口：只装「每次开工都需要的状态」。
> 详细设计 → [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)｜进行中的计划 → [docs/PLAN.md](docs/PLAN.md)

## 全局规则

- 密钥只在宿主半端，**永不下发浏览器**；新增路由不得带密钥参数。见 [架构 §4.1](docs/ARCHITECTURE.md)。
- 改 `index.js` / `adapters.js` 后**必须重启 DSH**；`client.js` 刷新页面即可。
- 引用一律相对路径，禁写本机绝对路径（盘符、用户名目录）。
- 上游仓库引用按 SHA 钉住，不追 `main`。
- 同一事实只写一处，别处链接；可枚举实体（路由、文件）写「规则 + 去哪查」，不复制清单。
- 准备开工前先读 [docs/PLAN.md](docs/PLAN.md) §3 —— 有阻塞项未清时不要开始实施。

## 文档地图

| 想知道 | 去哪 |
|---|---|
| 怎么用、怎么装、配什么 | [README.md](README.md) |
| 为什么这样设计 | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| 下一步做什么、卡在哪 | [docs/PLAN.md](docs/PLAN.md) |
| 调研结论与源码锚点 | [调研报告归档/核心文档集/99-入口索引.md](调研报告归档/核心文档集/99-入口索引.md) |
| 调研档案（只读历史） | [调研报告归档/](调研报告归档/) |

## 常用命令

```powershell
git status --short --branch     # 本地 ↔ 远程同步状态
```

验证与门禁命令待 [PLAN §4](docs/PLAN.md) 补齐（`.node-version` / 锁文件 / lint / test 尚未就位）。

文档网络校验（维护工作流 skill 的配套脚本，位于 skill 目录下）：

```powershell
cd <skill 目录>   # maintenance-flow skill 所在目录
python check-markdown-links.py <本仓根> --fragments --refs
python check-line-endings.py <本仓根> --target lf
```

检查选择：文档 → 链接 + 行尾；配置 / 契约 → 相邻模块测试；代码 → 对应模块测试。

## 验证快照

- 无 CI（待建，见 [PLAN §4](docs/PLAN.md)）。
- 当前门禁：**无自动化测试**；`0.1.0` 为手工验收可用状态。
- 改动 `index.js` / `adapters.js` 后必须人工重启 DSH 复核，不要只看退出码。

## 待办

- [ ] 清 [PLAN §3](docs/PLAN.md) 阻塞项：方案甲拍板、后端小改授权、G1–G3 契约缺口。
- [ ] 本仓治理件：`.node-version` / 锁文件 / ESLint+Prettier / scripts / 钩子 / CI。
- [ ] **重新设计 `icon.svg`** —— 现图标质量不达标，需作为插件图标重做（见 PLAN §4）。
- [ ] `调研报告归档` 内 `12-实施就绪度审计报告.md` 加落地状态注记（其"未落地"判定已过时）。
- [ ] `providerId` 粒度裁决（按渠道 vs 每单元）。

## 活跃坑

- DSH 插件必须是 profile `node_modules/` 下的**真实目录**，不能 `link:` 到 profile 外 —— 否则 `@deepseek-ai/*` 解析失败，插件显示"未运行"。
- 插件 `inject` 漏列 `client.js` 实际 `require` 的包不会报错，只在运行时暴露。
- 停 CPA 不能依赖插件 shutdown 清理调度器 —— 会 SIGSEGV；走 shutdown 端点 → Ctrl-C → `taskkill /F`。
- 被限流的号 CPA 仍报 `status: active`（code 6004）：面板"启用" ≠ "现在能用"。
- `调研报告归档/` 是只读历史，不参与持续维护；其中的行号锚点随上游前移会失效。
