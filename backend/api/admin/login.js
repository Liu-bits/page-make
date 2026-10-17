// POST /api/admin/login — 管理员登录（密码验证 → 签发 24h 会话 token）
// body: { password }
// 安全：每 IP 每分钟最多 5 次；密码 PBKDF2 哈希存储（初始 123456，登录后台后请立即修改）
import { getKV } from '../../lib/kv.js';
import { ok, fail } from '../../lib/responses.js';
import { verifyAdminPassword, createAdminSession, loginRateLimited } from '../../lib/admin.js';

export async function onRequest(context) {
  const { request } = context;
  if (request.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 405);

  let body;
  try {
    body = await request.json();
  } catch {
    return fail('BAD_REQUEST', 400);
  }
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!password) return fail('BAD_REQUEST', 400);

  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip') || 'local';
  if (loginRateLimited(ip)) return fail('TOO_MANY_ATTEMPTS', 429);

  const kv = getKV(context.env);
  if (!(await verifyAdminPassword(kv, password))) {
    return fail('WRONG_PASSWORD', 401);
  }

  const token = await createAdminSession(kv);
  return ok({ token, expiresIn: 24 * 3600 });
}
