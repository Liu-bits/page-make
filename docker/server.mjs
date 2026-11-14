#!/usr/bin/env node
// =============================================================================
// Page-make 自托管服务（容器版）
// -----------------------------------------------------------------------------
// 把 backend/（EdgeOne Pages Functions 处理器）以普通 Node HTTP 服务运行：
//   - 路由与 backend/ 目录结构一一对应，业务逻辑零改动
//   - 磁盘 KV 适配器替代 EdgeOne KV 绑定（同样暴露 get/put/delete/list）
//   - 静态文件落盘，由 /p/ 路由直接对外提供（不再依赖第三方部署 API）
//
// 用途：ModelScope 创空间（Docker 类型，免费 CPU 空间）、Oracle VPS 等任意容器平台
//
// 环境变量：
//   PORT            监听端口（ModelScope 约定 7860）
//   DATA_DIR        数据目录（ModelScope 持久卷 /mnt/workspace/pagemake-data）
//   APPLE_CLIENT_ID iOS Bundle ID（校验 Apple 登录 token 的 aud）
//   DEV_NO_AUTH     仅本地调试：设为 1 跳过登录鉴权（生产环境禁止）
// =============================================================================
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 根目录探测：本地开发时 server.mjs 位于 docker/ 子目录（父目录即仓库根）；
// 容器内 Dockerfile 把它 COPY 到 /app/server.mjs（自身所在目录即根）。
// 两种情况都靠「backend/ 在哪」自动判定，避免写死。
const ROOT_CANDIDATES = [path.resolve(__dirname, '..'), __dirname];
const ROOT = ROOT_CANDIDATES.find((dir) => fs.existsSync(path.join(dir, 'backend'))) || ROOT_CANDIDATES[0];
const PORT = Number(process.env.PORT || 7860);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

