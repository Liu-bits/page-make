// GET /api/projects — 我的项目列表（按创建时间倒序）
import { requireAuth } from '../lib/session.js';
import { kvGet, kvListAll, keys } from '../lib/kv.js';
import { decodeKey } from '../lib/base64.js';
import { ok, fail } from '../lib/responses.js';

export async function onRequest(context) {
  const { request } = context;
  const auth = await requireAuth(context);
  if (auth.error) return auth.error;
  if (request.method !== 'GET') return fail('METHOD_NOT_ALLOWED', 405);

  const prefix = keys.userProject(auth.user.userId, '');
  const indexKeys = await kvListAll(auth.kv, prefix);
  const projects = [];
  for (const key of indexKeys) {
    // 索引 key 后缀是编码后的项目 ID，需先解码再查项目记录（避免双重编码）
    const id = decodeKey(key.slice(prefix.length));
    const project = await kvGet(auth.kv, keys.project(id));
    if (project) projects.push(project);
  }
  projects.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return ok({ projects });
}
