/**
 * dsh-cpa-panel —— 宿主半边。
 *
 * 三件事，按依赖顺序：
 *  1. **生命周期**：随 DSH 启停 CLIProxyAPI（复用已在跑的实例，退出时只关自己启的）。
 *  2. **开机补签**：CPA 就绪后，若今天还没签到就补一次。
 *  3. **HTTP 路由**：给浏览器半边供数 + 转发写操作（管理密钥**只留在这一侧**）。
 *
 * 设计约束（来自现场踩坑，见 README）：
 *  - 管理密钥能控制整个代理，绝不下发到浏览器；
 *  - 子进程必须清空 HTTP_PROXY 等变量，否则请求 127.0.0.1 会被系统代理拦成 502；
 *  - Windows 上子进程默认不随父进程退出，所以清理要显式 kill。
 * @module dsh-cpa-panel
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { createConnection } from 'node:net';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import z from '@deepseek-ai/schemastery';
import {
  ACTION_PATHS,
  AUTO_CHECKIN_PATHS,
  PLUGIN_ADAPTERS,
  PLUGIN_CONFIG_PATH,
  PLUGIN_ORDER,
  SCHEDULER_MODE,
  normalizeAccounts,
} from './adapters.js';
import { managedExePath } from './setup.js';

/** 本插件那一行的 Loader 条目 id —— 0.1.7 起它就是设置命名空间。 */
export const ENTRY_ID = 'dsh-cpa-panel';

/** loader 诊断用的插件名。 */
export const name = 'cpa-panel';

/**
 * 运行时服务门禁。
 *
 * `credentials`：读 `CPA_ADMIN_KEY` 凭据引用。
 * `connection` **不在这里**：缺了它只该丢掉 HTTP 半边，不该让生命周期一起消失，
 * 所以由 `apply` 内部的 `ctx.inject` 单独把门。
 */
export const inject = ['credentials'];

/**
 * 配置 schema。
 *
 * **全部字段 `.volatile()`**，两条理由缺一不可：
 * 1. 只有 volatile 字段进得了设置表单；漏一个，那个字段就在卡片里消失（不报错）。
 * 2. 写入路径按 volatile 逐路径放行，非 volatile 路径会被宿主直接拒掉。
 *
 * 副作用是好的：全字段 volatile ⇒ Loader 判「只有 volatile 变了」⇒ 改配置永不重挂，
 * `apply` 只跑一次，值一律现读。
 */
export const Config = z.object({
  adminKey: z.string().role('secret').default('').volatile(),
  adminKeyRef: z.string().role('credential-ref').default('CPA_ADMIN_KEY').volatile(),
  port: z.natural().min(1).max(65535).default(8317).volatile(),
  exePath: z.string().default('').volatile(),
  manageLifecycle: z.boolean().default(true).volatile(),
  autoCheckinOnStart: z.boolean().default(true).volatile(),
  /**
   * 是否让 CPA 在启动时自动打开浏览器指向它自带的管理控制台。
   *
   * 默认 **false**：本插件已经提供了面板，再弹一个浏览器标签页是纯噪音，
   * 而且每次 DSH 重启都会弹。置 true 则透传（不加 `-no-browser`）。
   */
  openControlPanel: z.boolean().default(false).volatile(),
  startTimeoutSeconds: z.natural().min(3).max(180).default(30).volatile(),
});

/** 默认端口。 */
const DEFAULT_PORT = 8317;

/**
 * CPA 可执行文件的候选位置，按顺序探测。
 *
 * 都是**相对用户主目录**的通用位置，不含任何开发者私有路径 ——
 * 这个文件是会公开的，写死本机路径既无用又泄漏信息。
 *
 * ⚠️ 光靠这份清单**不够**：用户可能把 CPA 装在任意位置。所以还有
 * `readExeMemory()` 记住"上次在哪找到的"，见 `resolveExe()`。
 * 曾经的教训：为了公开发布删掉一条私有路径，却没补上别的来源，
 * 结果插件找不到 exe、启不动 CPA，用户的服务直接断了。
 */
function defaultExeCandidates() {
  const home = homedir();
  return [
    // 由本插件「环境准备」下载并管理的副本
    managedExePath(),
    join(home, 'CLIProxyAPI', 'cli-proxy-api.exe'),
    join(home, 'Desktop', 'CLIProxyAPI', 'cli-proxy-api.exe'),
    join(home, 'cpa', 'cli-proxy-api.exe'),
    // 非 Windows 平台的可执行文件名
    join(home, 'CLIProxyAPI', 'cli-proxy-api'),
    join(home, 'Desktop', 'CLIProxyAPI', 'cli-proxy-api'),
  ];
}

/**
 * 「上次在哪找到 CPA」的落地文件。
 *
 * 用户可能把 CPA 装在任意目录（项目目录、别的盘……），静态候选清单
 * 覆盖不到。所以**第一次成功解析后就把路径记下来**，以后优先用它 ——
 * 这样换位置也不用重新配，更不会因为清单改动而突然找不到。
 */
function exeMemoryPath() {
  return join(homedir(), '.dsh', 'storages', 'cpa-panel-exe.json');
}

/** 读「上次找到的 CPA 路径」；损坏或不存在返回空串。 */
function readExeMemory() {
  try {
    const parsed = JSON.parse(readFileSync(exeMemoryPath(), 'utf8'));
    const path = typeof parsed?.path === 'string' ? parsed.path : '';
    return existsSync(path) ? path : '';
  } catch {
    return '';
  }
}

/** 记住这次找到的路径；失败不致命。 */
function writeExeMemory(path) {
  try {
    const p = exeMemoryPath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ path, at: new Date().toISOString() }, null, 2), 'utf8');
  } catch {
    /* 记不住只影响下次启动的快慢，不该打断本次启动 */
  }
}

/** 补签记录的落地文件（放 DSH home 下）。 */
function checkinStampPath() {
  return join(homedir(), '.dsh', 'storages', 'cpa-panel-checkin.json');
}

