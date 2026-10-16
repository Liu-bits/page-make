// GET /api/projects — 我的项目列表（按创建时间倒序）
import { requireAuth } from '../lib/session.js';
import { kvGet, kvListAll, keys } from '../lib/kv.js';
import { ok, fail } from '../lib/responses.js';

export async function onRequest(context) {
  const { request } = context;
  const auth = await requireAuth(context);
  if (auth.error) return auth.error;
  if (request.method !== 'GET') return fail('METHOD_NOT_ALLOWED', 405);

  const indexKeys = await kvListAll(auth.kv, keys.userProject(auth.user.userId, ''));
  const projects = [];
  for (const key of indexKeys) {
    const id = key.slice(keys.userProject(auth.user.userId, '').length);
    const project = await kvGet(auth.kv, keys.project(id));
    if (project) projects.push(project);
  }
  projects.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return ok({ projects });
}
