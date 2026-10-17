// POST /api/auth/login — 邮箱 + 密码登录
// body: { email, password }
import { getKV, kvGet, keys, appendLog } from '../../lib/kv.js';
import { createSession } from '../../lib/session.js';
import { ok, fail } from '../../lib/responses.js';
import { verifyPassword, userIdFromEmail, EMAIL_RE } from '../../lib/password.js';

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

  if (!EMAIL_RE.test(email) || !password) return fail('INVALID_CREDENTIALS', 401);

  const kv = getKV(context.env);
  const userId = await userIdFromEmail(email);
  const user = await kvGet(kv, keys.user(userId));

  // 用户不存在与密码错误返回同一错误码（不泄露账号是否存在）
  if (!user?.password) return fail('INVALID_CREDENTIALS', 401);
  const valid = await verifyPassword(password, user.password);
  if (!valid) {
    await appendLog(kv, { step: 'auth_login', result: 'failed', errorCode: 'INVALID_CREDENTIALS' });
    return fail('INVALID_CREDENTIALS', 401);
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
