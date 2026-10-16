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
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
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

    const tmp = `${this.file(key)}.tmp`;
    fs.writeFileSync(tmp, buffer);
    fs.renameSync(tmp, this.file(key));
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
  { file: 'backend/api/auth.js', pattern: /^\/api\/auth$/ },
  { file: 'backend/api/feedback.js', pattern: /^\/api\/feedback$/ },
  { file: 'backend/api/upload/init.js', pattern: /^\/api\/upload\/init$/ },
  { file: 'backend/api/upload/chunk.js', pattern: /^\/api\/upload\/chunk$/ },
  { file: 'backend/api/upload/finish.js', pattern: /^\/api\/upload\/finish$/ },
  { file: 'backend/api/upload/[uploadId].js', pattern: /^\/api\/upload\/([a-f0-9]{32})$/, params: ['uploadId'] },
  { file: 'backend/api/projects.js', pattern: /^\/api\/projects$/ },
  { file: 'backend/api/projects/[id].js', pattern: /^\/api\/projects\/([^/]+)$/, params: ['id'] },
  { file: 'backend/api/projects/[id]/status.js', pattern: /^\/api\/projects\/([^/]+)\/status$/, params: ['id'] },
  { file: 'backend/api/projects/[id]/refresh.js', pattern: /^\/api\/projects\/([^/]+)\/refresh$/, params: ['id'] },
  { file: 'backend/api/projects/[id]/files.js', pattern: /^\/api\/projects\/([^/]+)\/files$/, params: ['id'] },
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
function toWebRequest(req, body) {
  // 反向代理头：ModelScope 等平台通过 x-forwarded-proto/host 暴露公网地址
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// 服务启动
// ---------------------------------------------------------------------------
const kv = new DiskKV(DATA_DIR);

const env = {
  PAGEMAKE: kv,
  APPLE_CLIENT_ID: process.env.APPLE_CLIENT_ID || '',
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
    const pathname = decodeURIComponent(new URL(request.url).pathname);

    const route = ROUTES.find((r) => r.pattern.test(pathname));
    if (!route) {
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
      headers[key] = value;
    });
    res.writeHead(response.status, headers);
    res.end(payload);
    console.log(`${req.method} ${pathname} → ${response.status} (${Date.now() - startedAt}ms)`);
  } catch (error) {
    console.error('[server]', error);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'INTERNAL_ERROR' }));
    }
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Page-make 自托管服务：http://0.0.0.0:${PORT}`);
  console.log(`数据目录：${DATA_DIR}`);
  if (env.DEV_NO_AUTH === '1') {
    console.warn('⚠️ DEV_NO_AUTH=1：已跳过登录鉴权，仅限本地调试，生产环境禁止！');
  }
});
