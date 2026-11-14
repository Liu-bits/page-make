// POST /api/projects/:id/refresh — 刷新链接（从存储取回文件重新部署）
// 重新部署 → 更新 expiresAt → 返回新链接
import { getOwnedProject, readSiteFiles, syncProjectFilesLocked, mutateProject, projectPublicUrl } from '../../../lib/project.js';
import { deploySite } from '../../../lib/deploy/index.js';
import { deployBackendApp, stop as stopBackendApp } from '../../../lib/backend-runtime.js';
import { findEntry } from '../../../lib/diagnostics.js';
import { appendLog, nowSeconds } from '../../../lib/kv.js';
import { ok, fail } from '../../../lib/responses.js';
import { STATUS, GUEST_LINK_IDLE_SECONDS, isBackendKind, normalizeKind } from '../../../lib/state.js';
import { isGuestLimited } from '../../../lib/session.js';
import { canUseBackend, tierOf } from '../../../lib/tiers.js';

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
      // js 形态（单文件 Node 脚本）没有 package.json 是正常状态，
      // 与 projects/[id].js 的 publish 判定保持一致；漏掉这个例外会让
      // js 项目永远刷新失败（400 MISSING_PACKAGE_JSON）。
      if (kind !== 'js' && !files.has('package.json')) return fail('MISSING_PACKAGE_JSON', 400);

      // 锁内写 processing：与封禁/删除并发时旧快照不会覆盖新状态
      const updated = await syncProjectFilesLocked(kv, project.id, {
        kind,
        entryPath: null,
        status: STATUS.PROCESSING,
        errorCode: null,
        url: projectPublicUrl(new URL(request.url).origin, project.id),
      });
      if (!updated) return fail('NOT_FOUND', 404);

      const refreshTask = (async () => {
        try {
          const runtime = await deployBackendApp({
            kv,
            projectId: project.id,
            kind,
            // 超时/并发配额按当前账号等级取，不用项目记录里的陈旧 tier
            tier: tierOf(user),
          });
          // 刷新期间项目可能被删除 / 再次封禁：锁内复核 + 写回，
          // 只更新仍然存在且未被封禁的记录，不复活旧快照。
          const saved = await syncProjectFilesLocked(kv, project.id, {
            status: STATUS.READY,
            errorCode: null,
            runtimePort: runtime.port,
            runtimeKind: runtime.kind,
            expiresAt: null,
          });
          if (!saved) {
            await stopBackendApp(project.id);
            return;
          }
          await appendLog(kv, {
            projectId: project.id,
            step: 'refresh_backend',
            result: 'ok',
            kind,
            duration: Date.now() - started,
          });
        } catch (error) {
          await stopBackendApp(project.id);
          const saved = await mutateProject(kv, project.id, (record) => {
            if (record.status === 'banned') return false;
            record.status = STATUS.FAILED;
            record.errorCode = error?.code || 'RUNTIME_UNAVAILABLE';
          });
          if (!saved) return;
          await appendLog(kv, {
            projectId: project.id,
            step: 'refresh_backend',
            result: 'failed',
            errorCode: saved.errorCode,
            duration: Date.now() - started,
          });
        }
      })();

      if (typeof context.waitUntil === 'function') {
        context.waitUntil(refreshTask);
      } else {
        await refreshTask;
      }
      return ok({ project: updated });
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

    // 锁内读改写：持久化 + 与封禁/删除并发互斥（历史缺陷：内存对象不写回 KV，
    // 列表/状态读到的仍是旧记录；无锁整记录回写则会覆盖并发变更）
    const updated = await mutateProject(kv, project.id, (record) => {
      // 刷新期间账号可能刚被封禁：封禁下架状态不能被 ready 覆盖
      if (record.status === 'banned') return false;
      record.status = STATUS.READY;
      record.errorCode = null;
      record.entryPath = entry;
      // 游客链接按「连续 7 天无人访问」重新计时（登录用户长期有效）
      record.expiresAt = isGuestLimited(user)
        ? nowSeconds() + GUEST_LINK_IDLE_SECONDS
        : deploy.expiresAt;
      if (deploy.deploymentUrl) record.deploymentUrl = deploy.deploymentUrl;
    });
    if (!updated) return fail('NOT_FOUND', 404);
    await appendLog(kv, { projectId: project.id, step: 'refresh', result: 'ok', duration: Date.now() - started });

    return ok({ project: updated });
  } catch (error) {
    // 项目可能在刷新期间被删除：mutateProject 锁内重读，记录不存在时不写回，
    // 绝不把已删除的项目“复活”（列表/统计凭空多出孤儿记录）。
    try {
      await mutateProject(kv, project.id, (record) => {
        if (record.status === 'banned') return false;
        record.status = STATUS.FAILED;
        record.errorCode = error.code || 'STORAGE_ERROR';
      });
    } catch {
      // 持久化失败不掩盖原始错误
    }
    await appendLog(kv, { projectId: project.id, step: 'refresh', result: 'failed', errorCode: error.code, duration: Date.now() - started });
    // 客户端错误用 4xx（参数/配额/形态问题不是服务端故障），只有存储/运行时才是 500
    const code = error.code || 'STORAGE_ERROR';
    const clientError = ['TOO_LARGE', 'NO_ENTRY', 'INVALID_PROVIDER', 'INVALID_KIND', 'BAD_ZIP', 'MISSING_PACKAGE_JSON', 'BACKEND_REQUIRES_VIP'];
    const status = code === 'TOO_LARGE' ? 413 : (clientError.includes(code) ? 400 : 500);
    return fail(code, status, { message: error.message });
  }
}
