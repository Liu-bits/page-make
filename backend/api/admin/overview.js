// GET /api/admin/overview — 后台总览（需 X-Admin-Token）
// 返回：账户统计 + 用户列表（含封禁状态/等级/占用/VIP 申请）+ 项目列表 + 反馈列表
// 合规说明：仅显示 userId / 邮箱 / 项目元信息，不展示项目内容与密码
//
// 字段只增不删：后台页面已按「一张账号表」重做，这里额外补齐
// provider（Apple/Google/游客）、bytes（占用）、backendProjectCount、
// vipRequest（申请关联）、banned（当前是否在封禁期内）等增量字段，
// 老字段（role / accountKind / projectCount / legacyIsTest …）保持不变。
//
// 性能：只读 user_ / project_ / feedback_ / vipreq_ 四类记录，不碰 site_ 文件
// （site_ 是每个项目每个文件的独立键，读全量会让后台首屏几十秒）。
import { kvListAll } from '../../lib/kv.js';
import { ok, fail } from '../../lib/responses.js';
import { requireAdmin } from '../../lib/admin.js';
import { accountKind, isVIPUser } from '../../lib/session.js';
import { quotaFor, tierOf } from '../../lib/tiers.js';
import { BAN_LEVELS, isBackendKind } from '../../lib/state.js';

/** 账号来源：guest_ / google_ 前缀有明确语义，其余是 Sign in with Apple 的 sub */
function providerOf(userId) {
  if (typeof userId !== 'string') return 'unknown';
  if (userId.startsWith('guest_')) return 'guest';
  if (userId.startsWith('google_')) return 'google';
  return 'apple';
}

/** 当前是否仍在封禁期内（status=banned 且未到期；无 banUntil 视为永久） */
function isBannedNow(u, now) {
  if (u.status !== 'banned') return false;
  return !u.banUntil || u.banUntil > now;
}

function publicUser(u, now) {
  const kind = accountKind(u);
  const tier = tierOf(u);
  const banned = isBannedNow(u, now);
  const quota = quotaFor(u);
  return {
    userId: u.userId,
    email: u.email ?? null,
    isGuest: Boolean(u.userId?.startsWith('guest_')),
    // role 保留给旧后台脚本；真实等级看 tier
    role: isVIPUser(u) ? tier : 'user',
    tier,
    accountKind: kind,
    provider: providerOf(u.userId),
    status: u.status ?? 'active',
    banned,
    banLevel: u.banLevel ?? 0,
    banReason: u.banReason ?? null,
    banUntil: u.banUntil ?? null,
    banCount: u.banCount ?? 0,
    createdAt: u.createdAt ?? null,
    lastLoginAt: u.lastLoginAt ?? null,
    projectCount: u._projectCount ?? 0,
    backendProjectCount: u._backendProjectCount ?? 0,
    hasBackendProject: (u._backendProjectCount ?? 0) > 0,
    bytes: u._bytes ?? 0,
    // 等级配额（字节；null = 无上限，JSON 不能表示 Infinity）
    quotaBytes: Number.isFinite(quota) ? quota : null,
  };
}

