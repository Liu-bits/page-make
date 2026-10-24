// GET /p/:projectId — 公开访问（任何人可访问，无需登录）
// 项目被 ban → 「该内容已被下架」；链接过期 → 过期提示页
import { getKV, kvGet, keys, nowSeconds } from '../lib/kv.js';
import { contentTypeFor, htmlPage } from '../lib/responses.js';
import { STATUS } from '../lib/state.js';
import { injectPublicBase, rewriteLocalRefs } from '../lib/paths.js';

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
  // PHP 已移除；旧项目的 index.php 不能作为静态源码下发。
  if (/\.php$/i.test(entry)) return htmlPage(404, 'notFound', request);

  const bytes = await kv.get(keys.siteFile(id, entry), { type: 'arrayBuffer' });
  if (!bytes) return htmlPage(404, 'notFound', request);

  const type = contentTypeFor(entry);
  // 入口 URL 没有尾斜杠，相对资源会被浏览器解析到 /p/ 根。注入项目级
  // <base> 是唯一能同时覆盖 HTML/CSS/JS/图片与运行时 fetch 的统一下发兜底。
  let body = bytes;
  if (/^text\/html/i.test(type)) {
    let html = new TextDecoder().decode(bytes);
    // 存储层只保存项目内相对路径。下发时先归一历史数据里的 `../`、`./`
    // 等写法，再统一注入项目根 <base>；不能同时改写成 `/p/<id>/...`，
    // 否则路径被加两次前缀，且用户后续编辑时会把部署 ID 写回源码。
    html = rewriteLocalRefs(html);
    body = injectPublicBase(html, `/p/${id}`);
  }

  return new Response(body, {
    headers: {
      'Content-Type': type,
      'Cache-Control': 'public, max-age=60',
    },
  });
}
