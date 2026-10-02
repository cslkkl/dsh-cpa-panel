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
 * @module dsh-cpa-panel/setup
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

/**
 * 各平台的下载源。
 *
 * `asset` 里的 `{version}` 会被替换成实际 tag 去掉 `v` 前缀的版本号。
 */
export const SOURCES = {
  cpa: {
    repo: 'router-for-me/CLIProxyAPI',
    /** 取 latest release 的 API。 */
    latestApi: 'https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/latest',
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
 * 生成一份最小可用的 `config.yaml`。
 *
 * 只写**必须**的项，其余交给 CPA 的默认值 —— 配置越短，越不容易随
 * 上游版本变化而失效。
 *
 * 要点：
 *  - `management.secret-key` 必须设，否则管理接口无鉴权（本插件也调不通）；
 *  - `oauth.auth-dir` **指向用户原有的 `~/.cli-proxy-api`** —— 这样别人
 *    本来就用着 CPA 时，新装的这份能直接看到已有账号，不用重新加号；
 *  - `plugins.enabled: true` + `dir: "plugins"`，配合上面的目录布局生效。
 */
export function renderConfig({ port, secretKey }) {
  return [
    '# 由 dsh-cpa-panel 自动生成 —— 手改会在下次「重新准备环境」时被覆盖。',
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

/** 把字节数说成人话。 */
export function humanSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
}

/** 查 latest release 里符合模式的资产。 */
export async function findAsset(source) {
  const response = await fetch(source.latestApi, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-cpa-panel' },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`release 查询失败：HTTP ${String(response.status)}`);
  const data = await response.json();
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

/** 下载到临时文件，返回路径与 sha256。 */
export async function download(asset, onProgress) {
  const dir = join(tmpdir(), 'dsh-cpa-panel-dl');
  mkdirSync(dir, { recursive: true });
  const target = join(dir, asset.name);

  const response = await fetch(asset.url, {
    headers: { 'user-agent': 'dsh-cpa-panel' },
    signal: AbortSignal.timeout(600000),
  });
  if (!response.ok) throw new Error(`下载失败：HTTP ${String(response.status)}`);

  const total = Number(response.headers.get('content-length') ?? asset.size ?? 0);
  const hash = createHash('sha256');
  const chunks = [];
  let received = 0;
  for await (const chunk of response.body) {
    chunks.push(chunk);
    hash.update(chunk);
    received += chunk.length;
    if (typeof onProgress === 'function') onProgress(received, total);
  }
  writeFileSync(target, Buffer.concat(chunks));
  return { path: target, sha256: hash.digest('hex'), size: received };
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

