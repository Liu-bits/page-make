// 会话 / 鉴权中间件
import { getKV, kvGet, kvPut, keys, nowSeconds } from './kv.js';
import { SESSION_TTL_SECONDS } from './state.js';
import { fail } from './responses.js';

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
    return {
      user: { userId: 'dev-user', email: 'dev@local', status: 'active', banLevel: 0, banUntil: null, banReason: null },
      session: { userId: 'dev-user', expiresAt: Number.MAX_SAFE_INTEGER },
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
  return { token, expiresAt };
}
