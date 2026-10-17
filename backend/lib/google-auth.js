// Google ID Token 校验（Web Crypto，与 Apple 登录同构）
// 流程：iOS 端 OAuth 拿到 id_token → 本文件验签（Google JWKS）→ 提取 userId(sub)
// 环境变量：GOOGLE_CLIENT_ID（iOS OAuth 客户端 ID，作为 aud 校验）
import { base64urlToBytes } from './base64.js';

const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const JWKS_TTL_MS = 60 * 60 * 1000;
const VALID_ISS = ['accounts.google.com', 'https://accounts.google.com'];

let jwksCache = { fetchedAt: 0, keys: [] };

async function fetchGoogleKeys() {
  const now = Date.now();
  if (jwksCache.keys.length && now - jwksCache.fetchedAt < JWKS_TTL_MS) {
    return jwksCache.keys;
  }
  const response = await fetch(JWKS_URL);
  if (!response.ok) {
    throw Object.assign(new Error('GOOGLE_JWKS_FETCH_FAILED'), { code: 'AUTH_ERROR' });
  }
  const data = await response.json();
  jwksCache = { fetchedAt: now, keys: data.keys || [] };
  return jwksCache.keys;
}

function decodeJwt(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) {
    throw Object.assign(new Error('INVALID_JWT_FORMAT'), { code: 'AUTH_ERROR' });
  }
  const header = JSON.parse(new TextDecoder().decode(base64urlToBytes(parts[0])));
  const payload = JSON.parse(new TextDecoder().decode(base64urlToBytes(parts[1])));
  return { header, payload, signingInput: `${parts[0]}.${parts[1]}`, signature: base64urlToBytes(parts[2]) };
}

/**
 * 校验 Google id_token
 * @param {string} token  id_token（JWT）
 * @param {object} options { clientId }
 * @returns {Promise<{sub: string, email: string|null, name: string|null}>}
 */
export async function verifyGoogleIdentityToken(token, options = {}) {
  const { clientId } = options;
  const { header, payload, signingInput, signature } = decodeJwt(token);

  if (header.alg !== 'RS256') {
    throw Object.assign(new Error('GOOGLE_INVALID_ALG'), { code: 'AUTH_ERROR' });
  }
  if (!VALID_ISS.includes(payload.iss)) {
    throw Object.assign(new Error('GOOGLE_INVALID_ISS'), { code: 'AUTH_ERROR' });
  }
  if (clientId && payload.aud !== clientId) {
    throw Object.assign(new Error('GOOGLE_INVALID_AUD'), { code: 'AUTH_ERROR' });
  }
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === 'number' && payload.exp < now) {
    throw Object.assign(new Error('GOOGLE_TOKEN_EXPIRED'), { code: 'AUTH_ERROR' });
  }

  const keys = await fetchGoogleKeys();
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    throw Object.assign(new Error('GOOGLE_KEY_NOT_FOUND'), { code: 'AUTH_ERROR' });
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
    throw Object.assign(new Error('GOOGLE_INVALID_SIGNATURE'), { code: 'AUTH_ERROR' });
  }

  return {
    sub: payload.sub,
    email: payload.email || null,
    name: payload.name || null,
  };
}
