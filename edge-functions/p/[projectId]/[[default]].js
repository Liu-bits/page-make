// GET /p/:projectId/... — 公开访问项目内静态资源（catch-all 动态路由）
import { getKV, kvGet, keys, nowSeconds } from '../lib/kv.js';
import { contentTypeFor, htmlPage } from '../lib/responses.js';
import { STATUS } from '../lib/state.js';

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

  const bytes = await kv.get(keys.siteFile(id, rel), { type: 'arrayBuffer' });
  if (!bytes) return htmlPage(404, 'notFound', request);

  return new Response(bytes, {
    headers: {
      'Content-Type': contentTypeFor(rel),
      'Cache-Control': 'public, max-age=60',
    },
  });
}
