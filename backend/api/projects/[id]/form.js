// GET  /api/projects/:id/form — 表单提交列表（静态站 /p/<id>/__form 收集的数据）
// POST /api/projects/:id/form — { action: 'delete', id } 删单条 / { action: 'clear' } 清空
// 归属天然隔离：key 里编码了 projectId，跨项目 id 读不到对方记录（再核对一层）
import { getOwnedProject } from '../../../lib/project.js';
import { ok, fail } from '../../../lib/responses.js';
import { kvGet, kvDel, kvListAll, keys } from '../../../lib/kv.js';

export async function onRequest(context) {
  const { request } = context;
  const result = await getOwnedProject(context, context.params?.id);
  if (result.error) return result.error;
  const { project, kv } = result;
  const id = project.id;

  if (request.method === 'GET') {
    const keyList = await kvListAll(kv, keys.formSubmissionPrefix(id));
    const submissions = [];
    for (const key of keyList) {
      const record = await kvGet(kv, key);
      if (record) submissions.push(record);
    }
    submissions.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return ok({ submissions, count: submissions.length });
  }

  if (request.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 405);
  let body;
  try {
    body = await request.json();
  } catch {
    return fail('BAD_REQUEST', 400);
  }

  if (body?.action === 'delete') {
    if (typeof body.id !== 'string' || !body.id) return fail('BAD_REQUEST', 400);
    const record = await kvGet(kv, keys.formSubmission(id, body.id));
    if (!record || record.projectId !== id) return fail('NOT_FOUND', 404);
    await kvDel(kv, keys.formSubmission(id, body.id));
    return ok({ deleted: true });
  }

  if (body?.action === 'clear') {
    const keyList = await kvListAll(kv, keys.formSubmissionPrefix(id));
    for (const key of keyList) await kvDel(kv, key);
    return ok({ cleared: keyList.length });
  }

  return fail('BAD_REQUEST', 400);
}
