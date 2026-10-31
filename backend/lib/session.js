// 会话 / 鉴权中间件
import { getKV, kvGet, kvPut, kvDel, kvListAll, keys, nowSeconds } from './kv.js';
import { SESSION_TTL_SECONDS } from './state.js';
import { fail } from './responses.js';
import { tierOf, isVIPUser as tierIsVIP, isGuestLimited as tierGuestLimited } from './tiers.js';

// 等级判定统一从 tiers.js 转发，避免「同一规则写三份」导致漂移
export { tierOf };

export function bearerToken(request) {
  // 优先自定义头：ModelScope 网关会把 Authorization 误判为 SDK Token 并拦截
  const custom = request.headers.get('x-pagemake-token');
  if (custom && custom.trim()) return custom.trim();
  // 兼容标准 Authorization（自建反代 / 其他环境）
  const auth = request.headers.get('Authorization') || request.headers.get('authorization') || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

export function publicBan(user) {
  return {
    level: user.banLevel ?? 1,
    reason: user.banReason ?? '',
    until: user.banUntil ? new Date(user.banUntil * 1000).toISOString() : null,
    permanent: !user.banUntil,
  };
}

/**
 * 封禁中判断（status=banned 且未到解封时间）
 * 所有登录入口（邮箱/Google/游客）在签发会话前都必须调用，保证「解封前无法登录」
 */
export function isBanned(user) {
  if (!user || user.status !== 'banned') return false;
  return !user.banUntil || user.banUntil > nowSeconds();
}

/**
 * VIP 及以上（vip / svip / ultra）。
 * isTest 仅为历史账号只读兼容；新建账号统一写 role。
 */
export function isVIPUser(user) {
  return tierIsVIP(user);
}

/**
 * 账号类型：普通、各等级、游客。
 *
 * 游客身份与等级是两个维度：管理员可以把一个 guest_ 账号升级为 vip/svip/ultra，
 * 此时 userId 仍是 guest_ 前缀（保留原项目与会话），但所有游客限制必须解除。
 * 因此不能在任何业务里只看 userId 前缀判断游客权益。
 *
 * 返回值保持旧形态（guest / guest-vip / vip / user）用于既有 UI 文案，
 * 高等级用 `guest-svip` / `svip` / `ultra` 表示。
 */
export function accountKind(user) {
  const guest = Boolean(user?.userId?.startsWith('guest_'));
  const tier = tierOf(user);
  if (tier === 'user') return guest ? 'guest' : 'user';
  return guest ? `guest-${tier}` : tier;
}

/** 是否仍受游客试用规则限制（项目数 / 链接 10 分钟 / 禁用项目模式）。 */
export function isGuestLimited(user) {
  return tierGuestLimited(user);
}

/**
 * 校验登录态 + 封号状态
 * @returns {Promise<{user, session, kv}|{error: Response}>}
 */
export async function requireAuth(context) {
  let kv;
  try {
    kv = getKV(context.env);
  } catch (error) {
    return { error: fail('STORAGE_ERROR', 500, { message: error.message }) };
  }

  // 开发/自托管调试：DEV_NO_AUTH=1 时跳过鉴权（仅本地测试，生产环境必须不设置）
  if (context.env?.DEV_NO_AUTH === '1') {
    // 调试模式可用 X-Test-User 指定身份（仅用于测试游客限制等按用户分支的逻辑）
    const testUser = context.request.headers.get('x-test-user') || 'dev-user';
    // 若磁盘 KV 里已有该用户的真实记录，优先用它——否则 DEV_NO_AUTH 下
    // 永远拿到 role=user，没法测试 VIP/SVIP/Ultra 分支（也不会影响生产，
    // 这段只在 DEV_NO_AUTH=1 时执行）。
    const stored = await kvGet(kv, keys.user(testUser));
    if (stored) {
      return {
        user: stored,
        session: { userId: testUser, expiresAt: Number.MAX_SAFE_INTEGER },
        kv,
      };
    }
    return {
      user: { userId: testUser, email: 'dev@local', status: 'active', banLevel: 0, banUntil: null, banReason: null },
      session: { userId: testUser, expiresAt: Number.MAX_SAFE_INTEGER },
      kv,
    };
  }

  const token = bearerToken(context.request);
  if (!token) return { error: fail('UNAUTHORIZED', 401) };

  const session = await kvGet(kv, keys.session(token));
  if (!session || session.expiresAt < nowSeconds()) {
    return { error: fail('UNAUTHORIZED', 401) };
  }

  const user = await kvGet(kv, keys.user(session.userId));
  if (!user) return { error: fail('UNAUTHORIZED', 401) };

  if (user.status === 'banned' && (!user.banUntil || user.banUntil > nowSeconds())) {
    return { error: fail('BANNED', 403, { ban: publicBan(user) }) };
  }

  return { user, session, kv };
}

// 创建会话凭证（有效期 7 天）
export async function createSession(kv, userId) {
  const token = (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, '');
  const expiresAt = nowSeconds() + SESSION_TTL_SECONDS;
  await kvPut(kv, keys.session(token), { userId, createdAt: nowSeconds(), expiresAt });
  await kvPut(kv, keys.userSession(userId, token), {
    token,
    userId,
    createdAt: nowSeconds(),
    expiresAt,
  });
  return { token, expiresAt };
}

/**
 * 精确注销用户全部会话（删号/后台强制下线）。
 *
 * 早期实现通过 kvListAll('session_') 全表扫描，但该前缀是 `session_`，
 * 不会命中管理员 `admin_session_`；同时依赖底层 list 与全量读取，成本高。
 * 新会话同时写 `usession_<user>_<token>` 索引，这里按用户前缀精确清理。
 * 兼容旧会话：仅对当前用户做一次受限回扫，无法识别其他用户。
 */
export async function revokeUserSessions(kv, userId) {
  const prefix = keys.userSessionPrefix(userId);
  for (const key of await kvListAll(kv, prefix)) {
    const record = await kvGet(kv, key);
    if (record?.token) await kvDel(kv, keys.session(record.token));
    await kvDel(kv, key);
  }

  // 兼容索引上线前签发的存量会话。
  for (const key of await kvListAll(kv, 'session_')) {
    const record = await kvGet(kv, key);
    if (record?.userId === userId) await kvDel(kv, key);
  }
}