// ---------------------------------------------------------------------------
// 磁盘 KV 适配器（API 与 EdgeOne KV 一致：get / put / delete / list）
// KV key 已由 lib/kv.js 编码为 [A-Za-z0-9_]，可直接用作文件名
// 写盘走「临时文件 + 重命名」，避免半截文件；启动时扫描目录建内存索引
// ---------------------------------------------------------------------------
class DiskKV {
  constructor(dir) {
    this.dir = dir;
    this.index = new Set();
    fs.mkdirSync(dir, { recursive: true });
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith('.tmp')) continue;
      this.index.add(name);
    }
  }

  file(key) {
    return path.join(this.dir, key);
  }

  async put(key, value) {
    let buffer;
    if (typeof value === 'string') {
      buffer = Buffer.from(value, 'utf8');
    } else if (Buffer.isBuffer(value)) {
      buffer = value;
    } else if (value instanceof ArrayBuffer) {
      buffer = Buffer.from(new Uint8Array(value));
    } else if (ArrayBuffer.isView(value)) {
      buffer = Buffer.from(value); // Uint8Array / ArrayBufferView
    } else {
      // 兜底：普通对象自动序列化（正常流程 kvPut 已处理，此处防御直调 kv.put）
      buffer = Buffer.from(JSON.stringify(value), 'utf8');
    }

    // 异步写盘：writeFileSync 会阻塞事件循环几秒（大文件），拖垮并发的
    // 状态轮询请求。promises 版本让 Node 在等磁盘时继续响应其他请求。
    //
    // 临时文件名必须**唯一**：同一 key 的并发写是常态（公开页每加载一个资源
    // 都会写回游客 lastAccessAt，见 p/[projectId].js 与 [[default]].js）。
    // 共用 `<key>.tmp` 时两个 write 会互相截断，rename 后得到半截 JSON，
    // 之后该项目所有请求 JSON.parse 抛错 → 永久 500。
    const tmp = `${this.file(key)}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await fsp.writeFile(tmp, buffer);
      await fsp.rename(tmp, this.file(key));
    } catch (error) {
      // 失败时清掉自己的临时文件，避免持久卷里堆 `.tmp` 垃圾
      await fsp.unlink(tmp).catch(() => {});
      throw error;
    }
    this.index.add(key);
  }

  async get(key, options) {
    const type = typeof options === 'string' ? options : options?.type || 'text';
    let buffer;
    try {
      buffer = fs.readFileSync(this.file(key));
    } catch {
      return null;
    }
    if (type === 'json') return JSON.parse(buffer.toString('utf8'));
    if (type === 'arrayBuffer') {
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    }
    return buffer.toString('utf8');
  }

  async delete(key) {
    try {
      fs.unlinkSync(this.file(key));
    } catch {
      // 文件不存在时忽略
    }
    this.index.delete(key);
  }

  async list(options = {}) {
    const prefix = options.prefix || '';
    const keys = [...this.index].filter((k) => k.startsWith(prefix)).sort();
    return { complete: true, cursor: null, keys: keys.map((k) => ({ key: k })) };
  }
}

// ---------------------------------------------------------------------------
// 路由表（与 backend/ 目录结构一一对应；精确匹配在前、通配在后）
// ---------------------------------------------------------------------------
const ROUTES = [
  { file: 'backend/index.js', pattern: /^\/$/ },
  { file: 'backend/api/config.js', pattern: /^\/api\/config$/ },
  { file: 'backend/api/stats.js', pattern: /^\/api\/stats$/ },
  { file: 'backend/api/auth/google.js', pattern: /^\/api\/auth\/google$/ },
  { file: 'backend/api/auth/guest.js', pattern: /^\/api\/auth\/guest$/ },
  { file: 'backend/api/auth/delete.js', pattern: /^\/api\/auth\/delete$/ },
  { file: 'backend/api/auth.js', pattern: /^\/api\/auth$/ },
  { file: 'backend/api/feedback.js', pattern: /^\/api\/feedback$/ },
  { file: 'backend/api/vip-request.js', pattern: /^\/api\/vip-request$/ },
  { file: 'backend/api/upload/init.js', pattern: /^\/api\/upload\/init$/ },
  { file: 'backend/api/upload/chunk.js', pattern: /^\/api\/upload\/chunk$/ },
  { file: 'backend/api/upload/finish.js', pattern: /^\/api\/upload\/finish$/ },
  { file: 'backend/api/upload/[uploadId].js', pattern: /^\/api\/upload\/([a-f0-9]{32})$/, params: ['uploadId'] },
  { file: 'backend/api/projects.js', pattern: /^\/api\/projects$/ },
  { file: 'backend/api/projects/paste.js', pattern: /^\/api\/projects\/paste$/ },
  { file: 'backend/api/projects/explorer.js', pattern: /^\/api\/projects\/explorer$/ },
  { file: 'backend/api/projects/[id].js', pattern: /^\/api\/projects\/([^/]+)$/, params: ['id'] },
  { file: 'backend/api/projects/[id]/status.js', pattern: /^\/api\/projects\/([^/]+)\/status$/, params: ['id'] },
  { file: 'backend/api/projects/[id]/refresh.js', pattern: /^\/api\/projects\/([^/]+)\/refresh$/, params: ['id'] },
  { file: 'backend/api/projects/[id]/files.js', pattern: /^\/api\/projects\/([^/]+)\/files$/, params: ['id'] },
  { file: 'backend/api/projects/[id]/export.js', pattern: /^\/api\/projects\/([^/]+)\/export$/, params: ['id'] },
  { file: 'backend/api/admin/login.js', pattern: /^\/api\/admin\/login$/ },
  { file: 'backend/api/admin/overview.js', pattern: /^\/api\/admin\/overview$/ },
  { file: 'backend/api/admin/action.js', pattern: /^\/api\/admin\/action$/ },
  { file: 'backend/p/[projectId].js', pattern: /^\/p\/([^/]+)$/, params: ['projectId'] },
  { file: 'backend/p/[projectId]/[[default]].js', pattern: /^\/p\/([^/]+)\/(.+)$/, params: ['projectId', 'default'] },
];

const handlerCache = new Map();

async function loadHandler(file) {
  if (!handlerCache.has(file)) {
    handlerCache.set(file, import(pathToFileURL(path.join(ROOT, file)).href));
  }
  return (await handlerCache.get(file)).onRequest;
}

// ---------------------------------------------------------------------------
// 请求 / 响应转换（Node → Web 标准 Request / Response）
// ---------------------------------------------------------------------------
// 反向代理头取第一个值：ModelScope 等平台经过多层代理时，
// x-forwarded-proto / x-forwarded-host 是逗号分隔的多值列表（如 "https, https"）
function firstHeaderValue(value) {
  if (Array.isArray(value)) value = value[0];
  return String(value || '').split(',')[0].trim();
}

function toWebRequest(req, body) {
  // 反向代理头：ModelScope 等平台通过 x-forwarded-proto/host 暴露公网地址
  const proto = firstHeaderValue(req.headers['x-forwarded-proto']) || 'http';
  const host = firstHeaderValue(req.headers['x-forwarded-host'])
    || firstHeaderValue(req.headers.host)
    || 'localhost';
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(', ') : String(value));
  }
  const init = { method: req.method, headers };
  if (body && req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = body;
  }
  return new Request(`${proto}://${host}${req.url}`, init);
}

