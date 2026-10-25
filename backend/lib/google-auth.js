// Google ID Token 校验（Web Crypto，与 Apple 登录同构）
// 流程：iOS 端 OAuth 拿到 id_token → 本文件验签（JWKS 三级加载）→ 提取 userId(sub)
// 环境变量：GOOGLE_CLIENT_ID（iOS OAuth 客户端 ID，作为 aud 校验）
import { base64urlToBytes } from './base64.js';
import { createJwksLoader } from './jwks.js';

// JWKS 加载器：实时拉取（5s 超时）→ DATA_DIR 磁盘缓存 → 内置种子（CI 每日/部署时刷新）
// 境内网络无法访问 googleapis.com 时自动回退种子，登录不受影响
export const googleJwks = createJwksLoader({
  name: 'google',
  // 环境变量 GOOGLE_JWKS_URL 可覆盖（自建反代 / 测试注入），默认官方地址
  url: process.env.GOOGLE_JWKS_URL || 'https://www.googleapis.com/oauth2/v3/certs',
  seedUrl: new URL('../data/google-jwks.json', import.meta.url),
});

function decodeJwt(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) {
    throw Object.assign(new Error('INVALID_JWT_FORMAT'), { code: 'AUTH_ERROR' });
  }
  try {
    const header = JSON.parse(new TextDecoder().decode(base64urlToBytes(parts[0])));
    const payload = JSON.parse(new TextDecoder().decode(base64urlToBytes(parts[1])));
    return { header, payload, signingInput: `${parts[0]}.${parts[1]}`, signature: base64urlToBytes(parts[2]) };
  } catch {
    throw Object.assign(new Error('INVALID_JWT_FORMAT'), { code: 'AUTH_ERROR' });
  }
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
  if (payload.iss !== 'accounts.google.com' && payload.iss !== 'https://accounts.google.com') {
    throw Object.assign(new Error('GOOGLE_INVALID_ISS'), { code: 'AUTH_ERROR' });
  }
  if (clientId && payload.aud !== clientId) {
    throw Object.assign(new Error('GOOGLE_INVALID_AUD'), { code: 'AUTH_ERROR' });
  }
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === 'number' && payload.exp < now) {
    throw Object.assign(new Error('GOOGLE_TOKEN_EXPIRED'), { code: 'AUTH_ERROR' });
  }

  const { keys } = await googleJwks.getKeys();
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
