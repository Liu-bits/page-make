// GET  /api/vip-request — 当前账号最近的 VIP 升级申请状态
// POST /api/vip-request — 提交 VIP 升级申请（只允许仍受游客限制的账号）
// 升级不会更换账号或删除作品；管理员审核后原地写入 role=vip，原会话立即生效。
import { kvGet, kvPut, keys, nowSeconds } from '../lib/kv.js';
import { requireAuth, isGuestLimited, isVIPUser } from '../lib/session.js';
import { ok, fail } from '../lib/responses.js';
import { rateLimited, clientIp } from '../lib/ratelimit.js';

// 同一 IP 每分钟最多 5 次，按 userId 去重；防止脚本刷单，也不影响正常重试。
const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 60_000;
const MAX_NOTE_LENGTH = 300;
// 待审核申请可撤回后重新提交；已批准记录在后台用于留档。
const PENDING_TTL_SECONDS = 30 * 24 * 3600;

function publicRequest(record) {
  if (!record) return null;
  return {
    status: record.status,
    note: record.note ?? '',
    createdAt: record.createdAt ?? null,
    reviewedAt: record.reviewedAt ?? null,
    reviewNote: record.reviewNote ?? '',
  };
}

export async function onRequest(context) {
  const { request } = context;
  const auth = await requireAuth(context);
  if (auth.error) return auth.error;

  const { user, kv } = auth;
  const key = keys.vipRequest(user.userId);
  const existing = await kvGet(kv, key);

  if (request.method === 'GET') {
    return ok({ request: publicRequest(existing) });
  }
  if (request.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 405);

  if (isVIPUser(user)) return fail('ALREADY_VIP', 409);
  if (!isGuestLimited(user)) return fail('VIP_REQUEST_GUEST_ONLY', 403);

  if (rateLimited(`vip-request:${user.userId}:${clientIp(request)}`, RATE_LIMIT, RATE_WINDOW_MS)) {
    return fail('TOO_MANY_REQUESTS', 429);
  }

  let body = {};
  try {
    body = await request.json();
  } catch {
    // note 可省略
  }
  const note = typeof body?.note === 'string'
    ? body.note.trim().slice(0, MAX_NOTE_LENGTH)
    : '';

  // 已批准后再次申请不应覆盖留档记录；权益已生效，客户端会直接收到 409。
  if (existing?.status === 'approved') return fail('ALREADY_VIP', 409);

  // 待审核期间重复提交只返回原记录，不创建重复工单；被驳回后可重新申请。
  if (existing?.status === 'pending'
      && existing.createdAt
      && existing.createdAt + PENDING_TTL_SECONDS > nowSeconds()) {
    return ok({ request: publicRequest(existing), duplicate: true });
  }

  const record = {
    userId: user.userId,
    accountKind: user.userId.startsWith('guest_') ? 'guest' : 'user',
    status: 'pending',
    note,
    createdAt: nowSeconds(),
    reviewedAt: null,
    reviewNote: '',
  };
  await kvPut(kv, key, record);
  return ok({ request: publicRequest(record), submitted: true });
}
