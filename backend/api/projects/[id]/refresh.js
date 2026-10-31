// POST /api/projects/:id/refresh — 刷新链接（从存储取回文件重新部署）
// 重新部署 → 更新 expiresAt → 返回新链接
import { getOwnedProject, readSiteFiles, syncProjectFiles, projectPublicUrl } from '../../../lib/project.js';
import { deploySite } from '../../../lib/deploy/index.js';
import { deployBackendApp, stop as stopBackendApp } from '../../../lib/backend-runtime.js';
import { findEntry } from '../../../lib/diagnostics.js';
import { appendLog, nowSeconds, kvGet, kvPut, keys } from '../../../lib/kv.js';
import { ok, fail } from '../../../lib/responses.js';
import { STATUS, GUEST_LINK_TTL_SECONDS, isBackendKind, normalizeKind } from '../../../lib/state.js';
import { isGuestLimited } from '../../../lib/session.js';
import { canUseBackend } from '../../../lib/tiers.js';

export async function onRequest(context) {
  const { request, params } = context;
  const result = await getOwnedProject(context, params?.id);
  if (result.error) return result.error;
  const { project, kv, user } = result;
  if (request.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 405);

  const started = Date.now();
  try {
    // 从 KV 取回已部署文件，重新部署
    const files = await readSiteFiles(kv, project.id);
    if (files.size === 0) {
      return fail('STORAGE_ERROR', 500, { message: '项目文件不存在，无法刷新' });
    }

    const kind = normalizeKind(project.kind);
    if (isBackendKind(kind)) {
      if (!canUseBackend(user)) {
        await stopBackendApp(project.id);
        return fail('BACKEND_REQUIRES_VIP', 403);
      }
      if (!files.has('package.json')) return fail('MISSING_PACKAGE_JSON', 400);

      project.kind = kind;
      project.entryPath = null;
      project.status = STATUS.PROCESSING;
      project.errorCode = null;
      project.url = projectPublicUrl(new URL(request.url).origin, project.id);
      await syncProjectFiles(kv, project);

      const refreshTask = (async () => {
        try {
          const runtime = await deployBackendApp({ kv, projectId: project.id, kind });
          // 刷新期间项目可能被删除；只更新仍然存在的记录。
          const latest = await kvGet(kv, keys.project(project.id));
          if (!latest) {
            await stopBackendApp(project.id);
            return;
          }
          latest.status = STATUS.READY;
          latest.errorCode = null;
          latest.runtimePort = runtime.port;
          latest.runtimeKind = runtime.kind;
          latest.expiresAt = null;
          await syncProjectFiles(kv, latest);
          await appendLog(kv, {
            projectId: project.id,
            step: 'refresh_backend',
            result: 'ok',
            kind,
            duration: Date.now() - started,
          });
        } catch (error) {
          await stopBackendApp(project.id);
          project.status = STATUS.FAILED;
          project.errorCode = error?.code || 'RUNTIME_UNAVAILABLE';
          await kvPut(kv, keys.project(project.id), project);
          await appendLog(kv, {
            projectId: project.id,
            step: 'refresh_backend',
            result: 'failed',
            errorCode: project.errorCode,
            duration: Date.now() - started,
          });
        }
      })();

      if (typeof context.waitUntil === 'function') {
        context.waitUntil(refreshTask);
      } else {
        await refreshTask;
      }
      return ok({ project });
    }

    // 历史项目的 entryPath 可能是已下线的 .php；刷新时重新选择 HTML 入口。
    const entry = project.entryPath
      && /\.html?$/i.test(project.entryPath)
      && files.has(project.entryPath)
      ? project.entryPath
      : findEntry(files);
    if (!entry) {
      return fail('NO_ENTRY', 400, { message: '项目中没有可发布的 HTML 文件，无法刷新' });
    }

    const deploy = await deploySite({
      kv,
      env: context.env,
      provider: project.provider,
      projectId: project.id,
      files,
      entryPath: entry,
      name: project.name,
    });

    project.status = STATUS.READY;
    project.errorCode = null;
    project.entryPath = entry;
    // 游客链接重新计时 10 分钟（登录用户长期有效，随部署 TTL）
    project.expiresAt = isGuestLimited(user)
      ? nowSeconds() + GUEST_LINK_TTL_SECONDS
      : deploy.expiresAt;
    if (deploy.deploymentUrl) project.deploymentUrl = deploy.deploymentUrl;
    // 持久化：内存对象不会自动写回 KV（历史缺陷：刷新后列表/状态读到的仍是旧记录）
    await kvPut(kv, keys.project(project.id), project);
    await appendLog(kv, { projectId: project.id, step: 'refresh', result: 'ok', duration: Date.now() - started });

    return ok({ project });
  } catch (error) {
    project.status = STATUS.FAILED;
    project.errorCode = error.code || 'STORAGE_ERROR';
    try { await kvPut(kv, keys.project(project.id), project); } catch { /* 持久化失败不掩盖原始错误 */ }
    await appendLog(kv, { projectId: project.id, step: 'refresh', result: 'failed', errorCode: error.code, duration: Date.now() - started });
    return fail(error.code || 'STORAGE_ERROR', 500, { message: error.message });
  }
}
