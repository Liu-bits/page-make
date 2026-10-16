// POST /api/projects/:id/refresh — 刷新链接（EdgeOne 3 小时限制处理）
// 重新部署 → 更新 expiresAt → 返回新链接
import { getOwnedProject, readSiteFiles, syncProjectFiles } from '../../../lib/project.js';
import { deploySite } from '../../../lib/deploy/index.js';
import { appendLog } from '../../../lib/kv.js';
import { ok, fail } from '../../../lib/responses.js';
import { STATUS } from '../../../lib/state.js';

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

    const deploy = await deploySite({
      kv,
      env: context.env,
      provider: project.provider,
      projectId: project.id,
      files,
      entryPath: project.entryPath,
      name: project.name,
    });

    project.status = STATUS.READY;
    project.errorCode = null;
    project.expiresAt = deploy.expiresAt;
    if (deploy.deploymentUrl) project.deploymentUrl = deploy.deploymentUrl;
    await appendLog(kv, { projectId: project.id, step: 'refresh', result: 'ok', duration: Date.now() - started });

    return ok({ project });
  } catch (error) {
    project.status = STATUS.FAILED;
    project.errorCode = error.code || 'STORAGE_ERROR';
    await appendLog(kv, { projectId: project.id, step: 'refresh', result: 'failed', errorCode: error.code, duration: Date.now() - started });
    return fail(error.code || 'STORAGE_ERROR', 500, { message: error.message });
  }
}
