// =============================================================================
// 管理后台测试套件（本地容器 · 真实 HTTP）
// 覆盖：管理员登录 → VIP 账号创建/删除 → VIP 权益（绕过大小上限）
//       → 封号（项目下架 + 禁止登录）→ 解封（项目恢复 + 可登录）→ 删除账号
// 运行：node dev/test-admin.mjs
// =============================================================================
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PASTE_MAX_BYTES } from '../backend/lib/state.js';
import { encodeKey } from '../backend/lib/base64.js';
import { userIdFromEmail } from '../backend/lib/password.js';

const PORT = 18790;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message || '断言失败');
}
function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || '断言失败'}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${error?.message || error}`);
  }
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pagemake-admin-'));
const legacyEmail = `legacy-${Date.now()}@test.local`;
const legacyUserId = await userIdFromEmail(legacyEmail);
fs.writeFileSync(path.join(dataDir, `user_${encodeKey(legacyUserId)}`), JSON.stringify({
  userId: legacyUserId,
  email: legacyEmail,
  isTest: true,
  status: 'active',
  createdAt: Math.floor(Date.now() / 1000),
}));
const spawnEnv = {
  ...process.env,
  PORT: String(PORT),
  DATA_DIR: dataDir,
  PAGEMAKE_ADMIN_INITIAL_PASSWORD: 'Pm!TestAdmin2026',
};
for (const key of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY']) {
  delete spawnEnv[key];
}
const server = spawn(process.execPath, [path.resolve('docker/server.mjs')], {
  env: spawnEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

async function waitForServer(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return;
    } catch { /* 未启动 */ }
    await sleep(200);
  }
  throw new Error('服务启动超时');
}

async function json(request) {
  const res = await request;
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/** 管理员登录（测试环境用固定初始密码，哈希存储） */
async function adminLogin(password = spawnEnv.PAGEMAKE_ADMIN_INITIAL_PASSWORD) {
  return json(fetch(`${BASE}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  }));
}
const adminAction = (token, body) => json(fetch(`${BASE}/api/admin/action`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Admin-Token': token },
  body: JSON.stringify(body),
}));
const overview = (token) => json(fetch(`${BASE}/api/admin/overview`, {
  headers: { 'X-Admin-Token': token },
}));

