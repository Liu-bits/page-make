// GET /api/projects/:id/status — 状态查询（iOS 每 2 秒轮询）
// 返回 status、errorCode、diagnostics（EdgeOne 3 小时过期 → expired）
import { getOwnedProject, projectStatusView } from '../../../lib/project.js';
import { kvGet, keys } from '../../../lib/kv.js';
import { ok, fail } from '../../../lib/responses.js';

export async function onRequest(context) {
  const { request, params } = context;
  const result = await getOwnedProject(context, params?.id);
  if (result.error) return result.error;
  const { project } = result;
  if (request.method !== 'GET') return fail('METHOD_NOT_ALLOWED', 405);

  const view = projectStatusView(project);
  return ok({
    ...view,
    project: projectStatusView(project).status === 'expired' ? null : project,
  });
}
