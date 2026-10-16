// GET /api/projects/:id — 项目详情
// DELETE /api/projects/:id — 删除项目（文件 + 记录）
import { getOwnedProject, deleteProjectRecords } from '../lib/project.js';
import { ok, fail } from '../lib/responses.js';
import { appendLog } from '../lib/kv.js';

export async function onRequest(context) {
  const { request, params } = context;
  const result = await getOwnedProject(context, params?.id);
  if (result.error) return result.error;
  const { project, kv, user } = result;

  if (request.method === 'GET') {
    return ok({ project });
  }

  if (request.method === 'DELETE') {
    await deleteProjectRecords(kv, user.userId, project.id);
    await appendLog(kv, { projectId: project.id, step: 'delete_project', result: 'ok' });
    return ok({ deleted: true });
  }

  return fail('METHOD_NOT_ALLOWED', 405);
}
