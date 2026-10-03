/**
 * dsh-cpa-switch —— 宿主半边。
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
 * @module dsh-cpa-switch
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
import {
  generateSecretKey,
  managedExePath,
  readSecretKeyFromConfig,
  inspect as inspectSetup,
  prepare as prepareSetup,
} from './setup.js';

/** 本插件那一行的 Loader 条目 id —— 0.1.7 起它就是设置命名空间。 */
export const ENTRY_ID = 'dsh-cpa-switch';

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
 *
 * ⚠️ **只在用户点击面板时写入**。曾经由测试脚本手写这个文件，
 * 结果每次重启都把账号状态改成测试留下的样子（见
 * [决策记录](../../.agents/notes/remember-account-choice-2026-10-02.md)）。
 * 现在带 `source` 字段标明写入方，`source !== 'panel'` 的不参与恢复。
 */
function accountIntentPath() {
  return join(homedir(), '.dsh', 'storages', 'cpa-panel-accounts.json');
}

/** 读用户意图；损坏、缺 source、或来源不是面板，一律当没有。 */
function readAccountIntent() {
  try {
    const raw = readFileSync(accountIntentPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return { enabled: {} };
    if (typeof parsed.enabled !== 'object' || parsed.enabled === null) return { enabled: {} };
    /**
     * **只认面板写的**。
     *
     * 恢复账号状态是"改用户的东西"，代价高；所以宁可什么都不做，
     * 也不能拿一个来源不明的文件去覆盖用户的现状。
     * 老版本写的文件没有 `source` 字段，同样不认。
     */
    if (parsed.source !== 'panel') return { enabled: {}, ignored: 'untrusted-source' };
    /**
     * ⚠️ **绝不把文件里的 `ignored` 透传出去。**
     *
     * `ignored` 是「读」这一步的**内部信号**（表示"这份文件不可信、别用"），
     * 不是磁盘 schema 的一部分。但它可序列化 —— 一旦被写进文件
     * （旧版本代码、或某个脚本把 `readAccountIntent()` 的结果原样回写），
     * 就会**永久**卡死恢复流程：
     *
     *   读出来带着 `ignored` → 恢复函数见 `ignored` 就跳过 → 永远不恢复
     *
     * 用户看到的是「我明明选过了，怎么每次都变回去」，而文件内容
     * 看起来一切正常、`source` 也是对的 —— 极难排查。
     * 所以这里显式剥掉，让 `ignored` 只可能来自上面那行返回值。
     */
    const intent = { ...parsed };
    delete intent.ignored;
    return intent;
  } catch {
    return { enabled: {} };
  }
}

/** 写用户意图。`source` 固定为 panel，只有面板的点击能产生。 */
function writeAccountIntent(value) {
  try {
    const p = accountIntentPath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ ...value, source: 'panel' }, null, 2), 'utf8');
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

  /**
   * 把密钥存进 DSH 凭据库。
   *
   * ⚠️ **必须自己存一份明文**，不能只依赖回读 `config.yaml`：
   * CPA 启动时会把配置里的明文 bcrypt 哈希后写回原文件，之后那个文件里的值
   * 就不再是可用令牌了（实测 401，详见 `setup.js` 的 `readSecretKeyFromConfig`）。
   * 凭据库是宿主的加密存储，密钥全程只在宿主侧流转，不下发浏览器（架构 §4.1）。
   *
   * 凭据引用可能被只读来源（如同名环境变量）遮蔽而拒绝写入 —— 这时
   * 静默失败即可：本轮内存里仍有可用密钥，只是下次启动要重新解析。
   *
   * @returns 存成功了没有。
   */
  const persistAdminKey = async (key) => {
    const ref = readConfig().adminKeyRef.trim();
    if (ref === '') return false;
    try {
      await ctx.credentials.set(credentialRef(ref), key);
      return true;
    } catch (error) {
      ctx.logger?.warn?.('cpa-panel: persist admin key failed: %o', error);
      return false;
    }
  };

  /**
   * 首次自动安装用的密钥。
   *
   * 用户装完插件什么都没配，`resolveAdminKey()` 必然返回空 —— 但自动安装
   * 必须先有密钥才能生成配置。这里按「沿用优先」取值：
   *
   *  1. 已解析到的密钥（显式配置 / 凭据库）→ 直接用；
   *  2. 托管配置里还有**明文** → 沿用，并补存进凭据库
   *     （老版本只写了 config.yaml，升级上来时得把它迁进凭据库，
   *     否则下次 CPA 把明文哈希掉之后就再也取不回来了）；
   *  3. 都没有 → 新造一个，**立刻存进凭据库**。
   *
   * 第 3 步的「立刻存」是关键：只写进 config.yaml 的话，CPA 一启动就把它
   * 哈希掉了，下次读回来是哈希、不是令牌 —— 那正是「重启一次就永久失联」
   * 这个缺陷的成因。
   *
   * 只写托管目录与宿主凭据库，**不下发浏览器**（架构 §4.1）。
   */
  const ensureAutoInstallKey = async () => {
    if (cachedAdminKey.value !== '') return cachedAdminKey.value;
    const legacy = readSecretKeyFromConfig();
    if (legacy !== '') {
      await persistAdminKey(legacy);
      return legacy;
    }
    const fresh = generateSecretKey();
    await persistAdminKey(fresh);
    return fresh;
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
   * 环境准备的运行态。
   *
   * `running` 用来挡住并发触发 —— 下载要几十秒，用户很容易连点
   * 两次「准备环境」，两个流程同时写同一个目录会互相踩。
   *
   * `progress` 是给前端轮询看的最近一步。整个下载约 40 MB、实测 96 秒，
   * 期间不报进度用户会以为卡死（见 PLAN 待办「环境准备的进度反馈」）。
   * 形状就是 `setup.js` 里 `onStep` 收到的那个对象，**原样透传不加工**，
   * 免得两边字段各叫各的。
   */
  const setup = { running: false, progress: undefined };

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
    /**
     * **托管副本优先于「上次找到的路径」。**
     *
     * 托管那份的 `config.yaml` 与密钥都由本插件掌握；别人的安装哪怕
     * 曾经成功找到过，密钥也未必取得到 —— 拿不到密钥就是 401、面板全空，
     * 表现为「插件用不了」而日志里只有一句鉴权失败。
     *
     * 候选清单里 `managedExePath()` 本来就排在第一位，这里只是让它
     * **真正生效**：否则一条旧记忆就能把插件永远钉在一份它管不了的安装上，
     * 用户装完插件永远等不到自动接管。
     */
    const managed = managedExePath();
    if (existsSync(managed)) {
      writeExeMemory(managed);
      return managed;
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
       *
       * ⚠️ 只认 `source === 'panel'` 的意图文件（见 `readAccountIntent`）。
       * 这个机制曾经出过事故：测试脚本手写了意图文件，之后每次重启都
       * 把账号状态改成测试留下的样子 —— 用户看到的是"我没动，怎么又变了"。
       * 恢复账号状态是"改用户的东西"，宁可什么都不做也不能拿来源不明的
       * 文件去覆盖现状。
       */
      const restoreAccountIntent = async () => {
        const intent = readAccountIntent();
        if (intent.ignored !== undefined) return { skipped: intent.ignored };
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
          /** 有实际改动才值得记日志 —— 没改动是常态，别刷屏。 */
          if (fixed.length > 0) {
            ctx.logger?.info?.('cpa-panel: 按用户选择恢复了 %d 个账号 %o', fixed.length, fixed);
          }
          return { restored: fixed };
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) };
        }
      };

  // ── 生命周期 effect ────────────────────────────────────────────────────
  ctx.effect(() => {
    let stopped = false;

    /**
     * 首次运行的自动安装。
     *
     * 目标：用户装完插件什么都不用点，CPA 自己就装好、配好、跑起来。
     *
     * ⚠️ **只在「环境为空」时动手**（见 [inspectSetup] 的 `missing`）：
     *   - 已经有 exe → 走 [ensureRunning] 复用，**绝不覆盖**；
     *   - 只缺渠道插件（有 exe、dll 数 0）→ 补齐插件即可，不重下 exe。
     *
     * 这条判断是硬约束：删掉探测来源却漏了兜底，曾导致**启不动 CPA、
     * 用户服务直接中断**（见 .agents/notes/incident-exe-discovery-2026-10-03.md）。
     *
     * @returns 装成功了没有。
     */
    const autoInstallIfNeeded = async () => {
      const config = readConfig();
      const state = inspectSetup({ port: config.port, secretKey: cachedAdminKey.value });
      if (state.ok) return false;

      /**
       * 用的是 `ensureAutoInstallKey()` 而不是 `cachedAdminKey.value` ——
       * 首次安装时后者必然是空，直接传会立刻 `no-admin-key` 卡死，
       * 自动安装就成了摆设。
       */
      const secretKey = await ensureAutoInstallKey();
      ctx.logger?.info?.('cpa-panel: auto install starting (missing: %o)', state.missing);
      const result = await prepareSetup({ port: config.port, secretKey });
      ctx.logger?.info?.('cpa-panel: auto install %s', result.ok ? 'ok' : `failed (${result.phase}: ${result.error})`);

      /**
       * 装完把密钥缓存回填。不回填的话，后续路由仍以为「没密钥」，
       * 会出现「装好了但面板处处报 no-admin-key」的怪状态。
       */
      if (result.ok && cachedAdminKey.value === '') {
        cachedAdminKey = { value: secretKey, source: 'auto-install' };
      }
      return result.ok === true;
    };

    const boot = async () => {
      /**
       * **先补环境，再启动** —— 顺序不能反。
       *
       * `ensureRunning()` 只要 exe 存在就会把 CPA 拉起来，而**没有配置的 CPA
       * 照样会监听端口**：`waitForPort` 一旦成功，`state.running` 就为真，
       * 「环境不全」这个事实随即被掩盖，配置再也补不回来 —— 表现为管理接口
       * 401/404、面板全空，而日志里只有一句「CPA unavailable」甚至什么都没有。
       *
       * 三个前提同时满足才补装（少一个都不动手）：
       *  - 端口空闲（已有 CPA 在跑就复用，绝不打扰）；
       *  - 生命周期没被用户关掉（关了就是显式不要这个能力，动手属越权）；
       *  - 缺件清单非空（`exe` / `plugins` / `config` 任一缺失）。
       *
       * `prepare()` 只补缺件、绝不覆盖已有 exe/dll，所以放它进来是安全的。
       */
      const preflight = readConfig();
      const portBusy = await probePort(preflight.port);
      const missing = inspectSetup({ port: preflight.port }).missing;
      if (!portBusy && preflight.manageLifecycle && missing.length > 0) {
        ctx.logger?.info?.('cpa-panel: environment incomplete (%o), preparing before start', missing);
        await autoInstallIfNeeded();
        if (stopped) return;
      }

      let state = await ensureRunning();
      if (stopped) return;

      /**
       * 补装之后仍然缺 exe（下载失败、或首次就跑到了这里）→ 再试一次。
       *
       * 保留这条兜底是因为 `prepare()` 可能部分失败：渠道插件装上了、
       * exe 没装上。此时上面的 preflight 已经放过，得靠这里再兜一次。
       */
      if (!state.running && state.reason === 'exe-not-found') {
        const installed = await autoInstallIfNeeded();
        if (stopped) return;
        if (installed) state = await ensureRunning();
      }

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
          /**
           * 环境准备。
           *
           * - `GET`  —— 查托管目录里 CPA 和渠道插件装了没、缺什么（给引导页用）
           * - `POST` —— 一键准备：下载 + 校验 + 解压 + 写配置
           *
           * ⚠️ **GET 和 POST 必须在同一个条目里**（方法合并），
           * 不能写成两个同 path 的条目：注册实现按 pathname 精确匹配，
           * 同一 path 注册第二次会**抛异常**，进而让整个 `routes.map()`
           * 中断、**所有路由都注册不上**。曾因此让插件完全不可用。
           *
           * POST 要下载约 40 MB、耗时实测 96 秒，所以同步跑完再返回；
           * 进度靠 `setup.running` / `setup.progress` 让前端轮询 `GET` 看到。
           */
          path: '/api/v1/cpa/setup',
          methods: ['GET', 'POST'],
          handle: async (request) => {
            const config = readConfig();
            if (request.method !== 'POST') {
              return json({
                ok: true,
                running: setup.running,
                progress: setup.progress,
                ...inspectSetup({ port: config.port, secretKey: cachedAdminKey.value }),
              });
            }

            /**
             * 密钥优先取缓存；缓存空则现造一个。
             *
             * 缓存空有两种情况：真没配（首次自动安装），或自动安装刚跑完
             * 但没回填。两种都该在现场造密钥，而不是把用户顶回去配。
             */
            const secretKey = cachedAdminKey.value !== '' ? cachedAdminKey.value : await ensureAutoInstallKey();
            if (setup.running) return json({ ok: false, error: 'already-running' });
            setup.running = true;
            setup.progress = { phase: 'starting' };
            try {
              const result = await prepareSetup({
                port: config.port,
                secretKey,
                onStep: (step) => {
                  setup.progress = step;
                },
              });
              /* 装完就把记忆指向托管的那份，省得下次还要探测 */
              if (result.ok) {
                writeExeMemory(managedExePath());
                if (cachedAdminKey.value === '') {
                  cachedAdminKey = { value: secretKey, source: 'auto-install' };
                }
              }
              return json(result);
            } catch (error) {
              return json({
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              });
            } finally {
              setup.running = false;
              setup.progress = undefined;
            }
          },
        },
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
           * - `POST {action:'cancel', state}` 取消
           *
           * ⚠️ 取消**不能用 DELETE**：`ConnectionFetchMethod` 只有
           * `GET` / `HEAD` / `POST` 三档，注册一个 DELETE 会**抛异常**，
           * 进而让整个 `routes.map()` 中断、所有路由都注册不上。
           * 曾因此让插件完全不可用，所以这里走 POST + body 里的 action。
           *
           * 前端拿到 `url` 后引导用户在浏览器完成授权即可 ——
           * **不需要用户手动粘贴回调 URL**（本机模式下 CPA 自己收回调并保存凭据）。
           */
          path: '/api/v1/cpa/auth',
          methods: ['GET', 'POST'],
          handle: async (request) => {
            if (request.method === 'POST') {
              let body = {};
              try {
                body = await request.json();
              } catch {
                body = {};
              }
              return json(await authCancel(typeof body.state === 'string' ? body.state : ''));
            }
            const url = new URL(request.url);
            const state = url.searchParams.get('state');
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

      /**
       * 校验并归一化路由表，**然后逐条注册**。
       *
       * 宿主的路由契约（见 `dsh-ds-balance` 的 `lib/http/routes.js` 注释）：
       *  - 同一 `path` **只能注册一次**，方法要在表里合并；
       *  - `ConnectionFetchMethod` 只有 `GET` / `HEAD` / `POST` 三档。
       *
       * 违反任意一条，`register` 都会**抛异常**。而下面原本是
       * `routes.map(...)` —— 一条抛了，**整个 map 中断，所有路由都注册不上**，
       * 表现为"插件完全打不开"（连 `/status` 都 404）。
       *
       * 所以这里先归一化：同 path 的多个条目**合并方法**、不支持的方法**剔除**。
       * 归一化后仍然逐条 try/catch —— 宁可少一条路由，也不能全废。
       */
      const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST']);
      const merged = new Map();
      for (const route of routes) {
        const bad = (route.methods ?? []).filter((m) => !ALLOWED_METHODS.has(m));
        if (bad.length > 0) {
          ctx.logger?.warn?.(
            'cpa-panel: 路由 %s 声明了不支持的方法 %o，已剔除（只允许 GET/HEAD/POST）',
            route.path,
            bad,
          );
        }
        const methods = (route.methods ?? []).filter((m) => ALLOWED_METHODS.has(m));
        if (methods.length === 0) continue;

        const existing = merged.get(route.path);
        if (existing === undefined) {
          merged.set(route.path, { ...route, methods });
          continue;
        }
        /**
         * 同 path 已有条目。
         *
         * 合并方法，并把两个 handler 串起来 —— 各自只处理自己声明的方法，
         * 让写代码的人可以像写两条路由那样写，而注册时仍是**一条**。
         */
        ctx.logger?.warn?.('cpa-panel: 路由 %s 被声明多次，已合并方法', route.path);
        const previous = existing.handle;
        const current = route.handle;
        existing.methods = [...new Set([...existing.methods, ...methods])];
        existing.handle = async (request) =>
          existing.methods.includes(request.method) && methods.includes(request.method)
            ? current(request)
            : previous(request);
      }

      const disposers = [];
      for (const route of merged.values()) {
        try {
          disposers.push(
            connectionCtx.connection.fetch.register({
              path: route.path,
              methods: route.methods,
              requestBody: 'buffered',
              fetch: (request) => route.handle(request),
            }),
          );
        } catch (error) {
          /* 单条失败不该拖垮其余路由 */
          ctx.logger?.error?.('cpa-panel: 注册路由 %s 失败：%o', route.path, error);
        }
      }

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
