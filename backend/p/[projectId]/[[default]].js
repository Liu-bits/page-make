// GET /p/:projectId/... — 公开访问项目内资源（catch-all 动态路由）
// 新手宽容：精确路径 404 时按"文件名"在项目内做唯一匹配兜底（引用写错目录也能正常显示）
// 另有两个保留路径：POST /p/<id>/__form（静态站表单收集）与项目内 404.html 自定义 404 页
import { getKV, kvGet, kvListAll, kvPut, keys, nowSeconds, pathFromSiteKey } from '../../lib/kv.js';
import { contentTypeFor, htmlPage, ok } from '../../lib/responses.js';
import { STATUS, isBackendKind, normalizeKind } from '../../lib/state.js';
import { rewriteCssRefs, rewriteLocalRefs, injectPublicBase } from '../../lib/paths.js';
import { mutateProject } from '../../lib/project.js';
import { proxy } from '../../lib/backend-runtime.js';
import { rateLimited, clientIp } from '../../lib/ratelimit.js';

const ID_RE = /^[a-f0-9]{32}$/;

// 表单收集上限：每项目 200 条（超出拒收不覆盖旧数据）、单值 2000 字符、字段 20 个
const FORM_MAX_SUBMISSIONS = 200;
const FORM_MAX_FIELDS = 20;
const FORM_MAX_VALUE_LENGTH = 2000;
const FORM_BODY_LIMIT = 32_000;

/** 静态站表单提交：POST /p/<id>/__form（浏览器原生表单返回页面，fetch JSON 返回 JSON） */
async function handleFormSubmit(request, kv, projectId) {
  // 每 IP 每分钟 5 次（独立桶，不与 feedback 抢额度）
  if (rateLimited(`form:${clientIp(request)}`, 5, 60_000)) {
    return htmlPage(429, 'formFail', request, 'rate limited');
  }
  let raw = '';
  try {
    raw = await request.text();
  } catch {
    return htmlPage(400, 'formFail', request, 'unreadable body');
  }
  if (raw.length > FORM_BODY_LIMIT) {
    return htmlPage(413, 'formFail', request, 'body too large');
  }

  const contentType = request.headers.get('content-type') || '';
  let fields = {};
  try {
    if (contentType.toLowerCase().includes('application/json')) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) fields = parsed;
    } else {
      for (const [key, value] of new URLSearchParams(raw)) fields[key] = value;
    }
  } catch {
    return htmlPage(400, 'formFail', request, 'malformed payload');
  }

  // 字段清洗：只收字符串值，限制个数与长度，键名剥控制字符
  const cleaned = {};
  let count = 0;
  for (const [key, value] of Object.entries(fields)) {
    if (count >= FORM_MAX_FIELDS) break;
    const cleanKey = String(key).slice(0, 64);
    if (!cleanKey) continue;
    cleaned[cleanKey] = String(value ?? '').slice(0, FORM_MAX_VALUE_LENGTH);
    count += 1;
  }

  // 数量上限：封顶后拒收，绝不覆盖旧数据
  const existing = await kvListAll(kv, keys.formSubmissionPrefix(projectId));
  if (existing.length >= FORM_MAX_SUBMISSIONS) {
    return htmlPage(429, 'formFail', request, 'submission limit reached');
  }

  const subId = `${nowSeconds()}_${(globalThis.crypto?.randomUUID?.() || '').slice(0, 8)}`;
  await kvPut(kv, keys.formSubmission(projectId, subId), {
    id: subId,
    projectId,
    fields: cleaned,
    createdAt: nowSeconds(),
  });

  // fetch(JSON) 调用返回 JSON；浏览器原生表单返回成功页
  const accept = request.headers.get('accept') || '';
  if (accept.includes('application/json')) {
    return ok({ submitted: true });
  }
  return htmlPage(200, 'formOk', request);
}

