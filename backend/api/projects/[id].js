// GET /api/projects/:id — 项目详情
// POST /api/projects/:id — action: delete（删除）/ rename（重命名）
// DELETE /api/projects/:id — 删除项目（兼容；ModelScope 网关拦截 DELETE，客户端走 POST）
import { getOwnedProject, deleteProjectRecords, syncProjectFiles } from '../../lib/project.js';
import { ok, fail } from '../../lib/responses.js';
import { appendLog } from '../../lib/kv.js';

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

  return fail('METHOD_NOT_ALLOWED', 405);
}
