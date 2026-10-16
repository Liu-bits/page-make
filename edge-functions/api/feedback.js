// POST /api/feedback — 反馈 / 举报（登录可选，未登录也可提交）
// body: { type: 'feedback'|'report', message, projectId?, errorCode? }
// 举报由人工审核处理（第一版不做自动扫描）
import { getKV, keys, nowSeconds } from '../lib/kv.js';
import { requireAuth } from '../lib/session.js';
import { ok, fail } from '../lib/responses.js';

export async function onRequest(context) {
  const { request } = context;
  if (request.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 405);

  let body;
  try {
    body = await request.json();
  } catch {
    return fail('BAD_REQUEST', 400);
  }
  const message = String(body?.message || '').trim();
  if (!message) return fail('BAD_REQUEST', 400);

  const type = body?.type === 'report' ? 'report' : 'feedback';

  // 可选登录态：带上则记录 userId
  let userId = null;
  try {
    const auth = await requireAuth(context);
    if (!auth.error) userId = auth.user.userId;
  } catch {
    // KV 未配置等情况下忽略
  }

  const kv = getKV(context.env);
  const id = crypto.randomUUID().replace(/-/g, '');
  await kv.put(keys.feedback(id), JSON.stringify({
    id,
    userId,
    projectId: body?.projectId ?? null,
    errorCode: body?.errorCode ?? null,
    type,
    message,
    createdAt: nowSeconds(),
  }));
  return ok({ received: true });
}
