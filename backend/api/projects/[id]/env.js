// GET  /api/projects/:id/env — 读取后端项目自定义环境变量（仅归属者）
// POST /api/projects/:id/env — 整体覆盖写入（body: { env: { KEY: "value" } }）
//
// 只有后端形态（npm / pnpm / js / bun）有意义：静态项目没有进程可注入。
// 写入后进程仍跑旧 env，所以后端项目会标 processing 并在后台重新构建一次。

import { getOwnedProject, syncProjectFilesLocked } from '../../../lib/project.js';
import { ok, fail } from '../../../lib/responses.js';
import { STATUS, isBackendKind, normalizeKind } from '../../../lib/state.js';
import { atLeast, tierOf } from '../../../lib/tiers.js';
import { deployBackendApp, stop as stopBackendApp } from '../../../lib/backend-runtime.js';
import {
  validateEnv,
  readProjectEnv,
  writeProjectEnv,
  ENV_MAX_KEYS,
  ENV_MAX_VALUE_BYTES,
} from '../../../lib/project-env.js';

export async function onRequest(context) {
  const { request, params } = context;
  const result = await getOwnedProject(context, params?.id);
  if (result.error) return result.error;
  const { project, kv, user } = result;

  const kind = normalizeKind(project.kind);
  if (!isBackendKind(kind)) {
    return fail('ENV_ONLY_BACKEND', 400, { message: '只有后端项目可以设置环境变量' });
  }
  if (!atLeast(user, 'vip')) return fail('BACKEND_REQUIRES_VIP', 403);

  if (request.method === 'GET') {
    const env = await readProjectEnv(kv, project.id);
    return ok({
      env,
      limits: { maxKeys: ENV_MAX_KEYS, maxValueBytes: ENV_MAX_VALUE_BYTES },
    });
  }
  if (request.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 405);

  let body;
  try {
    body = await request.json();
  } catch {
    return fail('BAD_REQUEST', 400);
  }

  const checked = validateEnv(body?.env);
  if (checked.error) return fail(checked.error, 400, { message: checked.message });

  await writeProjectEnv(kv, project.id, checked.env);

  // 已下架项目不允许改 env：先复核再落盘，顺序不能反——
  // 否则封禁项目的归属者仍能把变量写进 KV（只是不重建），改动已生效却没有提示。
  if (project.status === 'banned') return fail('PROJECT_BANNED', 403);

  // env 只在进程启动时读取：改完必须重建，否则用户以为改了其实没生效。
  // 用 syncProjectFilesLocked 而不是 mutateProject：前者带 banned 守卫，
  // 回写期间账号刚被封禁时返回 null（不会把 banned 覆盖回 processing）。
  const updated = await syncProjectFilesLocked(kv, project.id, {
    status: STATUS.PROCESSING,
    errorCode: null,
  });
  if (!updated) return fail('PROJECT_BANNED', 403);

  const task = (async () => {
    try {
      const runtime = await deployBackendApp({
        kv,
        projectId: project.id,
        kind,
        tier: tierOf(user),
      });
      const done = await syncProjectFilesLocked(kv, project.id, {
        status: STATUS.READY,
        errorCode: null,
        runtimePort: runtime.port,
        runtimeKind: runtime.kind,
      });
      if (!done) await stopBackendApp(project.id);
    } catch (error) {
      await stopBackendApp(project.id);
      await syncProjectFilesLocked(kv, project.id, {
        status: STATUS.FAILED,
        errorCode: error?.code || 'RUNTIME_UNAVAILABLE',
      });
    }
  })().catch(() => {});

  if (typeof context.waitUntil === 'function') context.waitUntil(task);
  else await task;

  return ok({ saved: true, count: Object.keys(checked.env).length, rebuilding: true });
}