// 请求体上限：readBody 会把整个 body 读进内存，且这一步发生在路由匹配与鉴权
// 之前——公开端口上任何匿名请求都能用超大 body 把容器内存打满。分片上传协议
// 只约束「合法客户端每片 600KB」，不是服务端强制，所以必须在这里兜底。
// 32MB 足以覆盖 SVIP 10MB 文件的 base64（约 13.3MB）+ JSON 开销；
// Ultra 需要更大时用 PAGEMAKE_MAX_BODY_BYTES 显式放开。
const MAX_BODY_BYTES = Number(process.env.PAGEMAKE_MAX_BODY_BYTES) > 0
  ? Number(process.env.PAGEMAKE_MAX_BODY_BYTES)
  : 32 * 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const tooLarge = () => Object.assign(new Error('BODY_TOO_LARGE'), { code: 'BODY_TOO_LARGE' });

    // 先看声明长度：超限直接拒绝，不必把 body 收完
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      reject(tooLarge());
      return;
    }

    const chunks = [];
    let total = 0;
    let overflow = false;
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    req.on('data', (chunk) => {
      if (overflow) return; // 已超限：继续消费但不再缓存，保证内存不涨
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        overflow = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (overflow) settle(reject, tooLarge());
      else settle(resolve, Buffer.concat(chunks));
    });
    req.on('error', (error) => settle(reject, error));
    // 客户端中途断开：必须 settle，否则 Promise 永久挂起、已收 chunk 泄漏
    req.on('aborted', () => settle(reject, Object.assign(new Error('REQUEST_ABORTED'), { code: 'REQUEST_ABORTED' })));
  });
}

// ---------------------------------------------------------------------------
// 服务启动
// ---------------------------------------------------------------------------
const kv = new DiskKV(DATA_DIR);

const env = {
  PAGEMAKE: kv,
  APPLE_CLIENT_ID: process.env.APPLE_CLIENT_ID || '',
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '',
  GOOGLE_JWKS_URL: process.env.GOOGLE_JWKS_URL || '',
  APPLE_JWKS_URL: process.env.APPLE_JWKS_URL || '',
  CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN || '',
  CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID || '',
  CLOUDFLARE_PAGES_PROJECT: process.env.CLOUDFLARE_PAGES_PROJECT || '',
  DEV_NO_AUTH: process.env.DEV_NO_AUTH || '',
};