export async function onRequest(context) {
  const { request, params } = context;
  const id = params?.projectId;
  if (!ID_RE.test(id)) return htmlPage(404, 'notFound', request);

  // [[default]] 动态段：可能是字符串或数组
  const raw = params.default;
  const rel = Array.isArray(raw) ? raw.join('/') : (raw || '');
  if (!rel || rel.includes('..')) return htmlPage(404, 'notFound', request);

  const kv = getKV(context.env);
  const project = await kvGet(kv, keys.project(id));
  if (!project) return htmlPage(404, 'notFound', request);
  if (project.status === 'banned') return htmlPage(403, 'takedown', request);

  // Cloudflare 线路：跳转到部署域名下对应资源
  if (project.provider === 'cloudflare' && project.deploymentUrl) {
    return Response.redirect(`${project.deploymentUrl.replace(/\/$/, '')}/${rel}`, 302);
  }

  // 链接过期判定（所有线路）：expiresAt 到期即过期（游客 10 分钟 / EdgeOne TTL）
  if (project.expiresAt && nowSeconds() > project.expiresAt) {
    return htmlPage(410, 'expired', request);
  }

  // 后端项目：所有子路径都交给项目自己的进程处理（含 API 路由、静态资源）
  if (isBackendKind(normalizeKind(project.kind))) {
    const proxied = await proxy(project.id, request);
    if (proxied) return proxied;
    return htmlPage(503, 'backendStarting', request);
  }

  // 静态项目保留路径：表单收集（浏览器原生表单 / fetch JSON 均可）
  if (rel === '__form' && request.method === 'POST') {
    return handleFormSubmit(request, kv, id);
  }

  // 新手宽容：引用可能带 URL 编码（中文文件名）→ 先解码再找
  let relPath = rel;
  try {
    const decoded = decodeURIComponent(rel);
    if (decoded !== rel && !decoded.includes('..')) relPath = decoded;
  } catch {
    // 非法编码保持原样
  }

  // PHP 已移除；历史项目里的 .php 文件也不允许被当作静态源码下载。
  if (/\.php$/i.test(relPath)) return htmlPage(404, 'notFound', request);

  // 1. 精确匹配
  let bytes = await kv.get(keys.siteFile(id, relPath), { type: 'arrayBuffer' });

  // 2. 宽容兜底：按"文件名"（忽略目录）在项目内做唯一匹配
  let actualPath = relPath;
  if (!bytes && relPath.includes('/')) {
    const base = relPath.split('/').pop().toLowerCase();
    if (base && !base.startsWith('.')) {
      const keyList = await kvListAll(kv, keys.sitePrefix(id));
      const matches = [];
      for (const key of keyList) {
        const p = pathFromSiteKey(key);
        if (p.split('/').pop().toLowerCase() === base) matches.push(key);
      }
      if (matches.length === 1) {
        bytes = await kv.get(matches[0], { type: 'arrayBuffer' });
        if (bytes) actualPath = pathFromSiteKey(matches[0]);
      }
    }
  }
  if (!bytes) {
    // 项目内 404.html：自定义 404 页（仍返回 404 状态码，语义正确）。
    // 与入口页同管线：引用归一 + 项目级 <base>，样式表才能正常加载。
    const custom404 = await kv.get(keys.siteFile(id, '404.html'), { type: 'arrayBuffer' });
    if (custom404) {
      let nfHtml = new TextDecoder().decode(custom404);
      nfHtml = rewriteLocalRefs(nfHtml);
      nfHtml = injectPublicBase(nfHtml, `/p/${id}`);
      return new Response(nfHtml, {
        status: 404,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }
    return htmlPage(404, 'notFound', request);
  }

  // 游客项目按「连续 7 天无人访问」过期：子资源命中也刷新 lastAccessAt。
  // 读改写必须进项目锁（同 p/[projectId].js）：与封禁 / 升级 / 删除并发时，
  // 旧快照整记录回写会把 banned 覆盖回正常、把已删除的记录复活。
  if (project.expiresAt && project.userId?.startsWith('guest_')) {
    await mutateProject(kv, id, (record) => {
      if (!record.expiresAt || record.status === 'banned') return false;
      record.lastAccessAt = nowSeconds();
      record.expiresAt = record.lastAccessAt + (7 * 24 * 3600);
    });
  }

  // CSS 内部的 url() 引用（背景图/字体）同样要归一：与 HTML 的 link/script
  // 同一根因，但 HTML 侧修复覆盖不到 CSS 文件内容。只改 text/css，其他
  // 二进制资源（图片/字体/JS）原样返回，避免损坏内容。
  const type = contentTypeFor(actualPath);
  let body = bytes;
  if (/^text\/css/i.test(type)) {
    // CSS 内引用保持项目内相对路径，解析基准是样式表自身的
    // `/p/<id>/style.css`；不要写死部署 ID，避免源码与项目绑定。
    body = rewriteCssRefs(new TextDecoder().decode(bytes));
  }

  return new Response(body, {
    headers: {
      'Content-Type': type,
      'Cache-Control': 'public, max-age=60',
    },
  });
}
