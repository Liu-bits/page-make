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

// 常见弱密码（top 常见口令 + 键盘/字母序列）：仅长度达标也一律拒绝
const COMMON_PASSWORDS = new Set([
  '123456', '1234567', '12345678', '123456789', '1234567890', '123123123',
  'password', 'password1', 'password123', 'passw0rd', 'qwerty', 'qwerty123',
  'abc123', 'abc12345', 'abcd1234', 'aaaaaaa', 'aaaaaaaa', '11111111', '111111111',
  '00000000', 'iloveyou', 'admin', 'admin123', 'letmein', 'welcome', 'monkey',
  'dragon', 'sunshine', 'princess', 'football', 'baseball', 'shadow', 'master',
  'login', 'changeme', 'secret', 'test123', 'pagemake', 'page-make',
]);

/** 常见词根：带上任意数字/符号后缀也判弱（letmein1 / password2024） */
const COMMON_ROOTS = [
  'password', 'passw0rd', 'qwerty', 'letmein', 'welcome', 'admin', 'login',
  'iloveyou', 'monkey', 'dragon', 'sunshine', 'princess', 'football', 'baseball',
  'shadow', 'master', 'changeme', 'secret', 'pagemake', 'abc123', 'test',
];

/**
 * 前缀/包含匹配用的词根（必须足够长，否则误伤率高）
 *
 * `test`、`admin`、`login`、`secret` 这类短词根不放这里：
 * `Test#Passw0rd1`、`AdminPanel2026` 是合理的自定义密码，
 * 但会被「词根 + 任意尾巴」规则误判成弱口令。短词根只在
 * COMMON_PASSWORDS 精确表里出现（test123 / admin123 整体匹配）。
 */
const PREFIX_ROOTS = COMMON_ROOTS.filter((r) => r.length >= 5);

/**
 * leetspeak 归一化：把常见替换字符还原成字母，用于识别
 * `P@ssw0rd!` / `Qw3rty!23` / `L3tm31n` / `4dm1n2024` 这类变形口令
 *
 * 这些密码此前全部通过校验：它们只替换了个别字符，长度与字符类别都达标，
 * 但实际强度等同原弱口令（字典攻击会先跑替换变体表）。
 * 只做保守映射（一一对应的常见替换），不把任意符号都当字母，
 * 避免把 `A@B#C$` 这类随机串误判成弱口令。
 *
 * 注意：全串归一会污染词根边界——`P@ssw0rd!` 归一成 `passwordi`、
 * `4dm1n2024` 归一成 `adminzoza`，尾部符号/数字被当成字母，反而匹配不上
 * 原词根。所以这里只在「逐字符比较」时用，不做整串 startsWith。
 */
function deLeet(s) {
  const map = { '@': 'a', '4': 'a', '8': 'b', '3': 'e', '1': 'i', '!': 'i', '0': 'o', '$': 's', '5': 's', '7': 't', '+': 't', '9': 'g', '2': 'z' };
  return s.replace(/[@4813!0$57+92]/g, (c) => map[c] || c);
}

/**
 * 逐字符比较：密码前缀是否匹配某词根（允许 leetspeak 替换）
 * 只比对词根长度范围内的字符，尾巴（数字/符号后缀）不参与，
 * 避免尾部字符被归一后污染边界判断
 * @returns {string|null} 匹配上的词根，未匹配返回 null
 */
function matchLeetPrefix(s, root) {
  if (s.length < root.length) return null;
  for (let i = 0; i < root.length; i++) {
    const c = s[i];
    const want = root[i];
    if (c === want) continue;
    // 单个字符的 leetspeak 替换算匹配（0→o / @→a / 3→e / 1→i / 4→a …）
    if (deLeet(c) === want) continue;
    return null;
  }
  return root;
}