const server = http.createServer(async (req, res) => {
  const startedAt = Date.now();
  try {
    const body = await readBody(req);

    // 健康检查（保活 / 平台健康探测用）
    if (req.url === '/healthz' || req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, service: 'page-make-container' }));
      return;
    }

    const request = toWebRequest(req, body.length ? body : undefined);
    let pathname = decodeURIComponent(new URL(request.url).pathname);

    // 公开页尾斜杠归一：/p/<id>/ 与 /p/<id> 是同一个入口。
    // 后端项目尤其需要——框架生成的链接、浏览器补全、用户手打都常带尾斜杠，
    // 不归一就会落到 404 而让用户以为「后端没部署成功」。
    if (/^\/p\/[a-f0-9]{32}\/$/.test(pathname)) pathname = pathname.slice(0, -1);

    // 管理后台页面（GET /admin → backend/admin.html 单页）
    if (pathname === '/admin' || pathname === '/admin/') {
      const { adminPageHtml } = await import(pathToFileURL(path.join(ROOT, 'backend/lib/admin.js')).href);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(adminPageHtml());
      console.log(`GET /admin → 200 (${Date.now() - startedAt}ms)`);
      return;
    }

    const route = ROUTES.find((r) => r.pattern.test(pathname));
    if (!route) {
      // 用户后端应用里 JS 写死绝对路径跳转（location.href = '/x'）会逃出
      // /p/<id> 前缀——location 赋值浏览器不允许劫持，代理注入的 shim 覆盖
      // 不到，只能在宿主层兜底：来源页是某个 /p/<id> 应用、目标又不匹配任何
      // 路由时，302 回该应用内同名路径。
      // 只兜 GET/HEAD：POST 重定向会丢请求体，静默丢数据比 404 更糟。
      // 只在「未匹配任何路由」时触发：宿主自身的 /api、/admin、/healthz 与
      // /p/ 路由不受影响，应用内部的 404（已匹配 /p/ 路由）也保持原语义。
      if (req.method === 'GET' || req.method === 'HEAD') {
        const referer = req.headers.referer;
        if (referer) {
          try {
            const refererPath = new URL(referer).pathname;
            const fromApp = refererPath.match(/^\/p\/([a-f0-9]{32})(?:\/|$)/);
            if (fromApp && !pathname.startsWith('/p/')) {
              const search = new URL(request.url).search;
              const target = `/p/${fromApp[1]}${encodeURI(pathname)}${search}`;
              res.writeHead(302, { Location: target });
              res.end();
              console.log(`${req.method} ${pathname} → 302 ${target}（Referer 前缀兜底, ${Date.now() - startedAt}ms）`);
              return;
            }
          } catch {
            // Referer 非法按无兜底处理
          }
        }
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }

    const match = pathname.match(route.pattern);
    const params = {};
    (route.params || []).forEach((name, index) => {
      params[name] = decodeURIComponent(match[index + 1]);
    });

    const onRequest = await loadHandler(route.file);
    const context = {
      request,
      params,
      env,
      // 容器版无 200ms CPU 限制：waitUntil 直接 fire-and-forget，状态轮询不变
      waitUntil: (promise) => {
        Promise.resolve(promise).catch((error) => console.error('[waitUntil]', error));
      },
    };

    const response = await onRequest(context);
    const payload = Buffer.from(await response.arrayBuffer());
    const headers = {};
    response.headers.forEach((value, key) => {
      // Set-Cookie 不能按逗号合并（Expires 里本身就有逗号），单独收集后按数组写出
      if (key.toLowerCase() === 'set-cookie') return;
      headers[key] = value;
    });
    // Set-Cookie 必须依赖 Node >= 20 的 getSetCookie()：
    // response.headers.forEach 会把同名头按 ", " 合并，而 Expires 里本身含逗号，
    // 合并后无法再拆开。低版本 Node 没有该方法时，多条 Set-Cookie 会被**整体丢弃**
    // （不是退化成单条——for 循环里已经 return 掉了），因此 Dockerfile 固定 Node 22。
    if (typeof response.headers.getSetCookie === 'function') {
      const cookies = response.headers.getSetCookie();
      if (cookies.length) headers['set-cookie'] = cookies;
    }
    res.writeHead(response.status, headers);
    res.end(payload);
    console.log(`${req.method} ${pathname} → ${response.status} (${Date.now() - startedAt}ms)`);
  } catch (error) {
    console.error('[server]', error);
    if (res.headersSent) return;
    if (error?.code === 'BODY_TOO_LARGE') {
      // 明确告知客户端超限，然后断开连接（body 可能还没收完）。
      // 注意**不能**在 res.end() 之后立刻 req.destroy()：此时响应还在发送缓冲里，
      // 立刻销毁 socket 会发 RST，客户端拿到的是「网络错误 / 连接被重置」而不是
      // 413，用户永远看不到「文件太大」这句提示。改为等响应刷出后再销毁，
      // 并留一个兜底计时器，避免客户端不读响应导致连接悬挂。
      res.writeHead(413, {
        'Content-Type': 'application/json; charset=utf-8',
        Connection: 'close',
      });
      const killTimer = setTimeout(() => {
        try { req.destroy(); } catch { /* 已关闭 */ }
      }, 2000);
      if (typeof killTimer.unref === 'function') killTimer.unref();
      res.end(JSON.stringify({ ok: false, error: 'TOO_LARGE' }), () => {
        clearTimeout(killTimer);
        try { req.destroy(); } catch { /* 已关闭 */ }
      });
      return;
    }
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'INTERNAL_ERROR' }));
  }
});

