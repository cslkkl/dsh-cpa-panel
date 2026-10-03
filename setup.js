/**
 * 环境准备：把 CPA 本体和渠道插件下载到本地。
 *
 * 用户装完这个 DSH 插件时，机器上通常**既没有 CPA、也没有渠道插件** ——
 * 光有管理界面没法用。这个模块负责把两者补齐，让"装插件 → 扫码 → 用"
 * 这条路走通。
 *
 * 两个来源都是 MIT 许可的公开 Release：
 *  - CPA 本体：`router-for-me/CLIProxyAPI`
 *  - 渠道插件：`mmqz/cpa-multi-plugins`（**一个 zip 含全部渠道**）
 *
 * ⚠️ 设计约束：
 *  1. **绝不覆盖用户已有的安装** —— 探测到就用，不动它。
 *  2. 下载到 `~/.dsh/cpa-panel/runtime/`，不污染用户主目录根。
 *  3. 校验 sha256 后才解压（网络下载的东西不能盲信）。
 *  4. 解压用系统 `tar`（Windows 10+ 自带 bsdtar，能解 zip）——
 *     不引入 zip 依赖，插件保持零 npm 依赖。
 *  5. **下载必须走代理**（当系统有代理时）—— 见 [net.js] 的说明：
 *     内置 `fetch` 默认忽略 `HTTPS_PROXY`，在受限网络下会让用户永远装不上。
 * @module dsh-cpa-switch/setup
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

import { downloadTo, getJson } from './net.js';

/**
 * 各平台的下载源。
 *
 * `asset` 里的 `{version}` 会被替换成实际 tag 去掉 `v` 前缀的版本号。
 *
 * ⚠️ **CPA 本体可切到自家 Release**（见 `cpaOwner`）。
 * 官方源发的是「全家桶」；自建源发的是按需编译的版本。切换只改这一个常量，
 * 但**自建源必须先真的存在 Release**，否则用户装插件时会卡在下载这一步
 * —— 没有兜底，就是又一次「启不动 CPA」。
 */
const cpaOwner = 'router-for-me';
export const SOURCES = {
  cpa: {
    repo: `${cpaOwner}/CLIProxyAPI`,
    /** 取 latest release 的 API。 */
    latestApi: `https://api.github.com/repos/${cpaOwner}/CLIProxyAPI/releases/latest`,
    assetPattern: /^CLIProxyAPI_[\d.]+_windows_amd64\.zip$/u,
    /** 解压后要找的可执行文件名。 */
    exeName: 'cli-proxy-api.exe',
    label: 'CLIProxyAPI 本体',
  },
  plugins: {
    repo: 'mmqz/cpa-multi-plugins',
    latestApi: 'https://api.github.com/repos/mmqz/cpa-multi-plugins/releases/latest',
    assetPattern: /^cpa-multi-plugins-windows-amd64\.zip$/u,
    label: '渠道插件（workbuddy / trae / qoder / zcode / mimo）',
  },
};

/** 插件自带的运行时目录。 */
export function runtimeDir() {
  return join(homedir(), '.dsh', 'cpa-panel', 'runtime');
}

/**
 * 托管 CPA 的工作目录。
 *
 * 刻意把 exe、config.yaml、plugins/ 都放在这一层 —— 因为 CPA 的
 * `plugins.dir` 是**相对工作目录**解析的（默认 `"plugins"`），
 * 三者同层就不用在配置里写绝对路径。
 */
export function managedCpaDir() {
  return join(runtimeDir(), 'cpa');
}

/** 解压出来的 CPA 可执行文件应该在的位置。 */
export function managedExePath() {
  return join(managedCpaDir(), SOURCES.cpa.exeName);
}

/** 托管 CPA 的配置文件。 */
export function managedConfigPath() {
  return join(managedCpaDir(), 'config.yaml');
}

/** 渠道插件目录（和 exe 同层，对应配置里的 `plugins.dir: "plugins"`）。 */
export function managedPluginsDir() {
  return join(managedCpaDir(), 'plugins');
}