/** 是否为「单一字符重复」或「连续递增/递减」的弱模式 */
function isSequentialPattern(password) {
  const s = password.toLowerCase();
  // 单一字符重复（aaaaaaa / 11111111）
  if (/^(.)\1+$/.test(s)) return true;
  // 连续键盘序列（abcdefg / 1234567 …）
  let asc = true;
  let desc = true;
  for (let i = 1; i < s.length; i++) {
    const diff = s.charCodeAt(i) - s.charCodeAt(i - 1);
    if (diff !== 1) asc = false;
    if (diff !== -1) desc = false;
  }
  return asc || desc;
}

// QWERTY 键盘常见弱走法（显式枚举所有方向）
// 说明：试过用「物理坐标 + 相邻距离」判断，但无法同时满足两个方向——
// 要求 1qaz2wsx3edc 被判弱时，Ab1#efgh（b-1-e 恰好也相邻）会被误伤。
// 坐标法在"键盘行走位"这个问题上不存在单一阈值，故回到枚举并补齐方向。
const KEYBOARD_ROWS = [
  // 行：正/反
  '1234567890', '0987654321', 'qwertyuiop', 'poiuytrewq',
  'asdfghjkl', 'lkjhgfdsa', 'zxcvbnm', 'mnbvcxz',
  // 列：qaz / zaq / wes / xsw ...
  'qazwsxedc', 'zaqxswcde', 'wsxedcrfv', 'xswcdevfr',
  'edcrfvtgb', 'cdevfrbgt', 'rfvtgbyhn', 'vfrtgbnyh',
  // 主对角线（左上→右下 / 右下→左上）：1qaz2wsx3edc4rfv 及其反向
  '1qaz2wsx3edc4rfv5tgb', 'bgt5rfv4cde3wsx2zaq1',
  '1q2w3e4r5t6y7u8i9o0p', '0p9o8i7u6y5t4r3e2w1q',
  // 次对角线（左下→右上 / 右上→左下）：Zaq12wsx / Xsw2cde
  'zaq12wsxcde34rfvbgt56ynh7mju8', 'ujm7hny65tgbvfr43edcxsw21qaz',
  'xsw2cde3vfr4bgt5nhy6mju7', 'ujm7yhn5tgb4rfv3edc2wsx',
  // Shift 形态（同一物理键）
  '!qaz@wsx#edc$rfv%tgb', '!qaz@wsx#edc$rfv%tgb^yhn&mju',
];

/** 是否含长度 >= 5 的键盘相邻序列（正/反向） */
function hasKeyboardRun(s) {
  // 数字夹在键盘序列中间很常见（1qaz2wsx / zaq12wsx），剥掉数字再比一次
  const stripped = s.replace(/\d+/g, '');
  for (const row of KEYBOARD_ROWS) {
    const lower = row.toLowerCase();
    for (let len = 5; len <= lower.length; len++) {
      for (let i = 0; i + len <= lower.length; i++) {
        const chunk = lower.slice(i, i + len);
        if (s.includes(chunk) || stripped.includes(chunk)) return true;
        const rev = [...chunk].reverse().join('');
        if (s.includes(rev) || stripped.includes(rev)) return true;
      }
    }
  }
  return false;
}

/**
 * 是否为「短片段重复 >= 2 次」构成
 * Aa1!Aa1!Aa1! / Passw0rdPassw0rd / abcabcabc123 的有效熵远低于其长度，
 * 且是口令生成器最常见产物之一
 */
function isRepeatingChunk(password) {
  const s = password.toLowerCase();
  const n = s.length;
  // 片段长度 3..n/2：短于 3 的"重复"误伤太高（aAaA / 1212 之类）
  for (let len = 3; len <= Math.floor(n / 2); len++) {
    const chunk = s.slice(0, len);
    if (s.split(chunk).length - 1 >= 2) return true;
  }
  return false;
}

/**
 * 密码强度校验（长度之外的第二道关）
 * @returns {{ok: boolean, reason?: string}}
 */
