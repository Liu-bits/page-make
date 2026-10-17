// POST /api/auth/register — 邮箱 + 密码注册（注册成功即登录）
// body: { email, password }
import { getKV, kvGet, kvPut, keys, nowSeconds, appendLog } from '../../lib/kv.js';
import { createSession } from '../../lib/session.js';
import { ok, fail } from '../../lib/responses.js';
import {
  hashPassword, userIdFromEmail, EMAIL_RE, MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH,
} from '../../lib/password.js';

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

  if (!EMAIL_RE.test(email)) return fail('INVALID_EMAIL', 400);
  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    return fail('WEAK_PASSWORD', 400);
  }

  const kv = getKV(context.env);
  const userId = await userIdFromEmail(email);

  const existing = await kvGet(kv, keys.user(userId));
  if (existing) return fail('EMAIL_TAKEN', 409);

  const passwordRecord = await hashPassword(password);
  await kvPut(kv, keys.user(userId), {
    userId,
    email,
    password: passwordRecord,
    status: 'active',
    banLevel: 0,
    banUntil: null,
    banReason: null,
    banCount: 0,
    createdAt: nowSeconds(),
  });

  const session = await createSession(kv, userId);
  await appendLog(kv, { step: 'auth_register', result: 'ok' });

  return ok({
    token: session.token,
    userId,
    email,
    expiresAt: new Date(session.expiresAt * 1000).toISOString(),
  });
}