/**
 * 需要显式启用的渠道插件。
 *
 * ⚠️ **`plugins.enabled: true` 不等于"渠道能用"。**
 *
 * 上游对每个渠道是**逐个**判定启用的，而且默认值是 `false`：
 *
 * ```go
 * // Enabled toggles this plugin instance. Nil is normalized to false during YAML parsing.
 * Enabled *bool `yaml:"enabled,omitempty"`
 * ...
 * defaultEnabled := false
 * c.Enabled = &defaultEnabled
 * ```
 *
 * 少了这一段，`plugins/` 下的 dll 会**全部处于未激活状态**，
 * 于是 `/v0/management/plugins/<id>/accounts` 一律 404 ——
 * 面板表现是「读取失败：HTTP 404」，而 CPA 本身跑得好好的、
 * `auth-files` 也读得到，**极容易误判成插件坏了**。
 *
 * 这份清单与渠道插件包（`mmqz/cpa-multi-plugins`）实际提供的 dll 对应。
 * 多写一个不存在的 id 无害（CPA 只是没有对应该实例）；
 * 少写一个的后果则是那个渠道静默不可用。
 */
const CHANNEL_PLUGINS = ['workbuddy', 'trae', 'qoder', 'zcode', 'mimo'];

/**
 * 生成一份最小可用的 `config.yaml`。
 *
 * 只写**必须**的项，其余交给 CPA 的默认值 —— 配置越短，越不容易随
 * 上游版本变化而失效。
 *
 * 要点：
 *  - `management.secret-key` 必须设，否则管理接口无鉴权（本插件也调不通）；
 *  - `oauth.auth-dir` **指向用户原有的 `~/.cli-proxy-api`** —— 这样别人
 *    本来就用着 CPA 时，新装的这份能直接看到已有账号，不用重新加号；
 *  - `plugins.enabled: true` + `dir: "plugins"` 让插件机制生效；
 *  - `plugins.configs.<渠道>.enabled: true` **逐个**启用渠道，
 *    见 [CHANNEL_PLUGINS] 的说明 —— 漏了这段渠道就全不工作。
 */
export function renderConfig({ port, secretKey }) {
  const channelLines = CHANNEL_PLUGINS.flatMap((id) => [
    `    ${id}:`,
    '      enabled: true',
  ]);
  return [
    '# 由 dsh-cpa-switch 自动生成 —— 手改会在下次「重新准备环境」时被覆盖。',
    'config-version: 8',
    '',
    'server:',
    `  port: ${String(port)}`,
    '',
    'management:',
    `  secret-key: "${secretKey}"`,
    '',
    'oauth:',
    '  auth-dir: "~/.cli-proxy-api"',
    '',
    'plugins:',
    '  enabled: true',
    '  dir: "plugins"',
    '  configs:',
    ...channelLines,
    '',
  ].join('\n');
}

/** 把生成的配置落盘。 */
export function writeConfig(content) {
  try {
    mkdirSync(managedCpaDir(), { recursive: true });
    writeFileSync(managedConfigPath(), content, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * 生成管理密钥。
 *
 * 首次自动安装时用 —— 用户什么都不知道，插件得自己造一个能用的密钥出来。
 *
 * **只在「全新安装」路径上调用**：已有配置的机器走 [readSecretKeyFromConfig]，
 * 绝不重新生成（换了密钥等于把用户原来配好的所有写操作全打断）。
 *
 * 32 字节 base64url ≈ 43 个字符，无 `+/=`，可安全塞进 YAML 双引号串。
 */
export function generateSecretKey() {
  return randomBytes(32).toString('base64url');
}

/** 是否长得像 bcrypt 哈希。CPA 会把配置里的明文换成这个形态。 */
export function looksLikeBcrypt(value) {
  return /^\$2[aby]?\$\d{2}\$/.test(String(value ?? ''));
}

/**
 * 从已有配置文件里读回管理密钥。
 *
 * 为什么要有这个：自动安装的触发条件是「找不到 exe」，但**配置可能还在**
 * （用户删了 exe 保留配置、或换了目录）。这时候必须沿用原密钥 ——
 * 重新生成会让配置文件里那个旧密钥对不上，本插件后续所有写操作 401。
 *
 * ⚠️ **只认明文；读到哈希一律当没读到。**
 *
 * CPA 启动时会把配置里的明文密钥 bcrypt 哈希后**写回同一个文件**
 * （见上游 `internal/config/config_load.go` 的
 * `SaveConfigPreserveCommentsUpdateNestedScalar`）。那个 `$2a$10$…`
 * 是**校验用的哈希，不是可用的令牌** —— 实测拿它当 Bearer token
 * 请求管理接口必然 401。
 *
 * 所以这里必须把哈希挡掉：否则插件会拿到一个「看起来有密钥、实际必定失败」
 * 的值，表现为**用户重启一次 CPA 后插件就永久失联**，而报错只显示 401，
 * 完全看不出根因。挡掉之后调用方会走「用凭据库持久化的密钥」那条路。
 *
 * 只做最朴素的正则提取，不引 YAML 解析器（插件保持零依赖）。
 * @returns 明文密钥；读不到、或只读到哈希时返回空串。
 */
export function readSecretKeyFromConfig() {
  try {
    const content = readFileSync(managedConfigPath(), 'utf8');
    const matched = /^\s*secret-key:\s*"?([^"\n\r]+)"?\s*$/mu.exec(content);
    const value = matched?.[1]?.trim() ?? '';
    return looksLikeBcrypt(value) ? '' : value;
  } catch {
    return '';
  }
}

/** 把字节数说成人话。 */
export function humanSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
}

