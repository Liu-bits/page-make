// POST /api/projects/paste — 直接粘贴代码创建网页（不经过文件上传）
// body: { provider, html, css?, js?, name? }
// 说明：html 必填；css/js 可选，写入 style.css / script.js 并自动注入 HTML 引用；
//       HTML 片段（无 <html> 结构）自动包裹成完整文档。
import { requireAuth, isTestUser } from '../../lib/session.js';
import { kvPut, kvListAll, keys, nowSeconds, appendLog } from '../../lib/kv.js';
import { ok, fail } from '../../lib/responses.js';
import { PROVIDERS, PASTE_MAX_BYTES, STATUS, GUEST_LINK_TTL_SECONDS } from '../../lib/state.js';
import { findLocalAsset, rewriteLocalRefs, rewriteCssRefs } from '../../lib/paths.js';
import { analyzeHtml } from '../../lib/diagnostics.js';
import { deploySite } from '../../lib/deploy/index.js';

const encoder = new TextEncoder();

function bytes(text) {
  return encoder.encode(text);
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 从 HTML 中找出 CSS/JS 的引用文件名（跟随用户写的 <link href> / <script src>）
 * 找不到时用默认名（style.css / script.js）
 *
 * 必须规范化：用户常写 `../style.css`、`./css/style.css`、`/style.css`，
 * 原样存成文件名会导致「存的是 ../style.css、浏览器请求被 URL 规范化成
 * /p/<id>/style.css」→ 404 断链。这里统一折叠成项目内相对路径。
 *
 * 匹配方式：先抓该标签的目标属性值，再按扩展名筛选。
 * 不能用 `<script[^>]+src=["']([^"']+\.js)["']` 这类正则——`type="text/javascript"`
 * 会抢先匹配，且 `app.js?v=9`（.js 后带查询串）匹配不到，两者都会导致引用断链。
 */
function findAssetPath(html, tag, attr, ext, fallback) {
  return findLocalAsset(html, tag, attr, ext) ?? fallback;
}

/**
 * 组装 HTML：
 * - 有 <html> 结构 → 用户已写 link/script 就不重复注入；没写才注入
 * - 无结构（片段）→ 包裹成完整文档
 * 返回 { html, cssPath, jsPath }：CSS/JS 内容应保存到 cssPath/jsPath
 */
function buildHtml(html, css, js, name) {
  // 先归一 HTML 里的引用字符串：后续 findAssetPath 取到的就是最终存储路径，
  // 保证「HTML 引用的路径」与「文件实际存储的路径」严格一致
  html = rewriteLocalRefs(html);
  const cssPath = findAssetPath(html, 'link', 'href', 'css', 'style.css');
  const jsPath = findAssetPath(html, 'script', 'src', 'js', 'script.js');
  // 「是否已引用」必须按 HTML 里是否真有对应标签判断，不能按路径是否等于默认名：
  // 用户写 `<script src="app.js?v=9">` 时规范化后是 app.js（≠ 默认名 script.js），
  // 旧逻辑会误判为「没引用过」而重复注入一个 script.js，导致用户引用的 app.js 404
  const hasCssRef = findAssetPath(html, 'link', 'href', 'css', '') !== '';
  const hasJsRef = findAssetPath(html, 'script', 'src', 'js', '') !== '';

  const cssLink = `<link rel="stylesheet" href="${cssPath}">`;
  const jsTag = `<script src="${jsPath}"></script>`;

  // 只要用户没有给出完整的 html/head/body 结构，就按片段包裹。
  // 不能只检查 <html>：用户常粘贴 `<head>...</head><body>...</body>`，
  // 这种情况下再包一层会产生嵌套文档，浏览器仍可能不应用样式。
  const hasDocumentStructure = /<(?:html|head|body)[\s>]/i.test(html);
  if (!hasDocumentStructure) {
    const head = [
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      `<title>${escapeHtml(name)}</title>`,
      css ? cssLink : '',
    ].filter(Boolean).join('\n  ');
    const bodyTail = js ? `\n  ${jsTag}` : '';
    return {
      html: `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  ${head}
</head>
<body>
${html}${bodyTail}
</body>
</html>`,
      cssPath,
      jsPath,
    };
  }

  let out = html;
  if (css && !hasCssRef) {
    out = insertIntoHead(out, `  ${cssLink}\n`);
  }
  if (js && !hasJsRef) {
    out = insertIntoBody(out, `  ${jsTag}\n`);
  }
  return { html: out, cssPath, jsPath };
}

/**
 * 把一段 head 内容插入完整文档。
 * 兼容：有 </head>、只有 <head>、完全没有 head、HTML 片段式完整文档。
 * 以前没有 </head> 时直接拼到文档最前面，link 实际落在 <html> 外，
 * 浏览器会忽略或把其当作正文资源，表现为“CSS 已上传但不生效”。
 */
function insertIntoHead(html, content) {
  if (/<\/head\s*>/i.test(html)) {
    return html.replace(/<\/head\s*>/i, `${content}</head>`);
  }
  if (/<head[\s>]/i.test(html) && /<body[\s>]/i.test(html)) {
    return html.replace(/<body([^>]*)>/i, (whole, attrs) => `${content}</head>\n<body${attrs}>`);
  }
  if (/<body[\s>]/i.test(html)) {
    return html.replace(/<body([^>]*)>/i, (whole, attrs) => `<head>\n${content}</head>\n<body${attrs}>`);
  }
  if (/<head[\s>]/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, (whole, attrs) => `<head${attrs}>\n${content}`);
  }
  if (/<html[\s>]/i.test(html)) {
    return html.replace(/<html([^>]*)>/i, (whole, attrs) => `<html${attrs}>\n<head>\n${content}</head>`);
  }
  // 兜底：没有可定位的 head 时，在文档最前面建立 head。
  return `<head>\n${content}</head>\n${html}`;
}