export function checkPasswordStrength(password) {
  if (typeof password !== 'string') return { ok: false, reason: 'WEAK_PASSWORD' };
  // 前后空格必须拒绝：用户以为设的是 Aa1!xyz，实际存的是带空格版本，
  // 登录时少打一个空格就进不去——既混淆又让"看似安全"的密码实际不可用
  if (password !== password.trim()) return { ok: false, reason: 'WEAK_PASSWORD' };
  if (password.length < MIN_PASSWORD_LENGTH) return { ok: false, reason: 'WEAK_PASSWORD' };
  if (password.length > MAX_PASSWORD_LENGTH) return { ok: false, reason: 'WEAK_PASSWORD' };
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    return { ok: false, reason: 'WEAK_PASSWORD_COMMON' };
  }
  const lower = password.toLowerCase();
  // 常见词根 + 数字/符号尾巴：letmein1 / password2024 / qwerty!
  // 只拦「词根 + 最多 1 个额外字母 + 数字尾巴」，避免误伤 PasswordManager2024 这类
  // 逐字符前缀匹配（含 leetspeak 替换）：
  // P@ssw0rd! / p@ssword1 / L3tm31n!x / 4dm1n2024 / Iloveyou123 全部命中
  const isCommonRooted = PREFIX_ROOTS.some((r) => {
    if (!matchLeetPrefix(lower, r)) return false;
    // 尾巴允许：空 / 纯符号 / 数字(可带符号尾巴) / 一个字母+数字
    // 此前只允许「数字尾巴」，导致 Sunshine! / Qw3rty!23 / L3tm31n!x
    // 这类「词根 + 符号尾巴」全部漏过
    const rest = lower.slice(r.length);
    if (rest === '') return true;
    if (/^[^a-z\d]+$/.test(rest)) return true;              // 纯符号尾巴
    if (/^[^a-z\d]+[a-z]$/.test(rest)) return true;          // 符号 + 单个字母（!x）
    if (/^\d+[^a-z\d]*$/.test(rest)) return true;            // 数字 + 可选符号
    if (/^[a-z]\d+[^a-z\d]*$/.test(rest)) return true;       // 一个字母 + 数字
    // 符号在数字前：Qw3rty!23 / L3tm31n!x 这类「词根 + ! + 数字」尾巴
    if (/^[^a-z\d]*\d+[^a-z\d]*$/.test(rest)) return true;
  });
  // 常见口令表也要按 leetspeak 归一后比对（P@ssw0rd / 4dm1n）
  const isCommonExact = COMMON_PASSWORDS.has(lower) || COMMON_PASSWORDS.has(deLeet(lower));
  if (isCommonExact) {
    return { ok: false, reason: 'WEAK_PASSWORD_COMMON' };
  }
  if (isCommonRooted) {
    return { ok: false, reason: 'WEAK_PASSWORD_COMMON' };
  }
  if (isSequentialPattern(password)) {
    return { ok: false, reason: 'WEAK_PASSWORD_PATTERN' };
  }
  // 键盘相邻序列（asdfghjkl / 1qaz2wsx / qwertyuiop …）
  if (hasKeyboardRun(lower)) {
    return { ok: false, reason: 'WEAK_PASSWORD_PATTERN' };
  }
  // 短片段重复构成（Aa1!Aa1!Aa1! / Passw0rdPassw0rd）
  if (isRepeatingChunk(lower)) {
    return { ok: false, reason: 'WEAK_PASSWORD_PATTERN' };
  }
  // 字符类别：字母 + 数字/符号至少两类（纯字母的随机串也偏弱）
  const hasLetter = /[a-z]/i.test(password);
  const hasDigit = /\d/.test(password);
  const hasSymbol = /[^a-z\d]/i.test(password);
  const classes = [hasLetter, hasDigit, hasSymbol].filter(Boolean).length;
  if (classes < 2) return { ok: false, reason: 'WEAK_PASSWORD_SIMPLE' };
  return { ok: true };
}