async function guestLogin(label) {
  const { status, body } = await json(fetch(`${BASE}/api/auth/guest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: `${label}-${Date.now()}-abcdef` }),
  }));
  assertEqual(status, 200, `创建游客 ${label} 应成功`);
  return { token: body.token, userId: body.userId };
}

async function passwordLogin(email, password) {
  return json(fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  }));
}

async function paste(token, body) {
  return json(fetch(`${BASE}/api/projects/paste`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  }));
}

const bigHtml = (size) => `<html><body><h1>big</h1><!--${'x'.repeat(size)}--></body></html>`;

await waitForServer();
console.log('\n[管理后台]');

// 1. 管理员登录（错误密码拒绝 + 正确密码通过）
await test('管理员登录：错误密码 401，正确密码签发 token', async () => {
  const wrong = await adminLogin('wrong-password');
  assertEqual(wrong.status, 401, '错误密码应 401');
  const ok = await adminLogin();
  assertEqual(ok.status, 200, '正确密码应 200');
  assert(ok.body.token, '应返回后台 token');
  assertEqual(ok.body.mustChangePassword, false, '随机初始密码不应触发旧默认密码横幅');
});

let adminToken = '';
await test('管理员密码为哈希存储（KV 中无明文）', async () => {
  adminToken = (await adminLogin()).body.token;
  const file = path.join(dataDir, 'config_' + Buffer.from('config_admin_password', 'utf8').toString('hex'));
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert(record.hash && record.salt && record.iterations, '密码记录应包含 hash / salt / iterations');
  assertEqual(record.iterations, 600_000, '新管理员密码应使用 60 万轮 PBKDF2');
  assert(!JSON.stringify(record).includes(spawnEnv.PAGEMAKE_ADMIN_INITIAL_PASSWORD), '存储中不得出现明文密码');
});

await test('旧部署默认密码 123456 仍可兼容登录并触发改密提示', async () => {
  const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pagemake-admin-legacy-'));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode('123456'),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 120_000, hash: 'SHA-256' },
    key,
    256
  );
  const legacyRecord = {
    hash: Array.from(new Uint8Array(bits)).map((b) => b.toString(16).padStart(2, '0')).join(''),
    salt: Array.from(salt).map((b) => b.toString(16).padStart(2, '0')).join(''),
    iterations: 120_000,
  };
  fs.writeFileSync(
    path.join(legacyDir, 'config_' + Buffer.from('config_admin_password', 'utf8').toString('hex')),
    JSON.stringify(legacyRecord)
  );
  try {
    const legacyPort = PORT + 1;
    const legacyServer = spawn(process.execPath, [path.resolve('docker/server.mjs')], {
      env: { ...spawnEnv, PORT: String(legacyPort), DATA_DIR: legacyDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      const legacyBase = `http://127.0.0.1:${legacyPort}`;
      for (let i = 0; i < 50; i++) {
        try {
          if ((await fetch(`${legacyBase}/healthz`)).ok) break;
        } catch {}
        await sleep(200);
      }
      const res = await fetch(`${legacyBase}/api/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: '123456' }),
      });
      assertEqual(res.status, 200, '旧默认密码应仍可登录');
      const body = await res.json();
      assertEqual(body.mustChangePassword, true, '旧默认密码应触发改密提示');
    } finally {
      legacyServer.kill();
    }
  } finally {
    fs.rmSync(legacyDir, { recursive: true, force: true });
  }
});

await test('管理后台页面：动态字段统一走安全 DOM 管线', async () => {
  const res = await fetch(`${BASE}/admin`);
  assertEqual(res.status, 200, '后台页面应可访问');
  const html = await res.text();
  assert(html.includes("replace(/'/g,'&#39;')"), '应包含单引号转义');
  assert(html.includes("data-user-id="), '用户操作应使用 data 属性传参');
  assert(!html.includes("onclick=\"banPrompt('${u.userId}')\""), '不得把用户 ID 直接插入 onclick');
  assert(!html.includes("onclick=\"delFeedback('${f.id}')\""), '不得把反馈 ID 直接插入 onclick');
});

await test('创建 VIP 时拒绝弱口令（不会落库）', async () => {
  const weak = ['12345678', 'password', 'qwerty123', 'onlyletters'];
  for (const [index, password] of weak.entries()) {
    const { status, body } = await adminAction(adminToken, {
      action: 'createVIPUser',
      email: `weak-vip-${Date.now()}-${index}@test.local`,
      password,
    });
    assertEqual(status, 400, `弱口令 ${password} 应被拒绝`);
    assert(body.error.startsWith('WEAK_PASSWORD'), `弱口令 ${password} 应返回 WEAK_PASSWORD*`);
  }
});

// 2. VIP：创建 → 登录 → 权益（绕过 300KB 粘贴上限）
const vipEmail = `vip-${Date.now()}@test.local`;
let vipToken = '';

await test('创建 VIP 账号（指定邮箱+密码）', async () => {
  const { status, body } = await adminAction(adminToken, { action: 'createVIPUser', email: vipEmail, password: 'Test#Passw0rd1' });
  assertEqual(status, 200, `创建应 200，实际 ${status} ${JSON.stringify(body)}`);
  assert(body.created === true);
  const dup = await adminAction(adminToken, { action: 'createVIPUser', email: vipEmail, password: 'Test#Passw0rd1' });
  assertEqual(dup.status, 409, '重复邮箱应 409 USER_EXISTS');
});

await test('历史 isTest 账号在概览中映射为 VIP 且计入 vipCount', async () => {
  const ov = await overview(adminToken);
  const legacy = ov.body.users.find((u) => u.userId === legacyUserId);
  assert(legacy, '概览应能读到历史 isTest 账号');
  assertEqual(legacy.role, 'vip', '历史 isTest 应映射为 vip');
  assert(legacy.legacyIsTest === true, '应保留只读兼容标识');
  assertEqual(ov.body.stats.vipCount, ov.body.users.filter((u) => u.role === 'vip').length, 'vipCount 应包含历史 isTest');
});

await test('VIP 账号可走邮箱密码登录', async () => {
  const { status, body } = await passwordLogin(vipEmail, 'Test#Passw0rd1');
  assertEqual(status, 200, `登录应 200，实际 ${status} ${JSON.stringify(body)}`);
  assert(body.token, '应返回会话 token');
  vipToken = body.token;
  const wrong = await passwordLogin(vipEmail, 'bad-pass');
  assertEqual(wrong.status, 401, '错误密码应 401');
});

await test('VIP 权益：超过 300KB 的粘贴不被拒（普通用户会被拒）', async () => {
  const html = bigHtml(PASTE_MAX_BYTES + 50 * 1024);
  const r = await paste(vipToken, { name: 'big', html });
  assertEqual(r.status, 200, `VIP 应允许超大粘贴，实际 ${r.status} ${JSON.stringify(r.body)}`);

  const normal = await guestLogin('normal');
  const r2 = await paste(normal.token, { name: 'big', html });
  assertEqual(r2.status, 413, `普通用户超限应 413，实际 ${r2.status}`);
});

// 3. 封禁：项目下架 + 禁止登录 + 解封恢复
const victimDevice = `victim-${Date.now()}-abcdef`;
let victimToken = '';
let victimProjectId = '';

await test('封号：项目公开页 403 下架 + 登录返回 BANNED', async () => {
  const victim = (await json(fetch(`${BASE}/api/auth/guest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: victimDevice }),
  }))).body;
  assert(victim.token, '被封用户应能先登录');
  victimToken = victim.token;
  const p = await paste(victimToken, { name: 'victim-page', html: '<html><body>v</body></html>' });
  assertEqual(p.status, 200, '建页应成功');
  victimProjectId = p.body.project.id;
  assertEqual((await fetch(`${BASE}/p/${victimProjectId}`)).status, 200, '封禁前应 200');

  const ban = await adminAction(adminToken, { action: 'ban', userId: victim.userId, level: 2, reason: '测试封禁', days: 7 });
  assertEqual(ban.status, 200, `封号应 200，实际 ${ban.status} ${JSON.stringify(ban.body)}`);

  // 公开页下架
  const page = await fetch(`${BASE}/p/${victimProjectId}`);
  assertEqual(page.status, 403, '封禁后项目应 403 已下架');
  // 旧会话也被拦（API 层）
  const me = await json(fetch(`${BASE}/api/projects`, { headers: { Authorization: `Bearer ${victimToken}` } }));
  assertEqual(me.status, 403, '封禁后旧会话调用 API 应 403');
  assertEqual(me.body.error, 'BANNED', '错误码应为 BANNED');
  // 重新登录被拒
  const relogin = await json(fetch(`${BASE}/api/auth/guest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: victimDevice }),
  }));
  assertEqual(relogin.status, 403, `封禁中重新登录应 403，实际 ${relogin.status}`);
  assertEqual(relogin.body.error, 'BANNED', '登录错误码应为 BANNED');
});

await test('解封：项目恢复上架 + 可重新登录', async () => {
  // 从 overview 找到被封用户的 userId
  const ov = await overview(adminToken);
  const bannedUser = ov.body.users.find((u) => u.status === 'banned' && u.userId.startsWith('guest_'));
  assert(bannedUser, 'overview 应能查到被封用户');
  const unban = await adminAction(adminToken, { action: 'unban', userId: bannedUser.userId });
  assertEqual(unban.status, 200, '解封应 200');

  const page = await fetch(`${BASE}/p/${victimProjectId}`);
  assertEqual(page.status, 200, '解封后项目应恢复 200');
  const relogin = await json(fetch(`${BASE}/api/auth/guest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: victimDevice }),
  }));
  assertEqual(relogin.status, 200, '解封后应能重新登录');
});

