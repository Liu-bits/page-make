// 密码哈希：PBKDF2-SHA256（Web Crypto，容器与边缘环境通用）
// 存储格式：{ hash: hex, salt: hex, iterations: number }
const ITERATIONS = 120_000;
const KEY_BITS = 256;

function toHex(bytes) {
  return Array.from(new Uint8Array(bytes)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** 生成密码哈希（新注册时调用） */
export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    key,
    KEY_BITS
  );
  return { hash: toHex(bits), salt: toHex(salt), iterations: ITERATIONS };
}

/** 校验密码（登录时调用，恒定时间比较） */
export async function verifyPassword(password, stored) {
  if (!stored?.hash || !stored?.salt) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: fromHex(stored.salt), iterations: stored.iterations || ITERATIONS, hash: 'SHA-256' },
    key,
    KEY_BITS
  );
  const actual = toHex(bits);
  const expected = stored.hash;
  // 恒定时间比较，避免时序侧信道
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) {
    diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

/** 邮箱 → 稳定 userId（email_<sha256 前 24 位十六进制>） */
export async function userIdFromEmail(email) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(email.trim().toLowerCase()));
  return `email_${toHex(digest).slice(0, 24)}`;
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 72;