/** 读补签记录；损坏就当空。 */
function readStamp() {
  try {
    const raw = readFileSync(checkinStampPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

/** 写补签记录；失败不致命。 */
function writeStamp(value) {
  try {
    const p = checkinStampPath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(value, null, 2), 'utf8');
  } catch {
    /* 记录失败只影响补签判定，不该打断主流程 */
  }
}

/**
 * 「用户选择」的落地文件。
 *
 * 记的是**用户通过面板做出的启用/禁用决定**，而不是某时刻的实际状态 ——
 * 这样重启后可以按用户的意图恢复，而不是被别的东西改过的状态带跑。
 *
 * 与补签记录分开存放：两者生命周期不同（补签按天重置，意图长期有效）。
 */
function accountIntentPath() {
  return join(homedir(), '.dsh', 'storages', 'cpa-panel-accounts.json');
}

/** 读用户意图；损坏就当没有。 */
function readAccountIntent() {
  try {
    const raw = readFileSync(accountIntentPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    return typeof parsed.enabled === 'object' && parsed.enabled !== null ? parsed : { enabled: {} };
  } catch {
    return { enabled: {} };
  }
}

/** 写用户意图；失败不致命。 */
function writeAccountIntent(value) {
  try {
    const p = accountIntentPath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(value, null, 2), 'utf8');
  } catch {
    /* 写不进去只影响"重启后恢复"，不该打断用户当前操作 */
  }
}

/** 本地日期串 YYYY-MM-DD。 */
function localDay() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${String(d.getFullYear())}-${m}-${day}`;
}

/** 探测端口是否在监听。 */
function probePort(port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/** 等待端口就绪。 */
async function waitForPort(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probePort(port)) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 400));
  }
}

/**
 * 调用 CPA 管理接口。
 *
 * **一切对 CPA 的写操作都从这里走**，浏览器永远拿不到管理密钥。
 * @param options - 连接参数。
 * @param path - 形如 `/v0/management/plugins/workbuddy/accounts` 的路径。
 * @param init - fetch 选项。
 * @returns 解析后的 JSON，或抛错。
 */
async function cpaFetch(options, path, init = {}) {
  const url = `http://127.0.0.1:${String(options.port)}${path}`;
  const headers = {
    authorization: `Bearer ${options.adminKey}`,
    ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    ...(init.headers ?? {}),
  };
  const response = await fetch(url, {
    ...init,
    headers,
    signal: AbortSignal.timeout(options.timeoutMs ?? 20000),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = text === '' ? {} : JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  if (!response.ok) {
    const message = parsed?.error ?? parsed?.message ?? `HTTP ${String(response.status)}`;
    const error = new Error(typeof message === 'string' ? message : JSON.stringify(message));
    error.status = response.status;
    throw error;
  }
  return parsed;
}

/** 统一的 JSON 响应。 */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/**
 * 组装并交出生命周期。
 * @param ctx - 宿主上下文。
 * @param refs - `apply` 收到的配置引用面。
 */
export async function apply(ctx, refs) {
  /**
   * 现读配置。
   *
   * **不许把它缓存进字段**：全字段 volatile ⇒ Loader 改值不重挂本插件，
   * 所以 `apply` 只跑一次，而值随时可能变。
   * @returns 当前生效的纯值配置。
   */
  const readConfig = () => ({
    adminKey: refs.adminKey.get(),
    adminKeyRef: refs.adminKeyRef.get(),
    port: refs.port.get(),
    exePath: refs.exePath.get(),
    manageLifecycle: refs.manageLifecycle.get(),
    autoCheckinOnStart: refs.autoCheckinOnStart.get(),
    openControlPanel: refs.openControlPanel.get(),
    startTimeoutSeconds: refs.startTimeoutSeconds.get(),
  });

  /**
   * 解析管理密钥。
   *
   * 优先级：显式配置 > 凭据引用 > 空。空密钥时所有写操作都会 401，
   * 所以补签与面板都会明确报「未配置」，而不是静默失败。
   */
  const resolveAdminKey = async () => {
    const config = readConfig();
    if (config.adminKey !== '') return { value: config.adminKey, source: 'config' };
    const ref = config.adminKeyRef.trim();
    if (ref === '') return { value: '', source: 'unset' };
    try {
      const resolved = await ctx.credentials.resolve(credentialRef(ref));
      if (resolved === undefined || resolved.value === '') return { value: '', source: 'unset' };
      return { value: resolved.value, source: resolved.source };
    } catch {
      return { value: '', source: 'unset' };
    }
  };

  // 密钥在启动时解析一次留作缓存；凭据轮换会在下一次 apply/重启生效。
  let cachedAdminKey = await resolveAdminKey();

  const options = () => ({
    port: readConfig().port,
    adminKey: cachedAdminKey.value,
    timeoutMs: 20000,
  });

  /** 生命周期句柄：记住这个实例是不是我们启的。 */
  const life = {
    child: undefined,
    owned: false,
    starting: false,
  };

  /**
   * 解析可执行文件路径，优先级：
   *  1. 用户显式配置的 `exePath`（最高，用户说了算）
   *  2. **上次成功找到的路径**（跨重启记忆，静态清单覆盖不到的装法靠它）
   *  3. 内置候选清单（含插件自己下载管理的那份）
   *
   * 找到后立刻记下来，下次启动直接从第 2 步命中。
   */
  const resolveExe = () => {
    const configured = readConfig().exePath.trim();
    if (configured !== '' && existsSync(configured)) {
      writeExeMemory(configured);
      return configured;
    }
    const remembered = readExeMemory();
    if (remembered !== '') return remembered;
    for (const candidate of defaultExeCandidates()) {
      if (existsSync(candidate)) {
        writeExeMemory(candidate);
        return candidate;
      }
    }
    return '';
  };

  /** 确保 CPA 在跑；返回是否可用。 */
  const ensureRunning = async () => {
    const config = readConfig();
    if (await probePort(config.port)) return { running: true, owned: life.owned };
    if (!config.manageLifecycle) return { running: false, owned: false, reason: 'lifecycle-disabled' };
    if (life.starting) {
      const ok = await waitForPort(config.port, config.startTimeoutSeconds * 1000);
      return { running: ok, owned: life.owned };
    }
    const exe = resolveExe();
    if (exe === '') return { running: false, owned: false, reason: 'exe-not-found' };
    life.starting = true;
    try {
      // 清空代理变量：否则子进程请求 127.0.0.1 会被系统代理拦成 502。
      const env = { ...process.env };
      for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
        delete env[key];
      }
      /**
       * 启动参数。
       *
       * ⚠️ **必须带 `-no-browser`**：CPA 默认会在启动时自动打开浏览器指向
       * 管理控制台（`http://127.0.0.1:<port>/management.html`，见 `--help` 的
       * `-no-browser` 说明："OAuth flows and the management control panel"）。
       * 由本插件拉起时，用户已经在 DSH 面板里操作了，再弹一个浏览器标签页
       * 是纯噪音 —— 而且每次 DSH 重启都会弹一次。
       */
      const args = ['--config', 'config.yaml'];
      if (config.openControlPanel !== true) args.push('-no-browser');
      const child = spawn(exe, args, {
        cwd: dirname(exe),
        env,
        detached: false,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref?.();
      life.child = child;
      life.owned = true;
      const ok = await waitForPort(config.port, config.startTimeoutSeconds * 1000);
      return { running: ok, owned: true, reason: ok ? undefined : 'start-timeout' };
    } finally {
      life.starting = false;
    }
  };

  /** 只关自己启的那个。 */
  const stopIfOwned = () => {
    if (!life.owned || life.child === undefined) return;
    try {
      life.child.kill();
    } catch {
      /* 进程可能已经没了 */
    }
    life.child = undefined;
    life.owned = false;
  };

  /**
   * 开机补签。
   *
   * CPA 自带的自动签到是 09:00 / 21:00 两次定时；DSH 没开时那两次会漏掉。
   * 这里在启动时补一次，**对所有支持签到的插件都补**（不只 workbuddy）。
   *
   * 每个插件当天只补一次，记录写在 `$DSH_HOME/storages/cpa-panel-checkin.json`。
   */
  const runStartupCheckin = async () => {
    if (!readConfig().autoCheckinOnStart) return { skipped: 'disabled' };
    const day = localDay();
    const stamp = readStamp();
    const done = { ...(stamp.startupCheckinDays ?? {}) };
    /** 今天还没补过、且插件支持签到的。 */
    const pending = PLUGIN_ORDER.filter(
      (plugin) => PLUGIN_ADAPTERS[plugin].capabilities.checkin && done[plugin] !== day,
    );
    if (pending.length === 0) return { skipped: 'already-done-today' };

    const state = await ensureRunning();
    if (!state.running) return { skipped: 'cpa-unavailable' };
    if (cachedAdminKey.value === '') return { skipped: 'no-admin-key' };

    const results = {};
    for (const plugin of pending) {
      const path = ACTION_PATHS[plugin]?.checkin;
      if (path === undefined) continue;
      try {
        const result = await cpaFetch(options(), path, { method: 'POST', body: '{}' });
        results[plugin] = result?.summary ?? 'ok';
        done[plugin] = day;
      } catch (error) {
        // 单个插件失败不影响其它插件，也不记 stamp（下次启动会重试）
        results[plugin] = 'error: ' + (error instanceof Error ? error.message : String(error));
      }
    }
    writeStamp({
      ...readStamp(),
      startupCheckinDays: done,
      startupCheckinAt: new Date().toISOString(),
    });
    return { checkedIn: true, results };
  };

      /**
       * 按「用户上次的选择」恢复账号启用状态。
       *
       * ⚠️ 这个函数必须定义在 **`ctx.effect` 之外**（和 `runStartupCheckin` 同层）：
       * 启动流程在 `ctx.effect` 里调用它，而 `ctx.inject([...])` 回调里的
       * 同名定义是**另一个作用域**，外层看不见 —— 会报
       * `restoreAccountIntent is not defined`（运行时才暴露，`node --check` 查不出）。
       *
       * 为什么需要它：CPA 的 `disabled` 本身能跨重启保留，但**别的操作**可能
       * 改到它（用户自己在 CPA 控制台里点、或某个脚本探测后没还原）。
       * 用户明确要求"我手动开哪个就只用哪个，重启 DSH 也不能变"，
       * 所以启动时把记录过的意图**重新应用**一次。
       *
       * 只认**记录过的**账号：没记录过的一律不动 —— 新加入的号不该被
       * 这个机制擅自禁用。
       */
      const restoreAccountIntent = async () => {
        const intent = readAccountIntent();
        const wanted = Object.entries(intent.enabled ?? {});
        if (wanted.length === 0) return { skipped: 'no-intent' };

        const running = await ensureRunning();
        if (!running.running) return { skipped: 'cpa-unavailable' };
        if (cachedAdminKey.value === '') return { skipped: 'no-admin-key' };

        try {
          const data = await cpaFetch(options(), '/v0/management/auth-files');
          const byName = new Map(
            (Array.isArray(data?.files) ? data.files : []).map((file) => [String(file.name), file]),
          );
          const fixed = [];
          for (const [name, shouldEnable] of wanted) {
            const file = byName.get(name);
            if (file === undefined) continue; // 凭据已被删除，跳过
            const currentlyDisabled = file.disabled === true;
            if (currentlyDisabled === !shouldEnable) continue; // 已经一致
            await cpaFetch(options(), '/v0/management/auth-files/status', {
              method: 'PATCH',
              body: JSON.stringify({ name, disabled: shouldEnable !== true }),
            });
            fixed.push({ name, enabled: shouldEnable === true });
          }
          return { restored: fixed };
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) };
        }
      };

  // ── 生命周期 effect ────────────────────────────────────────────────────
  ctx.effect(() => {
    let stopped = false;
    const boot = async () => {
      const state = await ensureRunning();
      if (stopped) return;
      if (state.running) {
        /**
         * 先恢复「用户上次的选择」，再补签。
         *
         * 顺序有讲究：恢复要在补签之前 —— 补签是按渠道整体调的，
         * 与具体账号无关；但先恢复能让日志反映真实的调度面。
         */
        const restored = await restoreAccountIntent();
        ctx.logger?.info?.('cpa-panel: restore account intent %o', restored);
        const result = await runStartupCheckin();
        ctx.logger?.info?.('cpa-panel: startup checkin %o', result);
      } else {
        ctx.logger?.warn?.('cpa-panel: CPA unavailable at startup (%s)', state.reason ?? 'unknown');
      }
    };
    void boot();
    return () => {
      stopped = true;
      stopIfOwned();
    };
  }, 'cpa-panel: lifecycle');

  // ── HTTP 路由 ──────────────────────────────────────────────────────────
  ctx.inject(['connection'], (connectionCtx) => {
    connectionCtx.effect(() => {
      /**
       * 取某个插件的账号列表（已按统一形状归一化）。
       *
       * 只打两次请求：`/accounts` 拿名单、`/credits` 拿余额（**不带 auth_index
       * 时一次返回全部**），再按 auth_index 合并。
       *
       * ⚠️ `/accounts` 返回的账号对象**不含余额**（`credits` 是 null），
       * 必须走 `/credits`。各插件的返回结构不同，差异由 adapters.js 吸收。
       */
      const accountsOf = async (plugin) => {
        const adapter = PLUGIN_ADAPTERS[plugin];
        if (adapter === undefined) return { ok: false, error: 'unknown-plugin' };
        const state = await ensureRunning();
        if (!state.running) return { ok: false, error: 'cpa-unavailable', reason: state.reason };
        try {
          const accountsPath = `/v0/management/plugins/${plugin}/accounts`;
          const [base, creditData] = await Promise.all([
            cpaFetch(options(), accountsPath),
            adapter.capabilities.credits
              ? cpaFetch(options(), adapter.creditsPath()).catch(() => undefined)
              : Promise.resolve(undefined),
          ]);
          const normalized = normalizeAccounts(plugin, base, creditData);
          // 顺带算出"真实在用"的号（只看只读的 auth-files，不发任何上游请求）
          const active = await activeAuthOf(plugin, normalized);
          return {
            ok: true,
            data: {
              plugin,
              label: adapter.label,
              unit: adapter.unit,
              capabilities: adapter.capabilities,
              // 顶层元信息（各插件给的不一样，有就带上）
              serverTime: base?.server_time,
              schedule: base?.schedule,
              autoCheckin: base?.checkin_auto,
              accounts: normalized,
              /**
               * 真实正在被调度的账号（来自 auth-files 的请求统计），
               * 与账号自身的 `selected`（插件记的"选用"）**可能不一致** ——
               * 以后者为准会显示错，界面要用这个。
               */
              active: active.ok === true ? { authId: active.activeAuthId, nickname: active.activeNickname, since: active.since } : null,
            },
          };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      };

      /** 写操作统一入口：按插件查白名单路径 + 可选 auth_index。 */
      const action = async (plugin, kind, authIndex) => {
        const adapter = PLUGIN_ADAPTERS[plugin];
        if (adapter === undefined) return { ok: false, error: 'unknown-plugin' };
        const path = ACTION_PATHS[plugin]?.[kind];
        if (path === undefined) return { ok: false, error: 'unsupported-action' };
        const state = await ensureRunning();
        if (!state.running) return { ok: false, error: 'cpa-unavailable', reason: state.reason };
        if (cachedAdminKey.value === '') return { ok: false, error: 'no-admin-key' };
        const body =
          authIndex === undefined || authIndex === ''
            ? '{}'
            : JSON.stringify({ auth_index: authIndex });
        try {
          const data = await cpaFetch(options(), path, { method: 'POST', body });
          return { ok: true, data };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      };

      /**
       * 检测**真实正在被使用**的账号。
       *
       * 为什么不直接用插件给的 `selected`：
       *  插件面板里的「选用」是它自己记的"首选"，**不等于实际调度结果**。
       *  真正决定用哪个号的是 CPA 的调度器（`routing.strategy` + auth 文件的 `priority`），
       *  两者会不一致 —— 面板显示"陈盛泷使用中"，实际扣的却是 cherry 的分。
       *
       * 数据来源：`/v0/management/auth-files` 的每个凭据带
       * `recent_requests`（10 分钟一格的 success/failed）与累计 `success`/`failed`。
       * 凭据的 `name` 与插件账号的 `auth_id` 逐字对应。
       *
       * 判定：取**最近一个有请求的时段**，成功数最高的那个号就是"在用"的。
       * 全部为 0 时返回 null（还没用过，不猜）。
       */
      const activeAuthOf = async (plugin, accounts) => {
        try {
          const data = await cpaFetch(options(), '/v0/management/auth-files');
          const files = Array.isArray(data?.files) ? data.files : [];

          /** auth_id → 凭据。 */
          const byName = new Map();
          for (const file of files) {
            if (file?.provider !== plugin) continue;
            byName.set(String(file.name), file);
          }

          /** 汇总每张时段表的最近活动。 */
          const lastActive = (file) => {
            const buckets = Array.isArray(file?.recent_requests) ? file.recent_requests : [];
            for (let i = buckets.length - 1; i >= 0; i -= 1) {
              const bucket = buckets[i];
              const success = Number(bucket?.success ?? 0);
              const failed = Number(bucket?.failed ?? 0);
              if (success + failed > 0) {
                return { time: bucket?.time ?? '', success, failed };
              }
            }
            return undefined;
          };

          /**
           * 选"在用"的号：时段越新越优先；同一时段成功数多者胜。
           * 全部没有任何请求时返回 undefined（不猜）。
           */
          let winner;
          const rows = [];
          for (const account of accounts) {
            const file = byName.get(String(account.authId));
            const last = file === undefined ? undefined : lastActive(file);
            rows.push({
              authId: account.authId,
              nickname: account.nickname,
              last: last ?? null,
              totalSuccess: Number(file?.success ?? 0),
            });
            if (last === undefined) continue;
            if (
              winner === undefined ||
              last.time > winner.last.time ||
              (last.time === winner.last.time && last.success > winner.last.success)
            ) {
              winner = { authId: account.authId, nickname: account.nickname, last };
            }
          }

          if (winner === undefined) {
            return { ok: true, activeAuthId: null, activeNickname: null, since: null, rows };
          }
          return {
            ok: true,
            activeAuthId: winner.authId,
            activeNickname: winner.nickname,
            since: winner.last.time,
            rows,
          };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      };

      /** 读 + 写自动签到开关（只有部分插件支持）。 */
      const autoCheckin = async (plugin, method, enabled) => {
        const paths = AUTO_CHECKIN_PATHS[plugin];
        if (paths === undefined) return { ok: false, error: 'unsupported' };
        const state = await ensureRunning();
        if (!state.running) return { ok: false, error: 'cpa-unavailable' };
        try {
          if (method === 'GET') {
            // ⚠️ 从 `/accounts` 顶层读，不是 `/config` —— 详见 adapters.js 的注释
            const accountsData = await cpaFetch(options(), paths.readFrom);
            return { ok: true, enabled: accountsData?.[paths.field] === true };
          }
          if (cachedAdminKey.value === '') return { ok: false, error: 'no-admin-key' };
          // ⚠️ PATCH + 字段名 `checkin_auto`（不是 POST `{enabled}` 到 /checkin/config —— 那路径 404）
          await cpaFetch(options(), paths.write, {
            method: 'PATCH',
            body: JSON.stringify({ [paths.field]: enabled }),
          });
          // 写接口回的不一定可靠，回读一次更稳
          const after = await cpaFetch(options(), paths.readFrom).catch(() => undefined);
          return { ok: true, enabled: after?.[paths.field] === true };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      };

      /** 读某个插件的模型目录（只读，用于展示）。 */
      const modelsOf = async (plugin) => {
        const state = await ensureRunning();
        if (!state.running) return { ok: false, error: 'cpa-unavailable' };
        // zcode 用 /models，其余用 /models/groups。
        // ⚠️ 必须带 `?refresh=1`：不带时读内存快照，未预热会返回空列表。
        const path =
          plugin === 'zcode'
            ? '/v0/management/plugins/zcode/models'
            : `/v0/management/plugins/${plugin}/models/groups?refresh=1`;
        try {
          const data = await cpaFetch(options(), path);
          const groups = Array.isArray(data?.groups) ? data.groups : [];
          return {
            ok: true,
            groups: groups.map((group) => ({
              label: group.label,
              count: Number(group.count ?? (group.models ?? []).length),
              models: (group.models ?? []).map((model) => ({
                id: model.id,
                name: model.name,
              })),
            })),
          };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      };

      /** 开学季券码状态（只有 workbuddy 有）。 */
      const school = async () => {
        const state = await ensureRunning();
        if (!state.running) return { ok: false, error: 'cpa-unavailable' };
        try {
          const data = await cpaFetch(options(), '/v0/management/plugins/workbuddy/school/vouchers');
          return { ok: true, accounts: data?.accounts ?? [] };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      };

      /**
       * 读路由策略。
       *
       * CPA 有现成接口 `GET /v0/management/routing/strategy`，返回 `{strategy}`。
       * 取值为 round-robin / weighted-round-robin / fill-first。
       */
      const routingGet = async () => {
        const state = await ensureRunning();
        if (!state.running) return { ok: false, error: 'cpa-unavailable' };
        try {
          const data = await cpaFetch(options(), '/v0/management/routing/strategy');
          /**
           * 同时读各插件的 `scheduler_mode`。
           *
           * ⚠️ 这个值决定 `priority` 到底有没有用：
           *  - `off`     → 内置调度器接管，`fill-first` + `priority` 生效
           *  - `credits` → **插件自己选号**（挑剩余额度最多的），`priority` 形同虚设
           * 只要有一个渠道是 `credits`，那个渠道的账号顺序就完全不受控。
           */
          const schedulerModes = {};
          for (const plugin of PLUGIN_ORDER) {
            try {
              const cfg = await cpaFetch(options(), PLUGIN_CONFIG_PATH(plugin));
              schedulerModes[plugin] = cfg?.scheduler_mode ?? null;
            } catch {
              schedulerModes[plugin] = null;
            }
          }
          return { ok: true, strategy: data?.strategy, schedulerModes };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      };

      /**
       * 把所有渠道的 `scheduler_mode` 设为 `off`，让账号优先级真正生效。
       *
       * 为什么需要这个动作：插件默认（或曾被设成）`credits`，
       * 那时它自己按"剩余额度最多"选号，**完全无视 priority** ——
       * 表现为"优先级设了却不变"。
       *
       * ⚠️ 改完**必须重启 CPA** 才生效（配置不热加载）。
       */
      const schedulerModeNormalize = async () => {
        const state = await ensureRunning();
        if (!state.running) return { ok: false, error: 'cpa-unavailable' };
        if (cachedAdminKey.value === '') return { ok: false, error: 'no-admin-key' };
        try {
          const changed = [];
          const skipped = [];
          for (const plugin of PLUGIN_ORDER) {
            const cfg = await cpaFetch(options(), PLUGIN_CONFIG_PATH(plugin)).catch(() => undefined);
            // 插件不支持这个字段就不动它（trae 就没有）
            if (cfg === undefined || cfg.scheduler_mode === undefined) {
              skipped.push(plugin);
              continue;
            }
            if (cfg.scheduler_mode === SCHEDULER_MODE) continue;
            await cpaFetch(options(), PLUGIN_CONFIG_PATH(plugin), {
              method: 'PATCH',
              body: JSON.stringify({ scheduler_mode: SCHEDULER_MODE }),
            });
            changed.push(plugin);
          }
          return { ok: true, changed, skipped, restartRequired: changed.length > 0 };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      };

      /**
       * 写路由策略。
       *
       * 实测形状：`PUT /v0/management/routing/strategy`，body `{"value":"fill-first"}`，
       * 返回 `{"status":"ok"}`。
       *
       * 为什么要暴露这个：
       *  - `round-robin` 每个请求换凭据 → 上游 Prompt/KV 缓存**几乎不命中**
       *  - `fill-first` 用满一个再用下一个 → 缓存留在同一账号上，命中率高、省积分
       */
      const routingSet = async (strategy) => {
        const allowed = ['round-robin', 'weighted-round-robin', 'fill-first'];
        if (!allowed.includes(strategy)) return { ok: false, error: 'invalid-strategy' };
        const state = await ensureRunning();
        if (!state.running) return { ok: false, error: 'cpa-unavailable' };
        if (cachedAdminKey.value === '') return { ok: false, error: 'no-admin-key' };
        try {
          await cpaFetch(options(), '/v0/management/routing/strategy', {
            method: 'PUT',
            body: JSON.stringify({ value: strategy }),
          });
          const data = await cpaFetch(options(), '/v0/management/routing/strategy');
          return { ok: true, strategy: data?.strategy };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      };

      /**
       * 读某插件各账号的优先级。
       *
       * ⚠️ 从 `/v0/management/auth-files` 读，**不读文件**：
       *  文件里的 `priority` 与**调度器实际采纳的值**可能不一致 ——
       *  直接改文件不会更新 `auth.Attributes["priority"]`，调度器读不到。
       *
       * ⚠️ 昵称**不在** `/auth-files` 里（它的 `label` 是 `workbuddy` 或
       *  `房产cherry（萍） [CN]` 这种，不可靠）。昵称只有一个来源：
       *  插件自己的 `/accounts`，用 `auth_id` 与 `/auth-files` 的 `name` 关联。
       *
       * 数值越大越优先；同值时按 ID 确定性顺序。
       */
      const priorityGet = async (plugin) => {
        try {
          const [filesData, accountsData] = await Promise.all([
            cpaFetch(options(), '/v0/management/auth-files'),
            cpaFetch(options(), `/v0/management/plugins/${plugin}/accounts`).catch(() => undefined),
          ]);
          /** auth_id → 昵称。 */
          const nicknameById = new Map();
          for (const account of accountsData?.accounts ?? []) {
            if (account?.auth_id) nicknameById.set(String(account.auth_id), account.nickname);
          }
          const items = (Array.isArray(filesData?.files) ? filesData.files : [])
            .filter((file) => file?.provider === plugin)
            .map((file) => ({
              file: file.name,
              nickname:
                nicknameById.get(String(file.name)) ?? String(file.name).replace(/\.json$/u, ''),
              priority: Number(file.priority ?? 0),
              disabled: file.disabled === true,
            }))
            .sort((a, b) => b.priority - a.priority);
          return { ok: true, items };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      };

      /**
       * 写账号优先级。
       *
       * `order` 是**从高到低**的昵称数组：第 0 个 priority 最高。
       * 基数 100、步长 10，留出插空余地。
       *
       * ⚠️ **必须走 `PATCH /v0/management/auth-files/fields`，不能直接改 JSON 文件！**
       *
       *   调度器读的是 `auth.Attributes["priority"]`，它由
       *   `syncAuthFilePriorityAttribute()` 从 `auth.Metadata["priority"]` 同步而来。
       *   只改文件的 `priority` 字段，接口能显示出来（因为它读文件），
       *   但**调度器手里还是 0** —— 表现为"设了优先级却完全不生效、请求乱挑账号"。
       *   这个坑排查了很久，别再踩。
       */
      const prioritySet = async (plugin, order) => {
        if (!Array.isArray(order) || order.length === 0) return { ok: false, error: 'empty-order' };
        try {
          const [filesData, accountsData] = await Promise.all([
            cpaFetch(options(), '/v0/management/auth-files'),
            cpaFetch(options(), `/v0/management/plugins/${plugin}/accounts`).catch(() => undefined),
          ]);
          /** auth_id → 昵称（昵称只能从插件接口拿，`/auth-files` 的 label 不可靠）。 */
          const nicknameById = new Map();
          for (const account of accountsData?.accounts ?? []) {
            if (account?.auth_id) nicknameById.set(String(account.auth_id), account.nickname);
          }
          const files = (Array.isArray(filesData?.files) ? filesData.files : []).filter(
            (file) => file?.provider === plugin,
          );
          const BASE = 100;
          const STEP = 10;
          const rank = new Map(order.map((nickname, index) => [nickname, BASE - index * STEP]));
          const changed = [];
          for (const file of files) {
            const nickname =
              nicknameById.get(String(file.name)) ?? String(file.name).replace(/\.json$/u, '');
            const next = rank.get(nickname);
            if (next === undefined) continue;
            if (Number(file.priority ?? 0) === next) continue;
            await cpaFetch(options(), '/v0/management/auth-files/fields', {
              method: 'PATCH',
              body: JSON.stringify({ name: file.name, priority: next }),
            });
            changed.push({ nickname, priority: next });
          }
          return { ok: true, changed };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      };

      /**
       * 启用 / 禁用某个账号。
       *
       * 为什么需要它：**这是"只有一个账号消耗"的唯一可靠手段**。
       *  - `priority` 只是"尽量先用高的" —— 高的不可用时照样降级到别人；
       *  - `fill-first` 取的是"第一个**可用**凭据" —— 首选号一旦瞬时冷却就切走；
       *  - 只有 `disabled` 是"根本不参与"，没有降级空间。
       *
       * 什么时候需要多个号同时启用：不需要。用户明确要求"只用一个号、
       * 手动切换、不要兜底" —— 所以禁用后请求宁可失败也不自动切号。
       *
       * ⚠️ 走 `PATCH /v0/management/auth-files/status`，body `{name, disabled}`。
       *    实测禁用是持久的（CPA 不会自动恢复）。
       */
      const accountEnabled = async (plugin, authIndex, enabled) => {
        const state = await ensureRunning();
        if (!state.running) return { ok: false, error: 'cpa-unavailable' };
        if (cachedAdminKey.value === '') return { ok: false, error: 'no-admin-key' };
        try {
          const data = await cpaFetch(options(), '/v0/management/auth-files');
          const files = (Array.isArray(data?.files) ? data.files : []).filter(
            (file) => file?.provider === plugin,
          );
          const target = files.find((file) => String(file.auth_index) === String(authIndex));
          if (target === undefined) return { ok: false, error: 'auth-not-found' };
          await cpaFetch(options(), '/v0/management/auth-files/status', {
            method: 'PATCH',
            body: JSON.stringify({ name: target.name, disabled: enabled !== true }),
          });
          /**
           * 记下用户的决定，供下次启动恢复。
           *
           * 只有**用户主动点击**才会走到这里 —— 所以这是"用户意图"，
           * 不是"某时刻的状态"。启动时按它恢复，就不会被别的东西改跑偏。
           */
          const intent = readAccountIntent();
          intent.enabled[target.name] = enabled === true;
          intent.updatedAt = new Date().toISOString();
          writeAccountIntent(intent);
          return { ok: true, name: target.name, disabled: enabled !== true };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      };

      /**
       * 「选择」某个账号：启用它，并**禁用同一渠道的其余所有账号**。
       *
       * 这是用户要的语义 —— "我选哪个就只用哪个"。一次调用把整个渠道
       * 收敛到单账号，不用逐个点禁用。
       *
       * ⚠️ **只影响同一个渠道**：四个渠道各自独立，选 workbuddy 的号
       * 不会动 trae/qoder/zcode 的选择。
       *
       * 每条变更都写进用户意图，所以重启后会按这次的选择恢复。
       */
      const accountSelect = async (plugin, authIndex) => {
        const state = await ensureRunning();
        if (!state.running) return { ok: false, error: 'cpa-unavailable' };
        if (cachedAdminKey.value === '') return { ok: false, error: 'no-admin-key' };
        try {
          const data = await cpaFetch(options(), '/v0/management/auth-files');
          const files = (Array.isArray(data?.files) ? data.files : []).filter(
            (file) => file?.provider === plugin,
          );
          const target = files.find((file) => String(file.auth_index) === String(authIndex));
          if (target === undefined) return { ok: false, error: 'auth-not-found' };

          /** 要和目标一致的账号不动，其余的全部收敛。 */
          const intent = readAccountIntent();
          const changed = [];
          for (const file of files) {
            const shouldEnable = file.name === target.name;
            if (file.disabled === !shouldEnable) {
              /* 状态已经对了，跳过这次请求 */
              intent.enabled[file.name] = shouldEnable;
              continue;
            }
            await cpaFetch(options(), '/v0/management/auth-files/status', {
              method: 'PATCH',
              body: JSON.stringify({ name: file.name, disabled: shouldEnable !== true }),
            });
            intent.enabled[file.name] = shouldEnable;
            changed.push({ name: file.name, enabled: shouldEnable });
          }
          intent.updatedAt = new Date().toISOString();
          writeAccountIntent(intent);
          return { ok: true, name: target.name, changed };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      };

      /**
       * 起一次渠道登录。
       *
       * 走 CPA 的 **v8** OAuth 接口（注意是 `/v8/`，不是 `/v0/`）。
       * 返回上游授权页地址，用户在浏览器里完成授权后 CPA 会自动保存认证文件。
       *
       * 实测：
       *   GET /v8/management/oauth/auth-url?provider=workbuddy
       *   → {state, status:"ok", url:"https://copilot.tencent.com/login?..."}
       */
      const authStart = async (plugin) => {
        const state = await ensureRunning();
        if (!state.running) return { ok: false, error: 'cpa-unavailable' };
        if (cachedAdminKey.value === '') return { ok: false, error: 'no-admin-key' };
        if (!PLUGIN_ORDER.includes(plugin)) return { ok: false, error: 'unknown-provider' };
        try {
          const data = await cpaFetch(
            options(),
            `/v8/management/oauth/auth-url?provider=${encodeURIComponent(plugin)}`,
          );
          if (typeof data?.url !== 'string' || data.url === '') {
            return { ok: false, error: data?.error ?? 'no-auth-url' };
          }
          return { ok: true, state: data.state, url: data.url };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      };

      /**
       * 查一次登录状态。
       *
       * ⚠️ **必须带 `state`**：不带时接口返回 `{"status":"ok"}` 这种无意义的值
       * （实测），带 `state` 才返回真实进度。
       *
       * 实测取值：
       *   `wait`  —— 等待授权中
       *   （成功后 CPA 自动写入 auth 文件；取消后返回 `unknown or expired state`）
       */
      const authStatus = async (state) => {
        if (typeof state !== 'string' || state === '') return { ok: false, error: 'missing-state' };
        const running = await ensureRunning();
        if (!running.running) return { ok: false, error: 'cpa-unavailable' };
        try {
          const data = await cpaFetch(
            options(),
            `/v8/management/oauth/status?state=${encodeURIComponent(state)}`,
          );
          return { ok: true, status: data?.status ?? 'unknown', raw: data };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      };

      /** 取消一次登录会话（用户关掉弹窗时调）。 */
      const authCancel = async (state) => {
        if (typeof state !== 'string' || state === '') return { ok: false, error: 'missing-state' };
        const running = await ensureRunning();
        if (!running.running) return { ok: false, error: 'cpa-unavailable' };
        try {
          const data = await cpaFetch(
            options(),
            `/v8/management/oauth/session?state=${encodeURIComponent(state)}`,
            { method: 'DELETE' },
          );
          return { ok: true, cancelled: data?.cancelled === true };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      };

      const routes = [
        {
          path: '/api/v1/cpa/status',
          methods: ['GET'],
          handle: async () => {
            const config = readConfig();
            const running = await probePort(config.port);
            return json({
              running,
              owned: life.owned,
              port: config.port,
              hasAdminKey: cachedAdminKey.value !== '',
              adminKeySource: cachedAdminKey.source,
              exePath: resolveExe(),
              manageLifecycle: config.manageLifecycle,
              autoCheckinOnStart: config.autoCheckinOnStart,
              openControlPanel: config.openControlPanel,
            });
          },
        },
        {
          path: '/api/v1/cpa/plugins',
          methods: ['GET'],
          handle: async () =>
            json({
              ok: true,
              order: PLUGIN_ORDER,
              plugins: PLUGIN_ORDER.map((id) => ({
                id,
                label: PLUGIN_ADAPTERS[id].label,
                unit: PLUGIN_ADAPTERS[id].unit,
                capabilities: PLUGIN_ADAPTERS[id].capabilities,
              })),
            }),
        },
        {
          path: '/api/v1/cpa/accounts',
          methods: ['GET'],
          handle: async (request) => {
            const url = new URL(request.url);
            return json(await accountsOf(url.searchParams.get('plugin') ?? 'workbuddy'));
          },
        },
        {
          path: '/api/v1/cpa/models',
          methods: ['GET'],
          handle: async (request) => {
            const url = new URL(request.url);
            return json(await modelsOf(url.searchParams.get('plugin') ?? 'workbuddy'));
          },
        },
        {
          path: '/api/v1/cpa/school',
          methods: ['GET'],
          handle: async () => json(await school()),
        },
        {
          path: '/api/v1/cpa/routing',
          methods: ['GET', 'POST'],
          handle: async (request) => {
            if (request.method === 'GET') return json(await routingGet());
            let body = {};
            try {
              body = await request.json();
            } catch {
              body = {};
            }
            return json(await routingSet(String(body.strategy ?? '')));
          },
        },
        {
          /**
           * 把所有渠道的 `scheduler_mode` 归一到 `off`。
           *
           * 这是"账号优先级生效"的前置条件：插件处于 `credits` 模式时
           * 自己按剩余额度选号，会把 `priority` 完全架空。
           */
          path: '/api/v1/cpa/scheduler-mode',
          methods: ['POST'],
          handle: async () => json(await schedulerModeNormalize()),
        },
        {
          /**
           * 添加账号（OAuth 登录）。
           *
           * - `GET  ?plugin=<渠道>`        起一次登录，返回 `{state, url}`
           * - `GET  ?state=<state>`        查进度（`wait` / 完成 / 过期）
           * - `DELETE ?state=<state>`      取消
           *
           * 前端拿到 `url` 后引导用户在浏览器完成授权即可 ——
           * **不需要用户手动粘贴回调 URL**（本机模式下 CPA 自己收回调并保存凭据）。
           */
          path: '/api/v1/cpa/auth',
          methods: ['GET', 'DELETE'],
          handle: async (request) => {
            const url = new URL(request.url);
            const state = url.searchParams.get('state');
            if (request.method === 'DELETE') return json(await authCancel(state ?? ''));
            if (state !== null) return json(await authStatus(state));
            return json(await authStart(url.searchParams.get('plugin') ?? ''));
          },
        },
        {
          path: '/api/v1/cpa/priority',
          methods: ['GET', 'POST'],
          handle: async (request) => {
            const url = new URL(request.url);
            const plugin = url.searchParams.get('plugin') ?? 'workbuddy';
            if (request.method === 'GET') return json(await priorityGet(plugin));
            let body = {};
            try {
              body = await request.json();
            } catch {
              body = {};
            }
            return json(await prioritySet(plugin, body.order));
          },
        },
        {
          path: '/api/v1/cpa/action',
          methods: ['POST'],
          handle: async (request) => {
            let body = {};
            try {
              body = await request.json();
            } catch {
              body = {};
            }
            return json(await action(body.plugin, body.kind, body.authIndex));
          },
        },
        {
          /**
           * 启用 / 禁用账号。
           *
           * body: `{plugin, authIndex, enabled}`。
           * 这是"只有一个账号消耗积分"的可靠手段（禁用 = 根本不参与调度）。
           */
          path: '/api/v1/cpa/account-enabled',
          methods: ['POST'],
          handle: async (request) => {
            let body = {};
            try {
              body = await request.json();
            } catch {
              body = {};
            }
            return json(await accountEnabled(body.plugin, body.authIndex, body.enabled === true));
          },
        },
        {
          /**
           * 「选择」账号：启用它，并禁用**同一渠道**的其余所有账号。
           *
           * 一次调用把整个渠道收敛到单账号 —— 用户不必逐个点禁用。
           */
          path: '/api/v1/cpa/account-select',
          methods: ['POST'],
          handle: async (request) => {
            let body = {};
            try {
              body = await request.json();
            } catch {
              body = {};
            }
            return json(await accountSelect(body.plugin, body.authIndex));
          },
        },
        {
          /**
           * 读 / 重新应用「用户上次的账号选择」。
           *
           * - `GET`  —— 返回记录下来的意图（给界面展示"记住的是哪些"）
           * - `POST` —— 立即按意图恢复一次（正常情况下启动时已自动做过）
           */
          path: '/api/v1/cpa/account-intent',
          methods: ['GET', 'POST'],
          handle: async (request) => {
            if (request.method === 'POST') return json({ ok: true, ...(await restoreAccountIntent()) });
            const intent = readAccountIntent();
            return json({ ok: true, enabled: intent.enabled ?? {}, updatedAt: intent.updatedAt });
          },
        },
        {
          path: '/api/v1/cpa/auto-checkin',
          methods: ['GET', 'POST'],
          handle: async (request) => {
            const url = new URL(request.url);
            const plugin = url.searchParams.get('plugin') ?? 'workbuddy';
            if (request.method === 'GET') return json(await autoCheckin(plugin, 'GET'));
            let body = {};
            try {
              body = await request.json();
            } catch {
              body = {};
            }
            return json(await autoCheckin(plugin, 'POST', body.enabled === true));
          },
        },
        {
          path: '/api/v1/cpa/start',
          methods: ['POST'],
          handle: async () => {
            const state = await ensureRunning();
            return json({ ok: state.running, owned: state.owned, reason: state.reason });
          },
        },
      ];

      const disposers = routes.map((route) =>
        connectionCtx.connection.fetch.register({
          path: route.path,
          methods: route.methods,
          requestBody: 'buffered',
          fetch: (request) => route.handle(request),
        }),
      );

      return () => {
        for (const dispose of disposers) {
          try {
            void dispose();
          } catch {
            /* 卸载期忽略 */
          }
        }
      };
    }, 'cpa-panel: http routes');
  });
}