/** 查 latest release 里符合模式的资产。 */
export async function findAsset(source) {
  let data;
  try {
    data = await getJson(source.latestApi, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-cpa-switch' },
      signal: AbortSignal.timeout(30000),
    });
  } catch (error) {
    throw new Error(`release 查询失败：${String(error?.message ?? error)}`);
  }
  const asset = (data.assets ?? []).find((a) => source.assetPattern.test(String(a.name)));
  if (asset === undefined) throw new Error(`release 里没有匹配 ${String(source.assetPattern)} 的文件`);
  return {
    tag: data.tag_name,
    name: asset.name,
    url: asset.browser_download_url,
    size: Number(asset.size ?? 0),
    /** `sha256:xxxx` 形式；老 release 可能没有。 */
    digest: typeof asset.digest === 'string' ? asset.digest : '',
  };
}

/**
 * 下载到临时文件，返回路径与 sha256。
 *
 * 走 [net.js] 的 `downloadTo`（流式 + 代理支持），**不把整包读进内存**：
 * CPA 本体 22 MB、渠道包 17 MB，一次性 Buffer.concat 在高并发下不划算。
 */
export async function download(asset, onProgress) {
  const dir = join(tmpdir(), 'dsh-cpa-switch-dl');
  mkdirSync(dir, { recursive: true });
  const target = join(dir, asset.name);

  try {
    const { bytes, sha256 } = await downloadTo(asset.url, target, {
      headers: { 'user-agent': 'dsh-cpa-switch' },
      signal: AbortSignal.timeout(600000),
      onProgress,
    });
    return { path: target, sha256, size: bytes };
  } catch (error) {
    throw new Error(`下载失败：${String(error?.message ?? error)}`);
  }
}

/** 校验 sha256；`expected` 为空（老 release 没提供）时跳过。 */
export function verify(downloaded, expectedDigest) {
  const expected = String(expectedDigest ?? '').replace(/^sha256:/u, '').toLowerCase();
  if (expected === '') return { ok: true, skipped: true };
  const actual = downloaded.sha256.toLowerCase();
  return actual === expected
    ? { ok: true, actual }
    : { ok: false, expected, actual };
}

