// GET /p/:projectId — 公开访问（任何人可访问，无需登录）
// 项目被 ban → 「该内容已被下架」；链接过期 → 过期提示页；入口为 .php → 交给 PHP 运行时执行
import { getKV, kvGet, keys, nowSeconds } from '../lib/kv.js';
import { contentTypeFor, htmlPage } from '../lib/responses.js';
import { STATUS } from '../lib/state.js';
import { runPhp } from '../lib/php.js';

const ID_RE = /^[a-f0-9]{32}$/;

export async function onRequest(context) {
  const { request, params } = context;
  const id = params?.projectId;
  if (!ID_RE.test(id)) return htmlPage(404, 'notFound', request);

  const kv = getKV(context.env);
  const project = await kvGet(kv, keys.project(id));
  if (!project) return htmlPage(404, 'notFound', request);

  // 违规项目：已下架
  if (project.status === 'banned') return htmlPage(403, 'takedown', request);
  if (project.status === STATUS.FAILED) return htmlPage(500, 'notFound', request);

  // Cloudflare 线路：302 跳转到 pages.dev 部署地址
  if (project.provider === 'cloudflare' && project.deploymentUrl) {
    return Response.redirect(project.deploymentUrl, 302);
  }

  // 链接过期判定（所有线路）：expiresAt 到期即过期（游客 10 分钟 / EdgeOne TTL）
  if (project.expiresAt && nowSeconds() > project.expiresAt) {
    return htmlPage(410, 'expired', request);
  }

  const entry = project.entryPath || 'index.html';

  // 入口是 PHP → 交给 PHP 运行时执行（POST/GET/查询串透传）
  if (/\.php$/i.test(entry)) {
    return runPhp({ kv, project, rel: entry, request });
  }

  const bytes = await kv.get(keys.siteFile(id, entry), { type: 'arrayBuffer' });
  if (!bytes) return htmlPage(404, 'notFound', request);

  return new Response(bytes, {
    headers: {
      'Content-Type': contentTypeFor(entry),
      'Cache-Control': 'public, max-age=60',
    },
  });
}
