// 站点访问密码门禁：签名 cookie + 密码输入页。
//
// 设计：
// - 密码哈希存项目记录（PBKDF2，复用 lib/password.js），公开路由本来就读过项目，
//   不增加额外 KV 往返；
// - 解锁状态用 HMAC 签名的 cookie（`pm_unlock_<id>`），只对该项目有效，
//   HttpOnly + 7 天有效；不需要为解锁状态再开一个 KV 会话表；
// - HMAC 密钥存 `config_unlock_secret`（首次访问生成，进程重启后从 KV 读回，
//   所以 cookie 不会因为重启而全部失效）。
//
// 纪律：入口页 / 子资源 / 后端反代三处都必须先过这道门，只拦入口页等于没拦
// （css/js/图片和接口都可以绕过入口页直接拿）。

import { createHmac, createHash, timingSafeEqual, randomBytes } from 'node:crypto';
import { kvGet, kvPut, nowSeconds, keys } from './kv.js';

const SECRET_CONFIG_KEY = 'unlock_secret';
const UNLOCK_TTL_SECONDS = 7 * 24 * 3600;
const COOKIE_PREFIX = 'pm_unlock_';

let cachedSecret = null;

/** HMAC 密钥：首次生成并落 KV，之后读缓存 + KV */
export async function getUnlockSecret(kv) {
  if (cachedSecret) return cachedSecret;
  const stored = await kvGet(kv, keys.config(SECRET_CONFIG_KEY));
  if (stored && typeof stored.secret === 'string' && stored.secret.length >= 64) {
    cachedSecret = stored.secret;
    return cachedSecret;
  }
  const secret = randomBytes(32).toString('hex');
  await kvPut(kv, keys.config(SECRET_CONFIG_KEY), { secret, createdAt: nowSeconds() });
  // 并发首访可能生成多个密钥、互相覆盖：以 KV 里**最终**那份为准再缓存，
  // 否则进程内缓存的密钥与 KV 不一致，重启后这一批 cookie 全部失效。
  const settled = await kvGet(kv, keys.config(SECRET_CONFIG_KEY));
  cachedSecret = settled?.secret ?? secret;
  return cachedSecret;
}

function hmac(secret, payload) {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/** 密码哈希的短指纹：进 token 签名，换密码即吊销所有旧 cookie */
function passwordFingerprint(passwordHash) {
  return createHash('sha256').update(String(passwordHash ?? '')).digest('hex').slice(0, 16);
}

function cookieName(projectId) {
  return `${COOKIE_PREFIX}${projectId}`;
}

/**
 * 生成解锁 token：`过期时间.hmac(过期时间+项目ID+密码指纹)`。
 * 签名绑定**当前**密码哈希——管理员/归属者换密码后，持旧密码解锁的 cookie 立即失效。
 */
async function issueToken(kv, projectId, passwordHash) {
  const secret = await getUnlockSecret(kv);
  const exp = nowSeconds() + UNLOCK_TTL_SECONDS;
  const payload = `${exp}|${projectId}|${passwordFingerprint(passwordHash)}`;
  return { token: `${exp}.${hmac(secret, payload)}`, exp };
}

/** 校验 cookie：签名对得上、未过期、且密码指纹仍匹配 */
export async function verifyUnlockCookie(kv, projectId, cookieValue, passwordHash) {
  if (!cookieValue || typeof cookieValue !== 'string') return false;
  const dot = cookieValue.indexOf('.');
  if (dot <= 0) return false;
  const exp = Number(cookieValue.slice(0, dot));
  const sig = cookieValue.slice(dot + 1);
  if (!Number.isFinite(exp) || exp <= nowSeconds()) return false;
  const secret = await getUnlockSecret(kv);
  const expected = hmac(secret, `${exp}|${projectId}|${passwordFingerprint(passwordHash)}`);
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** 当前请求是否已解锁该项目（读 cookie；passwordHash 用于校验密码指纹） */
export async function isUnlocked(kv, projectId, request, passwordHash) {
  const header = request.headers.get('cookie') || '';
  const name = cookieName(projectId);
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) {
      return verifyUnlockCookie(kv, projectId, rest.join('='), passwordHash);
    }
  }
  return false;
}

/** 解锁成功后的 Set-Cookie 值（调用方塞进响应头） */
export async function unlockCookieHeader(kv, projectId, passwordHash) {
  const { token, exp } = await issueToken(kv, projectId, passwordHash);
  return `${cookieName(projectId)}=${token}; HttpOnly; Path=/p/${projectId}; Max-Age=${UNLOCK_TTL_SECONDS}; SameSite=Lax; Secure`;
}

/** Set-Cookie 值（清理解锁状态，用于关闭密码保护后的残留 cookie） */
export function clearCookieHeader(projectId) {
  return `${cookieName(projectId)}=; HttpOnly; Path=/p/${projectId}; Max-Age=0; SameSite=Lax`;
}

/** 密码输入页（401）。自带样式，中英跟随 Accept-Language。 */
export function gateHtml(projectId, request) {
  const en = (request?.headers?.get?.('Accept-Language') || '').toLowerCase().startsWith('en');
  const title = en ? 'This site is protected' : '该站点已开启访问保护';
  const hint = en ? 'Enter the access password to continue.' : '输入访问密码后继续。';
  const btn = en ? 'Unlock' : '解锁';
  const err = en ? 'Wrong password, try again.' : '密码不正确，请重试。';
  const wrong = new URL(request?.url || 'http://x').searchParams.get('e') === '1' ? err : '';
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return `<!doctype html><html lang="${en ? 'en' : 'zh'}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    background:linear-gradient(160deg,#eef1f6,#e3e8f0);color:#1b1f27}
  .card{width:min(420px,92vw);padding:34px 30px;border-radius:18px;background:rgba(255,255,255,.72);
    box-shadow:0 18px 50px rgba(20,26,40,.14);border:1px solid rgba(255,255,255,.6);backdrop-filter:blur(10px)}
  h1{font-size:18px;margin:0 0 6px}
  p{font-size:13px;color:#5b6472;margin:0 0 18px}
  .err{color:#c94141;font-size:12.5px;margin:0 0 12px}
  input{width:100%;box-sizing:border-box;padding:12px 14px;font-size:14px;border-radius:12px;
    border:1px solid #d5dbe6;background:#fff;outline:none}
  input:focus{border-color:#4050d8}
  button{width:100%;margin-top:14px;padding:12px;font-size:14px;font-weight:600;border:0;border-radius:999px;
    background:#4050d8;color:#fff;cursor:pointer}
  button:active{opacity:.85}
</style></head><body><div class="card">
<h1>${esc(title)}</h1><p>${esc(hint)}</p>
${wrong ? `<p class="err">${esc(wrong)}</p>` : ''}
<form method="POST" action="/p/${esc(projectId)}/__unlock">
  <input type="password" name="password" autocomplete="current-password" required autofocus>
  <button type="submit">${esc(btn)}</button>
</form></div></body></html>`;
}
