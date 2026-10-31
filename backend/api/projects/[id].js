// GET /api/projects/:id — 项目详情
// POST /api/projects/:id — action: delete（删除）/ rename（重命名）/ publish（生成公开链接）
// DELETE /api/projects/:id — 删除项目（兼容；ModelScope 网关拦截 DELETE，客户端走 POST）
import { getOwnedProject, deleteProjectRecords, syncProjectFiles, readSiteFiles, projectPublicUrl } from '../../lib/project.js';
import { ok, fail } from '../../lib/responses.js';
import { appendLog, keys, kvGet, kvPut } from '../../lib/kv.js';
import { STATUS, isBackendKind, normalizeKind } from '../../lib/state.js';
import { analyzeHtml } from '../../lib/diagnostics.js';
import { rewriteLocalRefs, rewriteCssRefs } from '../../lib/paths.js';
import { canUseBackend } from '../../lib/tiers.js';
import { deployBackendApp, stop as stopBackendApp } from '../../lib/backend-runtime.js';

export async function onRequest(context) {
  const { request, params } = context;
  const result = await getOwnedProject(context, params?.id);
  if (result.error) return result.error;
  const { project, kv, user } = result;

  if (request.method === 'GET') {
    return ok({ project });
  }

  // POST + action 支持（网关拦截 DELETE）
  let action = request.method === 'DELETE' ? 'delete' : null;
  let body = null;
  if (request.method === 'POST') {
    try {
      body = await request.json();
      action = body?.action || null;
    } catch {
      action = null;
    }
  }

  if (action === 'delete') {
    await deleteProjectRecords(kv, user.userId, project.id);
    await appendLog(kv, { projectId: project.id, step: 'delete_project', result: 'ok' });
    return ok({ deleted: true });
  }

  if (action === 'rename') {
    const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 60) : '';
    if (!name) return fail('BAD_REQUEST', 400);
    project.name = name;
    await syncProjectFiles(kv, project);
    await appendLog(kv, { projectId: project.id, step: 'rename_project', result: 'ok' });
    return ok({ project });
  }

  // 项目模式：统一生成公开链接（至少需要一个 HTML 文件作为入口）
  if (action === 'publish') {
    const files = await readSiteFiles(kv, project.id);
    if (files.size === 0) return fail('NO_ENTRY', 400);

    // 发布时允许切换部署形态（纯前端 ↔ npm ↔ pnpm）。
    // 切到后端必须同时满足：VIP 及以上 + 项目里有 package.json。
    if (body?.kind !== undefined) {
      if (!['static', 'npm', 'pnpm'].includes(body.kind)) return fail('INVALID_KIND', 400);
      if (body.kind !== 'static' && !canUseBackend(result.user)) {
        return fail('BACKEND_REQUIRES_VIP', 403);
      }
      project.kind = body.kind;
    }
    const kind = normalizeKind(project.kind);

    if (isBackendKind(kind)) {
      if (!files.has('package.json')) return fail('MISSING_PACKAGE_JSON', 400);
      project.entryPath = null;
      project.status = STATUS.PROCESSING;
      project.errorCode = null;
      project.url = projectPublicUrl(new URL(request.url).origin, project.id);
      await syncProjectFiles(kv, project);

      // 依赖安装/构建/启动可能持续数分钟，不能占住一个 HTTP 请求：
      // ModelScope 网关与 iOS 都有请求超时，同步等待会把成功部署误报成网络错误。
      // 与分片上传一致，先返回 processing，再由客户端轮询 /status。
      const publishTask = (async () => {
        try {
          const runtime = await deployBackendApp({ kv, projectId: project.id, kind });
          // 部署期间项目可能被删除；不能拿部署前的内存对象把记录“复活”。
          const latest = await kvGet(kv, keys.project(project.id));
          if (!latest) {
            await stopBackendApp(project.id);
            return;
          }
          latest.status = STATUS.READY;
          latest.errorCode = null;
          latest.runtimePort = runtime.port;
          latest.runtimeKind = runtime.kind;
          await syncProjectFiles(kv, latest);
          await appendLog(kv, { projectId: project.id, step: 'publish_backend', result: 'ok', kind });
        } catch (error) {
          await stopBackendApp(project.id);
          project.status = STATUS.FAILED;
          project.errorCode = error?.code || 'RUNTIME_UNAVAILABLE';
          await kvPut(kv, keys.project(project.id), project);
          await appendLog(kv, {
            projectId: project.id,
            step: 'publish_backend',
            result: 'failed',
            errorCode: project.errorCode,
          });
        }
      })();

      if (typeof context.waitUntil === 'function') {
        context.waitUntil(publishTask);
      } else {
        await publishTask;
      }
      return ok({ project });
    }

    // 从 npm/pnpm 切回纯前端时回收旧常驻进程，避免后台继续占端口。
    await stopBackendApp(project.id);

    // 入口选择：沿用已设 HTML 入口 → index.html → 第一个 HTML。
    // 历史项目的 entryPath 可能是 index.php；不能继续沿用，否则发布会生成必然 404 的链接。
    let entry =
      project.entryPath
        && /\.html?$/i.test(project.entryPath)
        && files.has(project.entryPath)
        ? project.entryPath
        : null;
    if (!entry) {
      if (files.has('index.html')) {
        entry = 'index.html';
      } else {
        const htmlPaths = [...files.keys()].filter((p) => /\.html?$/i.test(p)).sort();
        if (htmlPaths.length) entry = htmlPaths[0];
      }
    }
    if (!entry) return fail('NO_ENTRY', 400);

    // 归一入口 HTML 内的本地引用：项目模式允许用户手写 `../style.css`，
    // 存储侧 validPath 拒绝带 .. 的路径，但 HTML 里的字符串原样下发仍会断链
    // （入口页 `/p/<id>` 无尾斜杠，`../x` 会被解析到站点外）
    if (/\.html?$/i.test(entry)) {
      const raw = files.get(entry);
      // 存储侧只保留项目内相对路径；`<base>` 由公开路由在下发时统一注入，
      // 避免发布一次后把项目 ID 写进可编辑源码。
      const rewritten = rewriteLocalRefs(new TextDecoder().decode(raw));
      if (rewritten !== new TextDecoder().decode(raw)) {
        const bytes = new TextEncoder().encode(rewritten);
        files.set(entry, bytes);
        await kv.put(keys.siteFile(project.id, entry), bytes);
      }
    }

    // 同理归一 CSS 内部的 url() 引用：项目模式里 style.css 是独立文件，
    // HTML 入口改写覆盖不到它，背景图/字体仍会断链
    for (const [path, data] of files) {
      if (!/\.css$/i.test(path)) continue;
      const rewritten = rewriteCssRefs(new TextDecoder().decode(data));
      if (rewritten === new TextDecoder().decode(data)) continue;
      const bytes = new TextEncoder().encode(rewritten);
      files.set(path, bytes);
      await kv.put(keys.siteFile(project.id, path), bytes);
    }

    // 静态诊断
    const html = new TextDecoder().decode(files.get(entry));
    project.diagnostics = analyzeHtml(html, files);
    project.entryPath = entry;
    project.status = STATUS.READY;
    project.url = projectPublicUrl(new URL(request.url).origin, project.id);
    await syncProjectFiles(kv, project);
    await appendLog(kv, { projectId: project.id, step: 'publish', result: 'ok' });
    return ok({ project });
  }

  return fail('METHOD_NOT_ALLOWED', 405);
}
