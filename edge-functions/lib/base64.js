// base64 / base64url 编解码（不依赖 atob/btoa，兼容边缘函数环境）
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = {};
for (let i = 0; i < B64.length; i++) B64_INDEX[B64[i]] = i;

export function bytesToBase64(bytes) {
  const out = [];
  const len = bytes.length;
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < len ? bytes[i + 1] : 0;
    const b2 = i + 2 < len ? bytes[i + 2] : 0;
    out.push(B64[(b0 >> 2) & 63]);
    out.push(B64[((b0 << 4) | (b1 >> 4)) & 63]);
    out.push(i + 1 < len ? B64[((b1 << 2) | (b2 >> 6)) & 63] : '=');
    out.push(i + 2 < len ? B64[b2 & 63] : '=');
  }
  return out.join('');
}

export function base64ToBytes(b64) {
  const clean = String(b64).replace(/[^A-Za-z0-9+/]/g, '');
  const len = Math.floor((clean.length * 3) / 4);
  const bytes = new Uint8Array(len);
  let byteIndex = 0;
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < clean.length && byteIndex < len; i++) {
    buffer = (buffer << 6) | B64_INDEX[clean[i]];
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[byteIndex++] = (buffer >> bits) & 0xff;
    }
  }
  return bytes;
}

export function base64ToText(b64) {
  return new TextDecoder().decode(base64ToBytes(b64));
}

export function textToBase64(text) {
  return bytesToBase64(new TextEncoder().encode(text));
}

// base64url → base64（JWT 用）
export function base64urlToBytes(value) {
  let s = String(value).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4 !== 0) s += '=';
  return base64ToBytes(s);
}

// KV key 可逆编码（UTF-8 → 十六进制，只含 [0-9a-f]，符合 KV key 规则）
export function encodeKey(input) {
  const bytes = new TextEncoder().encode(String(input));
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function decodeKey(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return new TextDecoder().decode(bytes);
}
