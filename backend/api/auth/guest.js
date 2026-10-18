// POST /api/auth/guest — 游客登录（兜底）
// 场景：免费 Apple ID 无法启用 Sign in with Apple capability（需付费开发者账号），
//       开发/测试阶段用设备 ID 免密登录，功能与 Apple 登录完全一致（含封禁策略）。
// body: { deviceId } — iOS 端生成并持久化在 Keychain 的 UUID
import { getKV, kvGet, kvPut, keys, nowSeconds, appendLog } from '../../lib/kv.js';
import { createSession, publicBan, isBanned } from '../../lib/session.js';
import { ok, fail } from '../../lib/responses.js';

const DEVICE_ID_RE = /^[A-Za-z0-9-]{16,64}$/;

export async function onRequest(context) {
  const { request } = context;
  if (request.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 405);

  let body;
  try {
    body = await request.json();
  } catch {
    return fail('BAD_REQUEST', 400);
  }

  const deviceId = typeof body?.deviceId === 'string' ? body.deviceId.trim() : '';
  if (!DEVICE_ID_RE.test(deviceId)) return fail('BAD_REQUEST', 400);

  const kv = getKV(context.env);

  // userId 由设备 ID 哈希派生（不直接存储设备标识）
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(deviceId));
  const hash = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
  const userId = `guest_${hash.slice(0, 24)}`;

  const user = await kvGet(kv, keys.user(userId));
  if (!user) {
    await kvPut(kv, keys.user(userId), {
      userId,
      email: null,
      status: 'active',
      banLevel: 0,
      banUntil: null,
      banReason: null,
      banCount: 0,
      createdAt: nowSeconds(),
    });
  } else if (isBanned(user)) {
    // 封禁中的游客身份禁止登录（管理员解封后恢复）
    return fail('BANNED', 403, { ban: publicBan(user) });
  }

  const session = await createSession(kv, userId);
  await appendLog(kv, { step: 'auth_guest', result: 'ok' });

  return ok({
    token: session.token,
    userId,
    email: null,
    expiresAt: new Date(session.expiresAt * 1000).toISOString(),
  });
}
