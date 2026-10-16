// POST /api/projects/:id/files — 添加文件（body: { path, content(base64) }）
// DELETE /api/projects/:id/files — 删除文件（body: { path }）
import { getOwnedProject, syncProjectFiles } from '../../../lib/project.js';
import { keys, kvDel } from '../../../lib/kv.js';
import { base64ToBytes } from '../../../lib/base64.js';
import { ok, fail } from '../../../lib/responses.js';
import { STATUS } from '../../../lib/state.js';

export async function onRequest(context) {
  const { request, params } = context;
  const result = await getOwnedProject(context, params?.id);
  if (result.error) return result.error;
  const { project, kv } = result;

  let body;
  try {
    body = await request.json();
  } catch {
    return fail('BAD_REQUEST', 400);
  }
  const path = body?.path;
  if (typeof path !== 'string' || !path || path.includes('..') || path.startsWith('/')) {
    return fail('BAD_REQUEST', 400);
  }

  if (request.method === 'POST') {
    const content = body?.content;
    if (typeof content !== 'string') return fail('BAD_REQUEST', 400);
    const bytes = base64ToBytes(content);

    await kv.put(keys.siteFile(project.id, path), bytes);
    // 若入口缺失且新增了 html，设为入口
    if (!project.entryPath && /\.html?$/i.test(path)) {
      project.entryPath = path;
    }
    project.status = STATUS.READY;
    await syncProjectFiles(kv, project);
    return ok({ project });
  }

  if (request.method === 'DELETE') {
    await kvDel(kv, keys.siteFile(project.id, path));
    if (project.entryPath === path) project.entryPath = null;
    await syncProjectFiles(kv, project);
    return ok({ project });
  }

  return fail('METHOD_NOT_ALLOWED', 405);
}