let runtimeModule = null;
let shuttingDown = false;

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    if (runtimeModule) await runtimeModule.stopAll();
  } catch (error) {
    console.error('[runtime] 停机回收失败', error);
  }
  server.close(() => process.exit(0));
  // 兜底：平台终止容器时不能无限等待 keep-alive 连接。
  setTimeout(() => process.exit(0), 3000).unref();
}

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Page-make 自托管服务：http://0.0.0.0:${PORT}`);
  console.log(`数据目录：${DATA_DIR}`);
  if (env.DEV_NO_AUTH === '1') {
    console.warn('⚠️ DEV_NO_AUTH=1：已跳过登录鉴权，仅限本地调试，生产环境禁止！');
  }

  // 预热 JWKS 加载器：首个登录请求直接命中内存缓存（境内实时拉取会 5s 超时后回退种子，
  // 不预热的话第一次 Google/Apple 登录要干等这个超时）。失败静默（加载器内部已三级回退）。
  for (const mod of ['./backend/lib/google-auth.js', './backend/lib/apple-auth.js']) {
    import(new URL(mod, import.meta.url))
      .then((m) => (mod.includes('google') ? m.googleJwks : m.appleJwks).getKeys())
      .catch(() => { /* 预热失败不影响启动，登录时才加载 */ });
  }

  // 重启后把已发布的后端项目重新拉起。
  // 进程状态只在内存里，容器重建/平台重启会全部丢失；源码在持久卷上，
  // 这里按 project_ 记录逐个重新安装启动，用户不需要重新部署。
  // 串行执行：并行 install 会把免费 CPU 打满，反而更慢。
  // 用 ROOT 拼路径：本地开发 server.mjs 在 docker/ 下，容器里在 /app 根，
  // 相对 import.meta.url 在两种布局下指向不同目录，会 ERR_MODULE_NOT_FOUND。
  import(pathToFileURL(path.join(ROOT, 'backend/lib/backend-runtime.js')).href)
    .then((m) => {
      runtimeModule = m;
      return m.restoreAll(kv);
    })
    .then((count) => {
      if (count > 0) console.log(`已恢复 ${count} 个后端项目`);
    })
    .catch((error) => console.error('[runtime] 恢复后端项目失败', error));

  // 过期会话 / 超期日志回收。TTL 只写在记录字段里，没有执行者就会无限堆积，
  // 让 kvListAll 的全表扫描越来越慢。延迟 30s 执行一次（避开启动恢复抢 CPU），
  // 之后每 6 小时一次；unref() 保证定时器不阻止进程退出。
  const runCleanup = () => {
    import(pathToFileURL(path.join(ROOT, 'backend/lib/maintenance.js')).href)
      .then((m) => m.cleanupExpired(kv))
      .then((result) => {
        const total = result.sessions + result.adminSessions + result.logs;
        if (total > 0) {
          console.log(`[maintenance] 清理过期数据：会话 ${result.sessions}、`
            + `管理员会话 ${result.adminSessions}、日志 ${result.logs}`);
        }
      })
      .catch((error) => console.error('[maintenance] 清理失败', error));
  };
  setTimeout(runCleanup, 30_000).unref();
  setInterval(runCleanup, 6 * 3600 * 1000).unref();

  // 站点访问计数落盘：/p/<id> 入口命中只做内存 +1（见 backend/lib/visitstats.js），
  // 每 30s 合并写一次 KV，避免匿名高频入口把 KV 操作放大。unref() 不阻止进程退出。
  const runVisitFlush = () => {
    import(pathToFileURL(path.join(ROOT, 'backend/lib/visitstats.js')).href)
      .then((m) => m.flush(kv))
      .catch((error) => console.error('[visitstats] 落盘失败', error));
  };
  setInterval(runVisitFlush, 30_000).unref();
});
