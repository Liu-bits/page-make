// POST /api/auth/google — Google 登录（免费 + 真实身份验证）
// body: { idToken } — iOS 端 OAuth 拿到的 Google id_token
// 环境变量：GOOGLE_CLIENT_ID（iOS OAuth 客户端 ID）
import { getKV, kvGet, kvPut, keys, nowSeconds, appendLog } from '../../lib/kv.js';
import { createSession } from '../../lib/session.js';
import { ok, fail } from '../../lib/responses.js';
import { verifyGoogleIdentityToken } from '../../lib/google-auth.js';

// iOS OAuth 客户端 ID 是公开信息（随 App 分发），作为 aud 校验默认值；
// 可用环境变量 GOOGLE_CLIENT_ID 覆盖（多客户端场景）
const DEFAULT_GOOGLE_CLIENT_ID = '242453650088-qm3mk3l3eg7b8ukraenl0gdufeuvc0dj.apps.googleusercontent.com';

export async function onRequest(context) {
  const { request } = context;
  if (request.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 405);

  let body;
  try {
    body = await request.json();
  } catch {
    return fail('BAD_REQUEST', 400);
  }

  const idToken = typeof body?.idToken === 'string' ? body.idToken : '';
  if (!idToken) return fail('BAD_REQUEST', 400);

  const kv = getKV(context.env);

  let google;
  try {
    google = await verifyGoogleIdentityToken(idToken, {
      clientId: context.env?.GOOGLE_CLIENT_ID || DEFAULT_GOOGLE_CLIENT_ID,
    });
  } catch {
    await appendLog(kv, { step: 'auth_google', result: 'failed', errorCode: 'INVALID_GOOGLE_TOKEN' });
    return fail('INVALID_GOOGLE_TOKEN', 401);
  }

  if (!google.sub) return fail('INVALID_GOOGLE_TOKEN', 401);

  const userId = `google_${google.sub}`;

  const existing = await kvGet(kv, keys.user(userId));
  if (!existing) {
    await kvPut(kv, keys.user(userId), {
      userId,
      email: google.email,
      name: google.name,
      status: 'active',
      banLevel: 0,
      banUntil: null,
      banReason: null,
      banCount: 0,
      createdAt: nowSeconds(),
    });
  }

  const session = await createSession(kv, userId);
  await appendLog(kv, { step: 'auth_google', result: 'ok' });

  return ok({
    token: session.token,
    userId,
    email: google.email,
    expiresAt: new Date(session.expiresAt * 1000).toISOString(),
  });
}
