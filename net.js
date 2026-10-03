/**
 * 网络层：带代理支持的 HTTP 客户端。
 *
 * 为什么不用内置 `fetch`：它（undici）**默认忽略 `HTTPS_PROXY`**，
 * 只有进程启动时带 `--use-env-proxy` / `NODE_USE_ENV_PROXY=1` 才认，
 * 而运行期再设环境变量**无效**（已实测）。插件不能要求用户改启动参数，
 * 所以这里自己走 `node:https`，并显式支持代理。
 *
 * 症状回顾：`api.github.com` 常可直连而 `github.com` 不可，
 * 于是 `findAsset()` 成功、`download()` 报 `fetch failed` ——
 * 报错点看起来在"下载"，实际是网络，极易误判。
 *
 * 代理来源（按优先级）：
 *  1. 环境变量 `HTTPS_PROXY` / `https_proxy` / `ALL_PROXY` / `all_proxy`
 *  2. Windows 系统代理（注册表 `Internet Settings`，Clash 等写这里）
 * 读不到就走直连 —— 不做任何假设。
 */

import { execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest, Agent as HttpsAgent } from 'node:https';
import { connect as netConnect } from 'node:net';
import { pipeline } from 'node:stream/promises';
import { connect as tlsConnect } from 'node:tls';

/** 允许跟随的重定向上限 —— GitHub 资产会 302 到 objects.githubusercontent.com。 */
const MAX_REDIRECTS = 5;

