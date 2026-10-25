// POST /api/auth/google — Google 登录（免费 + 真实身份验证）
// body: { idToken } — iOS 端 OAuth 拿到的 Google id_token
// 环境变量：GOOGLE_CLIENT_ID（iOS OAuth 客户端 ID）
import { getKV, kvGet, kvPut, keys, nowSeconds, appendLog } from '../../lib/kv.js';
import { accountKind, createSession, publicBan, isBanned, isVIPUser } from '../../lib/session.js';
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
  } catch (error) {
    // 返回具体原因（JWKS 网络 / 签名 / aud / 过期），便于定位配置问题
    const reason = error?.message || 'INVALID_GOOGLE_TOKEN';
    await appendLog(kv, { step: 'auth_google', result: 'failed', errorCode: reason });
    return fail(reason, 401);
  }

  if (!google.sub) return fail('INVALID_GOOGLE_TOKEN', 401);

  const userId = `google_${google.sub}`;

  let user = await kvGet(kv, keys.user(userId));
  if (!user) {
    user = {
      userId,
      email: google.email,
      name: google.name,
      status: 'active',
      banLevel: 0,
      banUntil: null,
      banReason: null,
      banCount: 0,
      createdAt: nowSeconds(),
    };
    await kvPut(kv, keys.user(userId), user);
  } else if (isBanned(user)) {
    // 封禁中禁止登录（管理员解封后恢复）
    return fail('BANNED', 403, { ban: publicBan(user) });
  }

  const session = await createSession(kv, userId);
  await appendLog(kv, { step: 'auth_google', result: 'ok' });

  return ok({
    token: session.token,
    userId,
    email: google.email,
    role: isVIPUser(user) ? 'vip' : 'user',
    accountKind: accountKind(user),
    expiresAt: new Date(session.expiresAt * 1000).toISOString(),
  });
}