/** 用系统 tar 解压 zip（Windows 10+ 自带 bsdtar）。 */
export function extract(zipPath, destDir) {
  mkdirSync(destDir, { recursive: true });
  return new Promise((resolve) => {
    const child = spawn('tar', ['-xf', zipPath, '-C', destDir], {
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', (error) => resolve({ ok: false, error: error.message }));
    child.on('close', (code) =>
      resolve(code === 0 ? { ok: true } : { ok: false, error: `tar 退出码 ${String(code)}` }),
    );
  });
}

/** 递归找一个文件名（用于在解压结果里定位 exe）。 */
export function findFile(root, name) {
  if (!existsSync(root)) return '';
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    if (statSync(full).isDirectory()) {
      const hit = findFile(full, name);
      if (hit !== '') return hit;
    } else if (entry.toLowerCase() === name.toLowerCase()) {
      return full;
    }
  }
  return '';
}

/** 目录里有多少个 .dll。 */
export function countDlls(dir) {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.dll')).length;
}

/** 读 JSON，失败返回 undefined。 */
export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/** 写 JSON；失败不致命。 */
export function writeJson(path, value) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** 删目录（用于重装）。 */
export function removeDir(path) {
  try {
    rmSync(path, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** 当前环境探测：装了没、缺什么。 */
export function inspect({ port, secretKey } = {}) {
  const exe = managedExePath();
  const plugins = managedPluginsDir();
  const config = managedConfigPath();
  const hasExe = existsSync(exe);
  const dllCount = countDlls(plugins);
  const hasConfig = existsSync(config);
  const missing = [];
  if (!hasExe) missing.push('cpa');
  if (dllCount === 0) missing.push('plugins');
  if (hasExe && !hasConfig) missing.push('config');
  return {
    ok: missing.length === 0,
    exePath: hasExe ? exe : '',
    configPath: hasConfig ? config : '',
    pluginsDir: plugins,
    dllCount,
    missing,
    port,
    hasSecretKey: typeof secretKey === 'string' && secretKey !== '',
  };
}

/**
 * 一步到位：下载 CPA 本体与渠道插件、校验、解压、写配置。
 *
 * `onStep` 会在每个阶段被调用，供前端显示进度 —— 整个过程要下载约
 * 40 MB、耗时几十秒，没有反馈用户会以为卡死了。
 *
 * ⚠️ **只写托管目录里的东西**，绝不碰用户已有的 CPA 安装。
 */
export async function prepare({ port, secretKey, onStep }) {
  const step = (phase, detail) => {
    if (typeof onStep === 'function') onStep({ phase, ...detail });
  };

  mkdirSync(managedCpaDir(), { recursive: true });

  const done = {};
  for (const key of ['cpa', 'plugins']) {
    const source = SOURCES[key];

    /**
     * **已有就跳过 —— 只补缺件，绝不重下。**
     *
     * 这条判断是设计约束 1 的落地（"绝不覆盖用户已有的安装"）。
     * 没有它时，只要配置缺一次就会把 exe 与渠道插件**整包重下**：
     * 40 MB 白流量、几十秒白等，而且会把用户手上正在跑的那份 exe
     * 覆盖成刚下载的版本 —— 一次「补配置」变成一次静默升级。
     *
     * 判据刻意宽松（exe 存在 / dll 数 > 0）而不是比对版本：
     * 插件无权替用户决定"你那份旧了该换"，那需要用户显式点重装。
     */
    const alreadyPresent =
      key === 'cpa' ? existsSync(managedExePath()) : countDlls(managedPluginsDir()) > 0;
    if (alreadyPresent) {
      step('reuse', { key, label: source.label });
      done[key] = { reused: true };
      continue;
    }

    step('query', { key, label: source.label });
    const asset = await findAsset(source);
    step('download', { key, label: source.label, name: asset.name, size: asset.size });

    let downloaded;
    try {
      downloaded = await download(asset, (received, total) => {
        step('progress', { key, label: source.label, received, total });
      });
    } catch (error) {
      return { ok: false, phase: 'download', key, error: String(error?.message ?? error) };
    }

    const check = verify(downloaded, asset.digest);
    if (!check.ok) {
      return {
        ok: false,
        phase: 'verify',
        key,
        error: `sha256 不匹配（期望 ${check.expected}，实际 ${check.actual}）`,
      };
    }

    /** CPA 本体解压进 cpa/；渠道插件解压进 cpa/plugins/。 */
    const dest = key === 'cpa' ? managedCpaDir() : managedPluginsDir();
    step('extract', { key, label: source.label });
    const extracted = await extract(downloaded.path, dest);
    if (!extracted.ok) {
      return { ok: false, phase: 'extract', key, error: String(extracted.error) };
    }
    done[key] = { name: asset.name, tag: asset.tag, verified: check.skipped !== true };
  }

  /**
   * 写配置。
   *
   * 只在**文件不存在**时写 —— 用户手改过的配置不能被覆盖。
   * 要重建得先删掉它（或调 `writeConfig` 显式覆盖）。
   */
  if (!existsSync(managedConfigPath())) {
    step('config', {});
    writeConfig(renderConfig({ port, secretKey }));
  }

  const state = inspect({ port, secretKey });
  step('done', { state });
  return { ok: state.ok, state, downloaded: done };
}

