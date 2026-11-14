// GET /api/projects/:id — 项目详情
// POST /api/projects/:id — action: delete（删除）/ rename（重命名）/ publish（生成公开链接）
// DELETE /api/projects/:id — 删除项目（兼容；ModelScope 网关拦截 DELETE，客户端走 POST）
import { getOwnedProject, deleteProjectRecords, syncProjectFilesLocked, readSiteFiles, projectPublicUrl } from '../../lib/project.js';
import { read as readVisitStats } from '../../lib/visitstats.js';
import { ok, fail } from '../../lib/responses.js';
import { appendLog, keys } from '../../lib/kv.js';
import { STATUS, isBackendKind, normalizeKind } from '../../lib/state.js';
import { analyzeHtml } from '../../lib/diagnostics.js';
import { rewriteLocalRefs, rewriteCssRefs } from '../../lib/paths.js';
import { canUseBackend, tierOf } from '../../lib/tiers.js';
import { deployBackendApp, stop as stopBackendApp } from '../../lib/backend-runtime.js';

export async function onRequest(context) {
  const { request, params } = context;
  const result = await getOwnedProject(context, params?.id);
  if (result.error) return result.error;
  const { project, kv, user } = result;

  if (request.method === 'GET') {
    // 访问统计合并视图（KV 已落盘 + 内存未落盘增量，实时），读失败不阻塞详情
    let visitStats = { total: 0, today: 0, days: {} };
    try {
      visitStats = await readVisitStats(kv, project.id);
    } catch {
      // 统计读取失败按 0 处理
    }
    return ok({ project, visitStats });
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
    // 锁内重读最新记录再合并写回：与封禁/删除并发时旧快照不会覆盖新状态
    const updated = await syncProjectFilesLocked(kv, project.id, { name });
    if (!updated) return fail('NOT_FOUND', 404);
    await appendLog(kv, { projectId: project.id, step: 'rename_project', result: 'ok' });
    return ok({ project: updated });
  }

  // 项目模式：统一生成公开链接（至少需要一个 HTML 文件作为入口）
  if (action === 'publish') {
    const files = await readSiteFiles(kv, project.id);
    if (files.size === 0) return fail('NO_ENTRY', 400);

    // 发布时允许切换部署形态（纯前端 ↔ npm ↔ pnpm ↔ js）。
    // 切到后端必须同时满足：VIP 及以上 + 项目里有 package.json（js 形态除外）。
    if (body?.kind !== undefined && !['static', 'npm', 'pnpm', 'js', 'bun'].includes(body.kind)) {
      return fail('INVALID_KIND', 400);
    }
    // 注意：VIP 校验必须按**最终生效的 kind** 判断，不能只在「显式传 kind」时判断。
    // 否则 VIP 建的 npm 项目在被降级后，只要 publish 不带 kind 就能继续占用
    // 常驻进程（backend-runtime 内部不做权限校验）。
    const kind = body?.kind !== undefined ? normalizeKind(body.kind) : normalizeKind(project.kind);
    if (isBackendKind(kind) && !canUseBackend(result.user)) {
      return fail('BACKEND_REQUIRES_VIP', 403);
    }

    if (isBackendKind(kind)) {
      if (kind !== 'js' && !files.has('package.json')) return fail('MISSING_PACKAGE_JSON', 400);
      // 锁内写 processing：与封禁/删除并发时旧快照不会覆盖新状态
      const publishPatch = { entryPath: null, status: STATUS.PROCESSING, errorCode: null };
      if (body?.kind !== undefined) publishPatch.kind = kind;
      publishPatch.url = projectPublicUrl(new URL(request.url).origin, project.id);
      const updated = await syncProjectFilesLocked(kv, project.id, publishPatch);
      if (!updated) return fail('NOT_FOUND', 404);

      // 依赖安装/构建/启动可能持续数分钟，不能占住一个 HTTP 请求：
      // ModelScope 网关与 iOS 都有请求超时，同步等待会把成功部署误报成网络错误。
      // 与分片上传一致，先返回 processing，再由客户端轮询 /status。
      const publishTask = (async () => {
        try {
          const runtime = await deployBackendApp({
            kv,
            projectId: project.id,
            kind,
            // 超时/并发配额按**当前**账号等级取，不能用项目记录里的陈旧 tier
            // （降级后仍用 svip/ultra 的超时会绕过限制）。
            tier: tierOf(result.user),
          });
          // 部署期间项目可能被删除 / 再次封禁：锁内复核 + 写回，
          // 不能拿部署前的内存对象把记录“复活”或把 banned 覆盖回 ready。
          const saved = await syncProjectFilesLocked(kv, project.id, {
            status: STATUS.READY,
            errorCode: null,
            runtimePort: runtime.port,
            runtimeKind: runtime.kind,
          });
          if (!saved) {
            await stopBackendApp(project.id);
            return;
          }
          await appendLog(kv, { projectId: project.id, step: 'publish_backend', result: 'ok', kind });
        } catch (error) {
          await stopBackendApp(project.id);
          // 与成功分支同样的守卫：部署期间项目可能已被删除，不能把旧快照写回去
          // 复活它（会留下永久孤儿记录，且回写的是部署前的 files/size）。
          const saved = await syncProjectFilesLocked(kv, project.id, {
            status: STATUS.FAILED,
            errorCode: error?.code || 'RUNTIME_UNAVAILABLE',
          });
          if (!saved) return;
          await appendLog(kv, {
            projectId: project.id,
            step: 'publish_backend',
            result: 'failed',
            errorCode: saved.errorCode,
          });
        }
      })();

      if (typeof context.waitUntil === 'function') {
        context.waitUntil(publishTask);
      } else {
        await publishTask;
      }
      return ok({ project: updated });
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
    // 锁内合并写回：与封禁/删除并发时旧快照不会覆盖新状态
    const updated = await syncProjectFilesLocked(kv, project.id, {
      diagnostics: analyzeHtml(html, files),
      entryPath: entry,
      status: STATUS.READY,
      url: projectPublicUrl(new URL(request.url).origin, project.id),
    });
    if (!updated) return fail('NOT_FOUND', 404);
    await appendLog(kv, { projectId: project.id, step: 'publish', result: 'ok' });
    return ok({ project: updated });
  }

  return fail('METHOD_NOT_ALLOWED', 405);
}
