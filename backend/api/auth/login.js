// POST /api/auth/login — VIP 账号登录（仅后台发放的 VIP 用户）
// body: { email, password }
import { getKV, kvGet, keys, nowSeconds, appendLog } from '../../lib/kv.js';
import { createSession, publicBan, isBanned, isVIPUser } from '../../lib/session.js';
import { ok, fail } from '../../lib/responses.js';
import { verifyPassword, userIdFromEmail, EMAIL_RE } from '../../lib/password.js';
import { rateLimited, clientIp } from '../../lib/ratelimit.js';

// 登录限速：每 IP 每分钟 8 次（防在线暴力破解/口令枚举）
const LOGIN_LIMIT = 8;
const LOGIN_WINDOW_MS = 60_000;

// 账号不存在时也执行同等代价的 PBKDF2，避免通过响应时间枚举邮箱。
// 这是固定公开值，只用于补齐计算耗时，不能作为任何真实账号的密码。
const DUMMY_PASSWORD_RECORD = {
  hash: 'de304e1a1bbaf62530d8011c3b55b0ad6edf157c5aa39299038352cd0d87807f',
  salt: 'b762c6c5cb9c71840981c2dfe08f8f66',
  iterations: 600_000,
};

export async function onRequest(context) {
  const { request } = context;
  if (request.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 405);

  let body;
  try {
    body = await request.json();
  } catch {
    return fail('BAD_REQUEST', 400);
  }

  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body?.password === 'string' ? body.password : '';

  if (!EMAIL_RE.test(email) || password.length < 1) return fail('INVALID_CREDENTIALS', 401);

  // 限速（按 IP）：防止暴力破解；与后台登录同源实现
  if (rateLimited(`user-login:${clientIp(request)}`, LOGIN_LIMIT, LOGIN_WINDOW_MS)) {
    return fail('TOO_MANY_ATTEMPTS', 429);
  }

  const kv = getKV(context.env);
  const userId = await userIdFromEmail(email);
  const user = await kvGet(kv, keys.user(userId));

  // 用户不存在、非 VIP、密码错误均返回同一错误码，并保持相近耗时
  const mayLogin = Boolean(user?.password) && isVIPUser(user);
  const valid = await verifyPassword(password, mayLogin ? user.password : DUMMY_PASSWORD_RECORD);
  if (!mayLogin || !valid) {
    await appendLog(kv, { step: 'auth_login', result: 'failed', errorCode: 'INVALID_CREDENTIALS' });
    return fail('INVALID_CREDENTIALS', 401);
  }

  // 封禁中禁止登录（管理员解封后才恢复；用户端 BannedView 可见原因/等级/解封时间）
  if (isBanned(user)) {
    return fail('BANNED', 403, { ban: publicBan(user) });
  }

  const session = await createSession(kv, userId);
  await appendLog(kv, { step: 'auth_login', result: 'ok' });

  return ok({
    token: session.token,
    userId,
    email: user.email ?? email,
    expiresAt: new Date(session.expiresAt * 1000).toISOString(),
  });
}