// 4. 删除账号（被封账号 + VIP 账号）
await test('删除被封账号：用户记录/项目/会话全部清除', async () => {
  const v = await guestLogin('delete');
  await adminAction(adminToken, { action: 'ban', userId: v.userId, level: 4, reason: '测试删除', days: null });
  const del = await adminAction(adminToken, { action: 'deleteUser', userId: v.userId });
  assertEqual(del.status, 200, `删除应 200，实际 ${del.status} ${JSON.stringify(del.body)}`);
  const ov = await overview(adminToken);
  assert(!ov.body.users.some((u) => u.userId === v.userId), '用户应已不存在');
  const me = await fetch(`${BASE}/api/projects`, { headers: { Authorization: `Bearer ${v.token}` } });
  assertEqual(me.status, 401, '删除后旧会话应 401');
});

await test('删除 VIP：deleteVIPUser 生效', async () => {
  const ov = await overview(adminToken);
  const vipUser = ov.body.users.find((u) => u.email === vipEmail);
  assert(vipUser, 'overview 应列出 VIP');
  const del = await adminAction(adminToken, { action: 'deleteVIPUser', userId: vipUser.userId });
  assertEqual(del.status, 200, '删除 VIP 应 200');
  const relogin = await passwordLogin(vipEmail, 'Test#Passw0rd1');
  assertEqual(relogin.status, 401, '删除后 VIP 应无法登录');
  // 普通用户不能被 deleteVIPUser 删除
  const normal = await guestLogin('normal2');
  const rejected = await adminAction(adminToken, { action: 'deleteVIPUser', userId: normal.userId });
  assertEqual(rejected.status, 400, '非 VIP 账号应被拒绝');
});

// 5. overview 统计含 VIP 数
await test('overview 统计包含 vipCount 与 role 标识', async () => {
  const ov = await overview(adminToken);
  assert(typeof ov.body.stats.vipCount === 'number', 'stats.vipCount 应为数字');
  assert(Array.isArray(ov.body.users) && ov.body.users.every((u) => ['vip', 'user'].includes(u.role)), '用户应带 role 标识');
});

server.kill();
try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
