// GET /api/projects/:id/logs — 后端项目最近运行日志（stdout/stderr 环形缓冲，仅内存）
// 用户在 App 内看「为什么部署失败 / 启动后为什么 503」，不用再猜
import { getOwnedProject } from '../../../lib/project.js';
import { ok, fail } from '../../../lib/responses.js';
import { recentLogs } from '../../../lib/backend-runtime.js';
import { isBackendKind, normalizeKind } from '../../../lib/state.js';

export async function onRequest(context) {
  const { request } = context;
  if (request.method !== 'GET') return fail('METHOD_NOT_ALLOWED', 405);
  const result = await getOwnedProject(context, context.params?.id);
  if (result.error) return result.error;
  const { project } = result;
  if (!isBackendKind(normalizeKind(project.kind))) return fail('LOGS_ONLY_BACKEND', 400);

  // 进程不在跑（容器刚重启 / 未部署）→ logs 为 null，前端展示「暂无日志」
  const logs = recentLogs(project.id);
  return ok({ logs, running: logs !== null });
}
