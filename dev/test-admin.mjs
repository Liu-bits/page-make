// =============================================================================
// 管理后台测试套件（本地容器 · 真实 HTTP）
// 覆盖：管理员登录 → 测试账号创建/删除 → 测试账号权益（绕过大小上限）
//       → 封号（项目下架 + 禁止登录）→ 解封（项目恢复 + 可登录）→ 删除账号
// 运行：node dev/test-admin.mjs
// =============================================================================
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PASTE_MAX_BYTES } from '../backend/lib/state.js';

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
const spawnEnv = { ...process.env, PORT: String(PORT), DATA_DIR: dataDir };
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

/** 管理员登录（初始密码 123456，哈希存储） */
async function adminLogin(password = '123456') {
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

async function register(email, password = 'test-password-123') {
  const { status, body } = await json(fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  }));
  assertEqual(status, 200, `注册 ${email} 应成功`);
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
  const ok = await adminLogin('123456');
  assertEqual(ok.status, 200, '正确密码应 200');
  assert(ok.body.token, '应返回后台 token');
});

let adminToken = '';
await test('管理员密码为哈希存储（KV 中无明文）', async () => {
  adminToken = (await adminLogin('123456')).body.token;
  const file = path.join(dataDir, 'config_' + Buffer.from('config_admin_password', 'utf8').toString('hex'));
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert(record.hash && record.salt, '密码记录应为 { hash, salt }');
  assert(!JSON.stringify(record).includes('123456'), '存储中不得出现明文密码');
});

// 2. 测试账号：创建 → 登录 → 权益（绕过 300KB 粘贴上限）
const testEmail = `tester-${Date.now()}@test.local`;
let testToken = '';

await test('创建测试账号（指定邮箱+密码）', async () => {
  const { status, body } = await adminAction(adminToken, { action: 'createTestAccount', email: testEmail, password: 'test-pass-123' });
  assertEqual(status, 200, `创建应 200，实际 ${status} ${JSON.stringify(body)}`);
  assert(body.created === true);
  const dup = await adminAction(adminToken, { action: 'createTestAccount', email: testEmail, password: 'test-pass-123' });
  assertEqual(dup.status, 409, '重复邮箱应 409 USER_EXISTS');
});

await test('测试账号可走邮箱密码登录', async () => {
  const { status, body } = await passwordLogin(testEmail, 'test-pass-123');
  assertEqual(status, 200, `登录应 200，实际 ${status} ${JSON.stringify(body)}`);
  assert(body.token, '应返回会话 token');
  testToken = body.token;
  const wrong = await passwordLogin(testEmail, 'bad-pass');
  assertEqual(wrong.status, 401, '错误密码应 401');
});

await test('测试账号权益：超过 300KB 的粘贴不被拒（普通用户会被拒）', async () => {
  const html = bigHtml(PASTE_MAX_BYTES + 50 * 1024);
  const r = await paste(testToken, { name: 'big', html });
  assertEqual(r.status, 200, `测试账号应允许超大粘贴，实际 ${r.status} ${JSON.stringify(r.body)}`);

  const normal = await register(`normal-${Date.now()}@t.com`);
  const r2 = await paste(normal.token, { name: 'big', html });
  assertEqual(r2.status, 413, `普通用户超限应 413，实际 ${r2.status}`);
});

// 3. 封禁：项目下架 + 禁止登录 + 解封恢复
const victimEmail = `victim-${Date.now()}@t.com`;
let victimToken = '';
let victimProjectId = '';

await test('封号：项目公开页 403 下架 + 登录返回 BANNED', async () => {
  const victim = await register(victimEmail);
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
  const relogin = await passwordLogin(victimEmail, 'test-password-123');
  assertEqual(relogin.status, 403, `封禁中重新登录应 403，实际 ${relogin.status}`);
  assertEqual(relogin.body.error, 'BANNED', '登录错误码应为 BANNED');
});

await test('解封：项目恢复上架 + 可重新登录', async () => {
  // 从 overview 找到被封用户的 userId
  const ov = await overview(adminToken);
  const bannedUser = ov.body.users.find((u) => u.status === 'banned' && u.email === victimEmail);
  assert(bannedUser, 'overview 应能查到被封用户');
  const unban = await adminAction(adminToken, { action: 'unban', userId: bannedUser.userId });
  assertEqual(unban.status, 200, '解封应 200');

  const page = await fetch(`${BASE}/p/${victimProjectId}`);
  assertEqual(page.status, 200, '解封后项目应恢复 200');
  const relogin = await passwordLogin(victimEmail, 'test-password-123');
  assertEqual(relogin.status, 200, '解封后应能重新登录');
});

// 4. 删除账号（被封账号 + 测试账号）
await test('删除被封账号：用户记录/项目/会话全部清除', async () => {
  const delEmail = `del-${Date.now()}@t.com`;
  const v = await register(delEmail);
  await adminAction(adminToken, { action: 'ban', userId: v.userId, level: 4, reason: '测试删除', days: null });
  const del = await adminAction(adminToken, { action: 'deleteUser', userId: v.userId });
  assertEqual(del.status, 200, `删除应 200，实际 ${del.status} ${JSON.stringify(del.body)}`);
  const ov = await overview(adminToken);
  assert(!ov.body.users.some((u) => u.userId === v.userId), '用户应已不存在');
  const relogin = await passwordLogin(delEmail, 'test-password-123');
  assertEqual(relogin.status, 401, '删除后原密码登录应 401');
});

await test('删除测试账号：deleteTestAccount 生效', async () => {
  const ov = await overview(adminToken);
  const testUser = ov.body.users.find((u) => u.email === testEmail);
  assert(testUser, 'overview 应列出测试账号');
  const del = await adminAction(adminToken, { action: 'deleteTestAccount', userId: testUser.userId });
  assertEqual(del.status, 200, '删除测试账号应 200');
  const relogin = await passwordLogin(testEmail, 'test-pass-123');
  assertEqual(relogin.status, 401, '删除后测试账号应无法登录');
  // 普通用户不能被 deleteTestAccount 删除
  const normal = await register(`normal2-${Date.now()}@t.com`);
  const rejected = await adminAction(adminToken, { action: 'deleteTestAccount', userId: normal.userId });
  assertEqual(rejected.status, 400, '非测试账号应被拒绝');
});

// 5. overview 统计含测试账号数
await test('overview 统计包含 testCount', async () => {
  const ov = await overview(adminToken);
  assert(typeof ov.body.stats.testCount === 'number', 'stats.testCount 应为数字');
  assert(Array.isArray(ov.body.users) && ov.body.users.every((u) => typeof u.isTest === 'boolean'), '用户应带 isTest 标识');
});

server.kill();
try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
