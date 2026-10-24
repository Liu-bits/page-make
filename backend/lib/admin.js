// 管理后台辅助：密码存取（PBKDF2，安全随机初始密码，登录后可在后台修改）+ 会话校验 + 登录限速
// 合规说明：封号时强制填写原因与期限，用户端可见，并可通过 App 内反馈申诉（Apple 5.1.1/1.2 要求的替代方式）
import fs from 'node:fs';
import path from 'node:path';
import { kvGet, kvPut, kvDel, keys, nowSeconds } from './kv.js';
import { fail } from './responses.js';
import { hashPassword, verifyPassword, checkPasswordStrength } from './password.js';
import { rateLimited, clientIp } from './ratelimit.js';

const ADMIN_PASSWORD_KEY = 'config_admin_password';
const ADMIN_SESSION_PREFIX = 'admin_session_';
const ADMIN_SESSION_TTL = 24 * 3600; // 24 小时

// 登录限速：每 IP 每分钟 5 次（复用通用限流器，容器重启清零即可）
const ADMIN_LOGIN_LIMIT = 5;
const ADMIN_LOGIN_WINDOW_MS = 60_000;

/** 后台登录限流：按 IP 每 60 秒最多 5 次（防暴力破解管理员密码） */
export function loginRateLimited(request) {
  return rateLimited(`admin-login:${clientIp(request)}`, ADMIN_LOGIN_LIMIT, ADMIN_LOGIN_WINDOW_MS);
}

/** 生成一次性初始管理员密码：16 字符，满足强度规则。 */
function generateInitialPassword() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `Pm!${Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * 管理员密码记录（首次访问时生成随机密码，并仅在首次初始化时打印到容器日志）。
 * 不写固定默认口令，避免公网后台在部署后被直接接管。
 */
async function getPasswordRecord(kv) {
  const existing = await kvGet(kv, keys.config(ADMIN_PASSWORD_KEY));
  if (existing?.hash) return existing;
  const configured = globalThis.process?.env?.PAGEMAKE_ADMIN_INITIAL_PASSWORD;
  const initialPassword = configured && checkPasswordStrength(configured).ok
    ? configured
    : generateInitialPassword();
  const record = await hashPassword(initialPassword);
  await kvPut(kv, keys.config(ADMIN_PASSWORD_KEY), record);
  console.log(`[admin] 初始管理员密码（仅本次初始化输出）：${initialPassword}`);
  return record;
}

export async function verifyAdminPassword(kv, password) {
  const record = await getPasswordRecord(kv);
  return verifyPassword(password, record);
}

/** 兼容旧部署：如果仍在使用历史默认密码 123456，登录时提示改密。 */
export async function isDefaultAdminPassword(kv) {
  const record = await getPasswordRecord(kv);
  return verifyPassword('123456', record);
}

export async function changeAdminPassword(kv, newPassword) {
  // 后台密码同样走强度校验（最低 8 位，原 6 位偏弱）
  const strength = checkPasswordStrength(newPassword);
  if (!strength.ok) throw new Error(strength.reason);
  const record = await hashPassword(newPassword);
  await kvPut(kv, keys.config(ADMIN_PASSWORD_KEY), record);
}

/** 签发管理会话（KV 存储，24 小时有效） */
export async function createAdminSession(kv) {
  const token = (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, '');
  await kvPut(kv, `${ADMIN_SESSION_PREFIX}${token}`, {
    createdAt: nowSeconds(),
    expiresAt: nowSeconds() + ADMIN_SESSION_TTL,
  });
  return token;
}

/**
 * 校验管理会话（请求头 X-Admin-Token）
 * @returns {Promise<{kv}|{error: Response}>}
 */
export async function requireAdmin(context) {
  const token = context.request.headers.get('x-admin-token') || '';
  if (!token) return { error: fail('UNAUTHORIZED', 401) };
  const kv = context.env?.PAGEMAKE;
  if (!kv) return { error: fail('STORAGE_ERROR', 500) };
  const session = await kvGet(kv, `${ADMIN_SESSION_PREFIX}${token}`);
  if (!session || session.expiresAt < nowSeconds()) {
    return { error: fail('UNAUTHORIZED', 401) };
  }
  return { kv };
}

/** 管理会话文件（admin_session_ 前缀不经 encodeKey，纯十六进制 token 作文件名安全） */
export const ADMIN_SESSION_KEY_PREFIX = ADMIN_SESSION_PREFIX;

// admin 页面 HTML 读取（容器内 backend/admin.html 与 lib/ 同级）
let cachedPage = null;
let cachedMtime = 0;
export function adminPageHtml() {
  const file = path.join(process.cwd(), 'backend', 'admin.html');
  try {
    const mtime = fs.statSync(file).mtimeMs;
    if (!cachedPage || mtime !== cachedMtime) {
      cachedPage = fs.readFileSync(file, 'utf8');
      cachedMtime = mtime;
    }
    return cachedPage;
  } catch {
    return '<!DOCTYPE html><html><body><h1>admin.html missing</h1></body></html>';
  }
}
