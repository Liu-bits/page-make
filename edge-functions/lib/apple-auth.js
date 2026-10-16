// Sign in with Apple 身份令牌校验（Web Crypto，纯边缘函数实现）
// 流程：iOS 拿 identityToken(JWT) + nonce → 本文件验签 → 提取 userId(Apple sub)
import { base64urlToBytes, bytesToBase64 } from './base64.js';

const JWKS_URL = 'https://appleid.apple.com/auth/keys';
const JWKS_TTL_MS = 60 * 60 * 1000;

let jwksCache = { fetchedAt: 0, keys: [] };

async function fetchAppleKeys() {
  const now = Date.now();
  if (jwksCache.keys.length && now - jwksCache.fetchedAt < JWKS_TTL_MS) {
    return jwksCache.keys;
  }
  const response = await fetch(JWKS_URL);
  if (!response.ok) {
    throw Object.assign(new Error('APPLE_JWKS_FETCH_FAILED'), { code: 'AUTH_ERROR' });
  }
  const data = await response.json();
  jwksCache = { fetchedAt: now, keys: data.keys || [] };
  return jwksCache.keys;
}

export function decodeJwt(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) {
    throw Object.assign(new Error('INVALID_JWT_FORMAT'), { code: 'AUTH_ERROR' });
  }
  const header = JSON.parse(new TextDecoder().decode(base64urlToBytes(parts[0])));
  const payload = JSON.parse(new TextDecoder().decode(base64urlToBytes(parts[1])));
  return { header, payload, signingInput: `${parts[0]}.${parts[1]}`, signature: base64urlToBytes(parts[2]) };
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 校验 Apple identityToken
 * @param {string} token  identityToken（JWT）
 * @param {object} options { clientId, nonce }
 * @returns {Promise<{sub: string, email: string|null}>}
 */
export async function verifyAppleIdentityToken(token, options = {}) {
  const { clientId, nonce } = options;
  const { header, payload, signingInput, signature } = decodeJwt(token);

  if (header.alg !== 'RS256') {
    throw Object.assign(new Error('APPLE_INVALID_ALG'), { code: 'AUTH_ERROR' });
  }
  if (payload.iss !== 'https://appleid.apple.com') {
    throw Object.assign(new Error('APPLE_INVALID_ISS'), { code: 'AUTH_ERROR' });
  }
  if (clientId && payload.aud !== clientId) {
    throw Object.assign(new Error('APPLE_INVALID_AUD'), { code: 'AUTH_ERROR' });
  }
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === 'number' && payload.exp < now) {
    throw Object.assign(new Error('APPLE_TOKEN_EXPIRED'), { code: 'AUTH_ERROR' });
  }
  if (nonce) {
    const expected = await sha256Hex(nonce);
    if (payload.nonce !== expected) {
      throw Object.assign(new Error('APPLE_INVALID_NONCE'), { code: 'AUTH_ERROR' });
    }
  }

  const appleKeys = await fetchAppleKeys();
  const jwk = appleKeys.find((k) => k.kid === header.kid);
  if (!jwk) {
    throw Object.assign(new Error('APPLE_KEY_NOT_FOUND'), { code: 'AUTH_ERROR' });
  }

  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    signature,
    new TextEncoder().encode(signingInput)
  );
  if (!valid) {
    throw Object.assign(new Error('APPLE_INVALID_SIGNATURE'), { code: 'AUTH_ERROR' });
  }

  return { sub: payload.sub, email: payload.email || null };
}
