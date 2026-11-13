// GET  /api/vip-request — 当前等级 / 下一等级 / 最近一次申请状态
// POST /api/vip-request — 申请升级到**下一等级**（user → vip → svip → ultra）
//
// 规则：
// - 只能申请紧邻的下一级，不能跳级；ultra 已到顶 → 409 NO_NEXT_TIER
// - 待审核期间重复提交返回原记录（duplicate: true，不覆盖说明）
// - 被驳回后可重新提交
// - 升级不换账号、不销毁会话；管理员批准后原地写入目标等级，原会话立即生效
import { kvGet, kvPut, keys, nowSeconds } from '../lib/kv.js';
import { requireAuth } from '../lib/session.js';
import { nextTierOf, tierOf } from '../lib/tiers.js';
import { ok, fail } from '../lib/responses.js';
import { rateLimited, clientIp } from '../lib/ratelimit.js';

// 同一 IP 每分钟最多 5 次，按 userId 去重；防止脚本刷单，也不影响正常重试。
const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 60_000;
const MAX_NOTE_LENGTH = 300;
// 待审核申请超过 30 天视为过期，可重新提交
const PENDING_TTL_SECONDS = 30 * 24 * 3600;

function publicRequest(record) {
  if (!record) return null;
  return {
    status: record.status,
    // 新字段名与 iOS 契约一致；targetTier 保留兼容旧客户端
    requestedTier: record.targetTier ?? null,
    targetTier: record.targetTier ?? null,
    note: record.note ?? '',
    createdAt: record.createdAt ?? null,
    reviewedAt: record.reviewedAt ?? null,
    reviewNote: record.reviewNote ?? '',
  };
}

/** 是否已存在针对该等级的、未过期的待审申请 */
function pendingFor(record, tier, now) {
  return Boolean(
    record
    && record.status === 'pending'
    && record.targetTier === tier
    && (!record.createdAt || record.createdAt + PENDING_TTL_SECONDS > now)
  );
}

export async function onRequest(context) {
  const { request } = context;
  const auth = await requireAuth(context);
  if (auth.error) return auth.error;

  const { user, kv } = auth;
  const tier = tierOf(user);
  const nextTier = nextTierOf(user);
  const key = keys.vipRequest(user.userId);
  const existing = await kvGet(kv, key);

  if (request.method === 'GET') {
    return ok({
      tier,
      nextTier,
      canApply: Boolean(nextTier) && !pendingFor(existing, nextTier, nowSeconds()),
      request: publicRequest(existing),
    });
  }
  if (request.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 405);

  // Ultra 已到顶：没有下一等级可申请（客户端此时应隐藏整张卡片）
  if (!nextTier) return fail('NO_NEXT_TIER', 409, { tier });

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

  // 待审核期间重复提交只返回原记录，不覆盖说明；被驳回后可重新申请。
  // 注意不能「批准过就永久禁止再申请」：批准后等级会推进，nextTier 也随之变化，
  // 用户需要能继续申请更高的等级。
  if (pendingFor(existing, nextTier, nowSeconds())) {
    return ok({ request: publicRequest(existing), duplicate: true, tier, nextTier });
  }

  const record = {
    userId: user.userId,
    targetTier: nextTier,
    accountKind: user.userId.startsWith('guest_') ? 'guest' : 'user',
    status: 'pending',
    note,
    createdAt: nowSeconds(),
    reviewedAt: null,
    reviewNote: '',
  };
  // 每用户只有一条 vipreq_ 记录，写入新申请会覆盖上一条。已批准的记录是
  // 「某等级由人工审核通过」的唯一凭据，被覆盖后就再也查不到（后台概览只读
  // vipreq_ 前缀）。覆盖前先归档到 vipreqlog_，保留完整的升级链。
  // 只在覆盖已批准记录时归档：pending 在上面的 duplicate 分支已返回，
  // rejected 允许反复重提，若也归档会按重试次数无意义膨胀。
  if (existing?.status === 'approved') {
    try {
      await kvPut(kv, keys.vipRequestLog(user.userId, existing.reviewedAt || existing.createdAt || nowSeconds()), existing);
    } catch {
      // 归档失败不能挡住用户提交；旧记录最坏情况是被覆盖丢失留档
    }
  }
  await kvPut(kv, key, record);
  return ok({ request: publicRequest(record), submitted: true, tier, nextTier });
}