/**
 * 把一段脚本内容插入完整文档的 body 末尾。
 * 没有 </body> 时优先插到 </html> 前；连 html 结束标签都没有才追加到末尾。
 */
function insertIntoBody(html, content) {
  if (/<\/body\s*>/i.test(html)) {
    return html.replace(/<\/body\s*>/i, `${content}</body>`);
  }
  if (/<\/html\s*>/i.test(html)) {
    return html.replace(/<\/html\s*>/i, `${content}</html>`);
  }
  return `${html}\n${content}`;
}

export async function onRequest(context) {
  const { request } = context;
  const auth = await requireAuth(context);
  if (auth.error) return auth.error;
  if (request.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 405);

  let body;
  try {
    body = await request.json();
  } catch {
    return fail('BAD_REQUEST', 400);
  }

  // 游客（免登录兜底）最多创建 1 个网页
  if (auth.user.userId.startsWith('guest_')) {
    const existing = await kvListAll(auth.kv, keys.userProject(auth.user.userId, ''));
    if (existing.length >= 1) return fail('GUEST_LIMIT', 403);
  }

  // 单线路部署：provider 可省略，默认 local（非法值仍拒绝）
  const provider = body?.provider || 'local';
  if (!PROVIDERS.has(provider)) return fail('INVALID_PROVIDER', 400);

  const html = typeof body?.html === 'string' ? body.html : '';
  const css = typeof body?.css === 'string' ? body.css : '';
  const js = typeof body?.js === 'string' ? body.js : '';
  const name = (typeof body?.name === 'string' && body.name.trim()) || 'untitled';

  if (!html.trim()) return fail('BAD_REQUEST', 400);

  const totalBytes = bytes(html).length + bytes(css).length + bytes(js).length;
  // 测试账号（后台创建）权益最高：绕过粘贴大小上限
  if (!isTestUser(auth.user) && totalBytes > PASTE_MAX_BYTES) return fail('TOO_LARGE', 413);

  const projectId = crypto.randomUUID().replace(/-/g, '');
  const origin = new URL(request.url).origin;
  const kv = auth.kv;
  const started = Date.now();

  try {
    // 组装文件（CSS/JS 文件名跟随用户 HTML 里的引用）
    const files = new Map();
    const built = buildHtml(html, css, js, name);
    files.set('index.html', bytes(built.html));
    // CSS 内部的 url() 引用与 HTML 的 link/script 同根因，存访都要归一
    if (css.trim()) files.set(built.cssPath, bytes(rewriteCssRefs(css)));
    if (js.trim()) files.set(built.jsPath, bytes(js));
    const diagnostics = analyzeHtml(built.html, files);
    const autoGenerated = !/<html[\s>]/i.test(html);
    const entryPath = 'index.html';

    // 部署
    const deploy = await deploySite({ kv, env: context.env, provider, projectId, files, entryPath, name });

    const manifest = [...files.entries()].map(([path, data]) => ({ path, size: data.length }));

    // 写索引后写项目记录（ready 作为提交点）
    await kvPut(kv, keys.userProject(auth.user.userId, projectId), { createdAt: nowSeconds() });

    // 游客创建的链接 10 分钟后自动失效（登录后长期有效）
    const guestExpires = auth.user.userId.startsWith('guest_')
      ? nowSeconds() + GUEST_LINK_TTL_SECONDS
      : null;

    const project = {
      id: projectId,
      userId: auth.user.userId,
      provider,
      status: STATUS.READY,
      entryPath,
      fileCount: files.size,
      size: manifest.reduce((a, f) => a + f.size, 0),
      errorCode: null,
      sourceType: 'paste',
      autoGenerated,
      diagnostics,
      runtimeErrors: [],
      createdAt: nowSeconds(),
      updatedAt: nowSeconds(),
      expiresAt: guestExpires ?? deploy.expiresAt,
      deploymentUrl: deploy.deploymentUrl,
      url: `${origin}/p/${projectId}`,
      files: manifest,
    };
    await kvPut(kv, keys.project(projectId), project);
    await appendLog(kv, { projectId, step: 'paste', result: 'ok', duration: Date.now() - started });

    return ok({ project });
  } catch (error) {
    await appendLog(kv, {
      projectId,
      step: 'paste',
      result: 'failed',
      errorCode: error.code || 'STORAGE_ERROR',
      duration: Date.now() - started,
    });
    return fail(error.code || 'STORAGE_ERROR', error.code === 'STORAGE_ERROR' ? 500 : 400);
  }
}