export async function onRequest(context) {
  const { request } = context;
  if (request.method !== 'GET') return fail('METHOD_NOT_ALLOWED', 405);
  const auth = await requireAdmin(context);
  if (auth.error) return auth.error;
  const { kv } = auth;
  const now = Math.floor(Date.now() / 1000);

  // ---- 用户（user_ 前缀）----
  const users = [];
  const userKeys = await kvListAll(kv, 'user_');
  const projectCountByUser = new Map();
  const backendCountByUser = new Map();
  const bytesByUser = new Map();

  // ---- 项目（project_ 前缀）----
  const projectKeys = await kvListAll(kv, 'project_');
  const projects = [];
  for (const key of projectKeys) {
    const p = await kv.get(key, { type: 'json' });
    if (!p) continue;
    const size = Number(p.size) || 0;
    projects.push({
      id: p.id,
      userId: p.userId,
      name: p.name ?? null,
      kind: p.kind ?? 'static',
      status: p.status,
      sourceType: p.sourceType ?? null,
      fileCount: p.fileCount ?? 0,
      size,
      createdAt: p.createdAt ?? null,
      updatedAt: p.updatedAt ?? null,
      expiresAt: p.expiresAt ?? null,
      errorCode: p.errorCode ?? null,
    });
    if (p.userId) {
      projectCountByUser.set(p.userId, (projectCountByUser.get(p.userId) || 0) + 1);
      bytesByUser.set(p.userId, (bytesByUser.get(p.userId) || 0) + size);
      if (isBackendKind(p.kind)) {
        backendCountByUser.set(p.userId, (backendCountByUser.get(p.userId) || 0) + 1);
      }
    }
  }
  projects.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  // ---- VIP 升级申请（vipreq_ 前缀，按用户索引）----
  const vipRequestByUser = new Map();
  for (const key of await kvListAll(kv, 'vipreq_')) {
    const record = await kv.get(key, { type: 'json' });
    if (record?.userId) vipRequestByUser.set(record.userId, record);
  }

  for (const key of userKeys) {
    const u = await kv.get(key, { type: 'json' });
    if (!u) continue;
    u._projectCount = projectCountByUser.get(u.userId) || 0;
    u._backendProjectCount = backendCountByUser.get(u.userId) || 0;
    u._bytes = bytesByUser.get(u.userId) || 0;
    const publicRecord = publicUser(u, now);
    publicRecord.legacyIsTest = Boolean(u.isTest);
    publicRecord.vipSince = u.vipSince ?? null;

    const req = vipRequestByUser.get(u.userId);
    publicRecord.vipRequest = req
      ? {
          status: req.status ?? null,
          note: req.note ?? null,
          createdAt: req.createdAt ?? null,
          reviewedAt: req.reviewedAt ?? null,
          reviewNote: req.reviewNote ?? null,
          linksRenewed: req.linksRenewed ?? 0,
        }
      : null;
    users.push(publicRecord);
  }
  users.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  // ---- 反馈（feedback_ 前缀）----
  const feedback = [];
  for (const key of await kvListAll(kv, 'feedback_')) {
    const f = await kv.get(key, { type: 'json' });
    if (f) feedback.push(f);
  }
  feedback.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  // ---- VIP 升级申请列表（保留旧字段形态，供旧客户端/脚本使用）----
  const vipRequests = [];
  for (const record of vipRequestByUser.values()) {
    const user = users.find((item) => item.userId === record.userId);
    vipRequests.push({
      ...record,
      email: user?.email ?? null,
      accountKind: user?.accountKind ?? record.accountKind ?? null,
      role: user?.role ?? null,
      tier: user?.tier ?? null,
      projectCount: user?.projectCount ?? 0,
      userStatus: user?.status ?? null,
    });
  }
  vipRequests.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  const activeBanned = users.filter((u) => u.banned).length;
  const totalBytes = projects.reduce((sum, p) => sum + p.size, 0);

  return ok({
    stats: {
      userCount: users.length,
      guestCount: users.filter((u) => u.isGuest).length,
      vipCount: users.filter((u) => u.tier === 'vip').length,
      svipCount: users.filter((u) => u.tier === 'svip').length,
      ultraCount: users.filter((u) => u.tier === 'ultra').length,
      // 后端形态有三种：npm / pnpm / js（js 不要求 package.json），都要计入
      // 形态判定统一走 isBackendKind（枚举 npm/pnpm/js 的写法在新增形态时必漏——
      // 与 restoreAll 的 js 形态漏恢复同类教训）
      backendProjectCount: projects.filter((p) => isBackendKind(p.kind)).length,
      projectCount: projects.length,
      feedbackCount: feedback.length,
      vipRequestCount: vipRequests.filter((item) => item.status === 'pending').length,
      // ---- 增量字段 ----
      bannedCount: activeBanned,
      bannedTotal: users.filter((u) => u.status === 'banned').length,
      banExpiredCount: users.filter((u) => u.status === 'banned' && !u.banned).length,
      appleCount: users.filter((u) => u.provider === 'apple').length,
      googleCount: users.filter((u) => u.provider === 'google').length,
      backendUserCount: users.filter((u) => u.hasBackendProject).length,
      totalBytes,
      banLevels: Object.fromEntries(
        Object.entries(BAN_LEVELS).map(([key, value]) => [key, { days: value.days, label: value.label }]),
      ),
    },
    users: users.slice(0, 500),
    projects: projects.slice(0, 500),
    feedback: feedback.slice(0, 200),
    vipRequests: vipRequests.slice(0, 200),
  });
}
