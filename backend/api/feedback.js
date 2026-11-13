// POST /api/feedback — 反馈 / 举报（登录可选，未登录也可提交）
// body: { type: 'feedback'|'report', message, projectId?, errorCode? }
// 举报由人工审核处理（第一版不做自动扫描）
import { getKV, keys, nowSeconds } from '../lib/kv.js';
import { requireAuth } from '../lib/session.js';
import { ok, fail } from '../lib/responses.js';
import { rateLimited, clientIp } from '../lib/ratelimit.js';

// 限流：每 IP 每分钟 10 次（未登录可提交，需防脚本刷量打满 KV）。
// 不用更严的 5 次/分：网关多跳时 clientIp 可能退化成同一个值（见
// lib/ratelimit.js 的风险说明），桶一旦被共用，过严的配额会先误伤正常用户。
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60_000;
// 单条反馈长度上限：防止超长文本撑爆 KV 单值与后台渲染
const MAX_MESSAGE_LENGTH = 2000;

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
  if (message.length > MAX_MESSAGE_LENGTH) return fail('BAD_REQUEST', 400);

  const type = body?.type === 'report' ? 'report' : 'feedback';

  // 限流（按 IP）
  if (rateLimited(`feedback:${clientIp(request)}`, RATE_LIMIT, RATE_WINDOW_MS)) {
    return fail('TOO_MANY_REQUESTS', 429);
  }

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
