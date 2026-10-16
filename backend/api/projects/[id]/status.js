// GET /api/projects/:id/status — 状态查询（iOS 每 2 秒轮询）
// 返回 status、errorCode、diagnostics（自托管模式无过期，expired 仅作兼容分支）
import { getOwnedProject, projectStatusView } from '../../../lib/project.js';
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
