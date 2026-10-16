// POST /api/auth — Sign in with Apple 换会话凭证
// 流程：验 Apple identityToken → 查/建 users → 查封号 → 生成 7 天会话凭证
import { getKV, kvGet, kvPut, keys, nowSeconds, appendLog } from '../lib/kv.js';
import { createSession, publicBan } from '../lib/session.js';
import { verifyAppleIdentityToken } from '../lib/apple-auth.js';
import { ok, fail } from '../lib/responses.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 405);

  let body;
  try {
    body = await request.json();
  } catch {
    return fail('BAD_REQUEST', 400);
  }
  const { identityToken, nonce } = body || {};
  if (!identityToken || !nonce) return fail('BAD_REQUEST', 400);

  let apple;
  try {
    apple = await verifyAppleIdentityToken(identityToken, {
      clientId: env.APPLE_CLIENT_ID,
      nonce,
    });
  } catch {
    return fail('INVALID_APPLE_TOKEN', 401);
  }

  let kv;
  try {
    kv = getKV(env);
  } catch (error) {
    return fail('STORAGE_ERROR', 500, { message: error.message });
  }

  let user = await kvGet(kv, keys.user(apple.sub));
  if (!user) {
    user = {
      userId: apple.sub,
      email: apple.email,
      lastLoginAt: nowSeconds(),
      createdAt: nowSeconds(),
      status: 'active',
      banLevel: 0,
      banUntil: null,
      banReason: null,
      banCount: 0,
    };
  } else {
    user.lastLoginAt = nowSeconds();
    if (apple.email && !user.email) user.email = apple.email;
  }
  await kvPut(kv, keys.user(apple.sub), user);

  if (user.status === 'banned' && (!user.banUntil || user.banUntil > nowSeconds())) {
    return fail('BANNED', 403, { ban: publicBan(user) });
  }

  const session = await createSession(kv, apple.sub);
  await appendLog(kv, { step: 'auth', result: 'ok' });
  return ok({
    token: session.token,
    userId: apple.sub,
    email: apple.email,
    expiresAt: new Date(session.expiresAt * 1000).toISOString(),
  });
}
