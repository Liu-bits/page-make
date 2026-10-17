// GET /p/:projectId/... — 公开访问项目内资源（catch-all 动态路由；.php 交给 PHP 运行时执行）
// 新手宽容：精确路径 404 时按"文件名"在项目内做唯一匹配兜底（引用写错目录也能正常显示）
import { getKV, kvGet, kvListAll, keys, nowSeconds, pathFromSiteKey } from '../../lib/kv.js';
import { contentTypeFor, htmlPage } from '../../lib/responses.js';
import { STATUS } from '../../lib/state.js';
import { runPhp } from '../../lib/php.js';

const ID_RE = /^[a-f0-9]{32}$/;

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

  if (project.provider === 'edgeone' && project.expiresAt && nowSeconds() > project.expiresAt) {
    return htmlPage(410, 'expired', request);
  }

  // .php → 交给 PHP 运行时执行
  if (/\.php$/i.test(rel)) {
    return runPhp({ kv, project, rel, request });
  }

  // 新手宽容：引用可能带 URL 编码（中文文件名）→ 先解码再找
  let relPath = rel;
  try {
    const decoded = decodeURIComponent(rel);
    if (decoded !== rel && !decoded.includes('..')) relPath = decoded;
  } catch {
    // 非法编码保持原样
  }

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
  if (!bytes) return htmlPage(404, 'notFound', request);

  return new Response(bytes, {
    headers: {
      'Content-Type': contentTypeFor(actualPath),
      'Cache-Control': 'public, max-age=60',
    },
  });
}