/** 把 `127.0.0.1:7897` / `http://host:port` / `host:port` 统一成 URL。 */
function normalizeProxy(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(text) ? text : `http://${text}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol === 'socks5:' || url.protocol === 'socks4:') {
    /** SOCKS 需要额外协议实现；明确报出来，别静默退化成直连。 */
    return { url, unsupported: 'socks' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return { url };
}

/** 读 Windows 系统代理。非 Windows 或读不到时返回 null。 */
function systemProxy() {
  if (process.platform !== 'win32') return null;
  try {
    const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
    const out = execFileSync('reg', ['query', key], { encoding: 'utf8', timeout: 5000 });
    if (!/ProxyEnable\s+REG_DWORD\s+0x1/iu.test(out)) return null;
    const match = /ProxyServer\s+REG_SZ\s+(\S+)/u.exec(out);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * 探测可用代理。返回 `{ url }` 或 `null`（直连）。
 * 结果缓存在模块级 —— 代理配置在进程生命周期内不会变。
 */
let proxyCache;
export function detectProxy({ refresh = false } = {}) {
  if (!refresh && proxyCache !== undefined) return proxyCache;

  const envKeys = ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy'];
  for (const key of envKeys) {
    const found = normalizeProxy(process.env[key]);
    if (found) {
      proxyCache = found;
      return proxyCache;
    }
  }
  proxyCache = normalizeProxy(systemProxy());
  return proxyCache;
}

/**
 * 经代理建 CONNECT 隧道，返回已升级为 TLS 的 socket。
 *
 * `https.Agent` 的 `createConnection` 契约要求回调一个**已完成 TLS 握手**的
 * socket，所以这里在 CONNECT 拿到 200 之后再 `tls.connect`。
 */
class ProxyAgent extends HttpsAgent {
  constructor(proxyUrl) {
    super({ keepAlive: false });
    this.proxy = proxyUrl;
  }

  createConnection(options, callback) {
    const targetHost = options.host;
    const targetPort = options.port || 443;
    const proxyPort = Number(this.proxy.port) || (this.proxy.protocol === 'https:' ? 443 : 80);

    const socket = netConnect(proxyPort, this.proxy.hostname);
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      callback(error);
    };

    socket.once('error', fail);
    socket.once('connect', () => {
      socket.write(
        `CONNECT ${targetHost}:${String(targetPort)} HTTP/1.1\r\n` +
          `Host: ${targetHost}:${String(targetPort)}\r\n` +
          'Proxy-Connection: keep-alive\r\n\r\n',
      );
    });

    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk.toString('latin1');
      const end = buffer.indexOf('\r\n\r\n');
      if (end === -1) {
        if (buffer.length > 16384) fail(new Error('代理响应头过大'));
        return;
      }
      socket.removeListener('data', onData);
      const statusLine = buffer.slice(0, buffer.indexOf('\r\n'));
      const status = Number(statusLine.split(' ')[1]);
      if (status !== 200) {
        fail(new Error(`代理 CONNECT 被拒：${statusLine.trim()}`));
        return;
      }
      const secure = tlsConnect({ socket, servername: targetHost }, () => {
        if (settled) return;
        settled = true;
        callback(null, secure);
      });
      secure.once('error', fail);
    };
    socket.on('data', onData);
  }
}

/** 按协议选请求函数；代理存在时一律经隧道（含 http 目标，避免泄漏直连）。 */
function dispatch(url, proxy) {
  if (proxy?.unsupported === 'socks') {
    throw new Error('检测到 SOCKS 代理，暂不支持；请设置 HTTP_PROXY / HTTPS_PROXY 为 http 代理');
  }
  if (proxy?.url) {
    return { request: httpsRequest, agent: new ProxyAgent(proxy.url) };
  }
  return {
    request: url.protocol === 'http:' ? httpRequest : httpsRequest,
    agent: undefined,
  };
}

/**
 * 发一次 GET，返回 `{ status, headers, stream }`。
 * 不自动跟随重定向 —— 由 [openStream] 统一处理，便于记录跳转链。
 */
function once(url, { headers = {}, signal } = {}) {
  const proxy = detectProxy();
  const { request, agent } = dispatch(url, proxy);

  return new Promise((resolve, reject) => {
    const req = request(
      url,
      { method: 'GET', headers, agent, signal },
      (res) => resolve({ status: res.statusCode ?? 0, headers: res.headers, stream: res }),
    );
    req.once('error', reject);
    req.end();
  });
}

/** 跟随重定向，返回最终响应。 */
async function openStream(rawUrl, options = {}) {
  let url = new URL(rawUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const res = await once(url, options);
    const location = res.headers.location;
    if ([301, 302, 303, 307, 308].includes(res.status) && location) {
      res.stream.resume();
      url = new URL(location, url);
      continue;
    }
    return { url, ...res };
  }
  throw new Error(`重定向超过 ${String(MAX_REDIRECTS)} 次`);
}

/** GET 一个 JSON。 */
export async function getJson(rawUrl, options = {}) {
  const { status, stream } = await openStream(rawUrl, options);
  if (status < 200 || status >= 300) {
    stream.resume();
    throw new Error(`HTTP ${String(status)}`);
  }
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * 流式下载到文件 —— 不把整包读进内存（CPA 本体 22 MB、渠道包 17 MB）。
 * 返回 `{ bytes, sha256 }`；sha256 边下边算。
 */
export async function downloadTo(rawUrl, destPath, { headers = {}, signal, onProgress } = {}) {
  const { status, headers: resHeaders, stream } = await openStream(rawUrl, { headers, signal });
  if (status < 200 || status >= 300) {
    stream.resume();
    throw new Error(`HTTP ${String(status)}`);
  }

  const total = Number(resHeaders['content-length'] ?? 0);
  let received = 0;
  let lastReport = 0;
  stream.on('data', (chunk) => {
    received += chunk.length;
    /** 节流：每 512 KB 或每 5% 报一次，避免刷屏。 */
    const step = total > 0 ? total / 20 : 524288;
    if (received - lastReport >= step) {
      lastReport = received;
      if (typeof onProgress === 'function') onProgress(received, total);
    }
  });

  const { createHash } = await import('node:crypto');
  const hash = createHash('sha256');
  stream.on('data', (chunk) => hash.update(chunk));

  await pipeline(stream, createWriteStream(destPath));
  if (typeof onProgress === 'function') onProgress(received, total);
  return { bytes: received, sha256: hash.digest('hex') };
}

/** 供诊断用：当前实际生效的代理描述。 */
export function describeProxy() {
  const proxy = detectProxy();
  if (!proxy) return '直连（未检测到代理）';
  if (proxy.unsupported === 'socks') return `SOCKS（不支持） ${proxy.url.href}`;
  return proxy.url.href;
}