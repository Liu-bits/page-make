// =============================================================================
// 管理后台测试套件（本地容器 · 真实 HTTP）
// 覆盖：管理员登录 → 已有账号升级/取消 VIP → 原游客会话立即解除限制
//       → 历史邮箱密码账号清理 → 封号/解封 → 删除账号
// 运行：node dev/test-admin.mjs
// =============================================================================
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PASTE_MAX_BYTES } from '../backend/lib/state.js';
import { encodeKey } from '../backend/lib/base64.js';
import { userIdFromEmail } from '../backend/lib/password.js';
import { keys } from '../backend/lib/kv.js';

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
const legacyEmailProjectId = `legacy-project-${Date.now()}`;
const googleUserId = `google_preserve_${Date.now()}`;
fs.writeFileSync(path.join(dataDir, `user_${encodeKey(legacyUserId)}`), JSON.stringify({
  userId: legacyUserId,
  email: legacyEmail,
  isTest: true,
  status: 'active',
  createdAt: Math.floor(Date.now() / 1000),
}));
const legacySessionToken = 'legacy-email-session-token';
fs.writeFileSync(path.join(dataDir, keys.session(legacySessionToken)), JSON.stringify({
  userId: legacyUserId,
  createdAt: Math.floor(Date.now() / 1000),
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
}));
// DiskKV 在启动时扫描持久卷并建立内存索引。历史账号夹具必须在服务启动前落盘，
// 不能等服务启动后绕过 API 直接写 DATA_DIR，否则 list() 看不到运行中新增的文件。
fs.writeFileSync(path.join(dataDir, keys.project(legacyEmailProjectId)), JSON.stringify({
  id: legacyEmailProjectId,
  userId: legacyUserId,
  name: 'legacy email project',
  status: 'ready',
  createdAt: Math.floor(Date.now() / 1000),
}));
fs.writeFileSync(path.join(dataDir, keys.userProject(legacyUserId, legacyEmailProjectId)), JSON.stringify({}));
// 带 email 字段的 Google VIP 必须保留，防止清理器把“有邮箱”误当成邮箱密码账号。
fs.writeFileSync(path.join(dataDir, keys.user(googleUserId)), JSON.stringify({
  userId: googleUserId,
  email: 'preserve@example.com',
  role: 'vip',
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

async function paste(token, body) {
  return json(fetch(`${BASE}/api/projects/paste`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Pagemake-Token': token },
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

await test('历史 isTest 账号在概览中映射为 VIP 且计入 vipCount', async () => {
  const ov = await overview(adminToken);
  const legacy = ov.body.users.find((u) => u.userId === legacyUserId);
  assert(legacy, '概览应能读到历史 isTest 账号');
  assertEqual(legacy.role, 'vip', '历史 isTest 应映射为 vip');
  assert(legacy.legacyIsTest === true, '应保留只读兼容标识');
  assertEqual(ov.body.stats.vipCount, ov.body.users.filter((u) => u.role === 'vip').length, 'vipCount 应包含历史 isTest');
});

// 2. 游客升级：保留原 userId / token / 项目，立即解除全部游客限制
const vipGuest = await guestLogin('vip-guest');
let vipToken = vipGuest.token;
let vipProject1 = '';

await test('游客升级前：可建第 1 个项目，第 2 个返回 GUEST_LIMIT', async () => {
  const first = await paste(vipToken, { name: 'first', html: '<h1>first</h1>' });
  assertEqual(first.status, 200, `第 1 个应成功，实际 ${first.status} ${JSON.stringify(first.body)}`);
  vipProject1 = first.body.project.id;
  assert(first.body.project.expiresAt, '升级前游客项目应为 10 分钟链接');

  const second = await paste(vipToken, { name: 'second', html: '<h1>second</h1>' });
  assertEqual(second.status, 403, '升级前第 2 个应被拒绝');
  assertEqual(second.body.error, 'GUEST_LIMIT', '错误码应为 GUEST_LIMIT');
});

await test('升级现有游客为 VIP：userId 不变，账户类型为 guest-vip', async () => {
  const upgraded = await adminAction(adminToken, { action: 'upgradeVIP', userId: vipGuest.userId });
  assertEqual(upgraded.status, 200, `升级应成功，实际 ${upgraded.status} ${JSON.stringify(upgraded.body)}`);
  assertEqual(upgraded.body.userId, vipGuest.userId, '不得更换 userId');

  const ov = await overview(adminToken);
  const record = ov.body.users.find((u) => u.userId === vipGuest.userId);
  assert(record, '概览应包含升级账号');
  assertEqual(record.role, 'vip', 'role 应为 vip');
  assertEqual(record.accountKind, 'guest-vip', '游客升级后应保留 guest-vip 类型');
  assert(record.vipSince, '应记录升级时间');
});

await test('原游客 token 升级后立即生效：多项目、超大粘贴、长期链接', async () => {
  const account = await json(fetch(`${BASE}/api/projects`, {
    headers: { 'X-Pagemake-Token': vipToken },
  }));
  assertEqual(account.body.role, 'vip', '原 token 应立即读到 VIP 角色');
  assertEqual(account.body.accountKind, 'guest-vip', '原 token 应立即读到游客 VIP 类型');

  const second = await paste(vipToken, { name: 'second', html: '<h1>second</h1>' });
  assertEqual(second.status, 200, `升级后第 2 个应成功，实际 ${second.status} ${JSON.stringify(second.body)}`);
  assertEqual(second.body.project.expiresAt, null, 'VIP 新项目应为长期链接');

  const html = bigHtml(PASTE_MAX_BYTES + 50 * 1024);
  const large = await paste(vipToken, { name: 'big', html });
  assertEqual(large.status, 200, `VIP 应允许超大粘贴，实际 ${large.status} ${JSON.stringify(large.body)}`);
  assertEqual(large.body.project.expiresAt, null, 'VIP 超大项目也应为长期链接');

  const refreshed = await json(fetch(`${BASE}/api/projects/${vipProject1}/refresh`, {
    method: 'POST',
    headers: { 'X-Pagemake-Token': vipToken },
  }));
  assertEqual(refreshed.status, 200, '升级后应能刷新旧游客项目');
  assertEqual(refreshed.body.project.expiresAt, null, '旧游客项目刷新后应变为长期链接');
});

// 升级即清除游客期项目的 10 分钟过期时间：不清的话用户会看到「已升级但旧链接 410」。
// 公开页是唯一权威判定处，直接打 /p/<id> 验证，不只看项目记录字段。
await test('升级 VIP 立即清除旧游客项目的 10 分钟链接过期时间', async () => {
  const guest = await guestLogin('vip-link-clear');
  const first = await paste(guest.token, { name: 'guest-link', html: '<h1>guest</h1>' });
  assertEqual(first.status, 200, '游客第 1 个项目应成功');
  const projectId = first.body.project.id;
  assert(first.body.project.expiresAt, '游客项目升级前应带 10 分钟过期时间');

  // 升级前：公开页可访问（10 分钟窗口内）
  const beforeUpgrade = await json(fetch(`${BASE}/p/${projectId}`, {
    redirect: 'manual',
  }));
  assertEqual(beforeUpgrade.status, 200, '升级前游客项目应可访问');

  const upgraded = await adminAction(adminToken, { action: 'upgradeVIP', userId: guest.userId });
  assertEqual(upgraded.status, 200, '升级应成功');
  assertEqual(upgraded.body.linksRenewed, 1, '应报告清理了 1 个项目的过期时间');

  const afterUpgrade = await json(fetch(`${BASE}/api/projects`, {
    headers: { 'X-Pagemake-Token': guest.token },
  }));
  const renewed = (afterUpgrade.body.projects || []).find((p) => p.id === projectId);
  assert(renewed, '升级后项目仍应在列表中');
  assertEqual(renewed.expiresAt, null, '升级后旧项目的 expiresAt 应立即被清除');

  const publicAfter = await json(fetch(`${BASE}/p/${projectId}`, { redirect: 'manual' }));
  assertEqual(publicAfter.status, 200, '升级后旧游客项目的公开页应立即可访问');
});

await test('原游客 token 升级后可创建项目模式（explorer）', async () => {
  const created = await json(fetch(`${BASE}/api/projects/explorer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Pagemake-Token': vipToken },
    body: JSON.stringify({ name: 'vim-vip' }),
  }));
  assertEqual(created.status, 200, `VIP 游客应可使用项目模式，实际 ${created.status} ${JSON.stringify(created.body)}`);
  assert(created.body.project?.id, '应返回新项目');

  const down = await adminAction(adminToken, { action: 'downgradeVIP', userId: vipGuest.userId });
  assertEqual(down.status, 200, '应能取消 VIP');
  const blocked = await json(fetch(`${BASE}/api/projects/explorer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Pagemake-Token': vipToken },
    body: JSON.stringify({ name: 'explorer-after-down' }),
  }));
  assertEqual(blocked.status, 403, '取消 VIP 后项目模式限制应恢复');
  assertEqual(blocked.body.error, 'GUEST_NO_EXPLORER', '应返回 GUEST_NO_EXPLORER');
});

await test('取消 VIP：保留账号与项目，旧 token 权益恢复为普通游客', async () => {
  const before = await json(fetch(`${BASE}/api/projects`, {
    headers: { 'X-Pagemake-Token': vipToken },
  }));
  const beforeCount = before.body.projects?.length || 0;

  const after = await json(fetch(`${BASE}/api/projects`, {
    headers: { 'X-Pagemake-Token': vipToken },
  }));
  assertEqual(after.status, 200, '取消 VIP 不应让原 token 失效');
  assertEqual(after.body.accountKind, 'guest', '取消后应为普通游客');
  assertEqual(after.body.projects.length, beforeCount, '项目不得被删除');

  const blocked = await paste(vipToken, { name: 'after-down', html: '<h1>down</h1>' });
  assertEqual(blocked.status, 403, '取消 VIP 后项目数限制应恢复');
  assertEqual(blocked.body.error, 'GUEST_LIMIT', '应返回 GUEST_LIMIT');
});

// 降级即恢复 10 分钟过期：不恢复的话原本长期有效的链接会无限期可访问，
// 等于绕过试用期限制（游客身份的安全缺口）。
await test('取消 VIP 后游客身份的链接重新加上 10 分钟过期时间', async () => {
  const guest = await guestLogin('vip-link-relimit');
  const created = await paste(guest.token, { name: 'guest-relimit', html: '<h1>x</h1>' });
  assertEqual(created.status, 200, '游客第 1 个项目应成功');
  const projectId = created.body.project.id;

  await adminAction(adminToken, { action: 'upgradeVIP', userId: guest.userId });
  const vipList = await json(fetch(`${BASE}/api/projects`, {
    headers: { 'X-Pagemake-Token': guest.token },
  }));
  const asVip = (vipList.body.projects || []).find((p) => p.id === projectId);
  assertEqual(asVip.expiresAt, null, 'VIP 期间应为长期链接');

  const down = await adminAction(adminToken, { action: 'downgradeVIP', userId: guest.userId });
  assertEqual(down.status, 200, '应能取消 VIP');
  assertEqual(down.body.linksLimited, 1, '应报告重新限制了 1 个项目的链接');

  const guestList = await json(fetch(`${BASE}/api/projects`, {
    headers: { 'X-Pagemake-Token': guest.token },
  }));
  const asGuest = (guestList.body.projects || []).find((p) => p.id === projectId);
  assert(asGuest.expiresAt, '降级后游客项目应重新带过期时间');
  const remaining = asGuest.expiresAt - Math.floor(Date.now() / 1000);
  assert(remaining > 0 && remaining <= 600, `剩余时间应在 10 分钟内，实际 ${remaining} 秒`);

  const publicPage = await json(fetch(`${BASE}/p/${projectId}`, { redirect: 'manual' }));
  assertEqual(publicPage.status, 200, '刚降级时公开页仍可访问（10 分钟窗口内）');
});

await test('历史邮箱密码账号清理：账号、项目、会话全部删除，Apple/Google 不受影响', async () => {
  const purged = await adminAction(adminToken, { action: 'purgePasswordUsers' });
  assertEqual(purged.status, 200, '清理接口应成功');
  assert(purged.body.deleted >= 1, '应至少删除历史邮箱账号');
  // Windows fs 删除可能短暂延迟可见；给磁盘一个明确落盘窗口，避免假阴性。
  await sleep(50);

  // 运行中的 DiskKV 以内存索引为准；改用管理接口/磁盘文件双重校验，
  // 避免测试直接 fs.existsSync 读取时命中服务尚未刷新目录视图的假阴性。
  const ov = await overview(adminToken);
  assert(!ov.body.users.some((u) => u.userId === legacyUserId), '邮箱用户记录应删除');
  assert(!ov.body.projects.some((p) => p.id === legacyEmailProjectId), '邮箱账号项目应删除');
  assert(!fs.existsSync(path.join(dataDir, keys.project(legacyEmailProjectId))), '邮箱账号项目文件应删除');
  assert(!fs.existsSync(path.join(dataDir, keys.userProject(legacyUserId, legacyEmailProjectId))), '邮箱账号项目索引应删除');
  assert(!fs.existsSync(path.join(dataDir, keys.session(legacySessionToken))), '邮箱账号会话应删除');
  assert(ov.body.users.some((u) => u.userId === googleUserId), 'Google 账号不得被误删');
});

await test('VIP 权益：普通游客仍受 300KB 粘贴上限', async () => {
  const normal = await guestLogin('normal');
  const r2 = await paste(normal.token, { name: 'big-normal', html: bigHtml(PASTE_MAX_BYTES + 50 * 1024) });
  assertEqual(r2.status, 413, `普通游客超限应 413，实际 ${r2.status}`);
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
  const me = await json(fetch(`${BASE}/api/projects`, { headers: { 'X-Pagemake-Token': victimToken } }));
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
  const me = await fetch(`${BASE}/api/projects`, { headers: { 'X-Pagemake-Token': v.token } });
  assertEqual(me.status, 401, '删除后旧会话应 401');
});

await test('删除 VIP 游客：deleteVIPUser 生效且旧 token 401', async () => {
  const toDelete = await guestLogin('delete-vip');
  const upgraded = await adminAction(adminToken, { action: 'upgradeVIP', userId: toDelete.userId });
  assertEqual(upgraded.status, 200, '应先升级为 VIP');
  const ov = await overview(adminToken);
  const vipUser = ov.body.users.find((u) => u.userId === toDelete.userId);
  assert(vipUser, 'overview 应列出 VIP');
  const del = await adminAction(adminToken, { action: 'deleteVIPUser', userId: vipUser.userId });
  assertEqual(del.status, 200, '删除 VIP 应 200');
  const me = await fetch(`${BASE}/api/projects`, { headers: { 'X-Pagemake-Token': toDelete.token } });
  assertEqual(me.status, 401, '删除后旧 token 应 401');
  // 普通用户不能被 deleteVIPUser 删除
  const normal = await guestLogin('normal2');
  const rejected = await adminAction(adminToken, { action: 'deleteVIPUser', userId: normal.userId });
  assertEqual(rejected.status, 400, '非 VIP 账号应被拒绝');
});

// 5. overview 统计含 VIP 数
await test('overview 统计包含 vipCount 与 role 标识', async () => {
  const ov = await overview(adminToken);
  assert(typeof ov.body.stats.vipCount === 'number', 'stats.vipCount 应为数字');
  assert(
    Array.isArray(ov.body.users) && ov.body.users.every((u) => ['vip', 'svip', 'ultra', 'user'].includes(u.role)),
    '用户应带 role 标识'
  );
  assert(
    Array.isArray(ov.body.users) && ov.body.users.every((u) => ['vip', 'svip', 'ultra', 'user'].includes(u.tier)),
    '用户应带 tier 标识'
  );
});

// 5.1 等级体系：user → vip → svip → ultra
await test('setTier：VIP → SVIP → Ultra 逐级提升，配额同步变化', async () => {
  const deviceId = `tier-${Date.now().toString(16)}-abcdef`;
  const guest = await (await fetch(`${BASE}/api/auth/guest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId }),
  })).json();
  assert(guest.ok, '游客登录应成功');
  const userId = guest.userId;
  const userAuth = { 'X-Pagemake-Token': guest.token };

  const setTier = async (tier) => (await (await fetch(`${BASE}/api/admin/action`, {
    method: 'POST',
    headers: { 'X-Admin-Token': adminToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'setTier', userId, tier }),
  })).json());

  const toVip = await setTier('vip');
  assert(toVip.ok, `升到 VIP 应成功：${JSON.stringify(toVip)}`);
  assertEqual(toVip.tier, 'vip');

  let stats = await (await fetch(`${BASE}/api/stats`, { headers: userAuth })).json();
  assertEqual(stats.tier, 'vip', 'stats 应返回 vip');
  assertEqual(stats.quota.backendMaxBytes, 1024 * 1024, 'VIP 后端配额应为 1MB');
  assertEqual(stats.quota.canUseBackend, true, 'VIP 应可建后端项目');

  const toSvip = await setTier('svip');
  assert(toSvip.ok, '升到 SVIP 应成功');
  stats = await (await fetch(`${BASE}/api/stats`, { headers: userAuth })).json();
  assertEqual(stats.tier, 'svip');
  assertEqual(stats.quota.backendMaxBytes, 100 * 1024 * 1024, 'SVIP 后端配额应为 100MB');

  const toUltra = await setTier('ultra');
  assert(toUltra.ok, '升到 Ultra 应成功');
  stats = await (await fetch(`${BASE}/api/stats`, { headers: userAuth })).json();
  assertEqual(stats.tier, 'ultra');
  assertEqual(stats.quota.backendMaxBytes, null, 'Ultra 配额对外应为 null（无上限）');
  assertEqual(stats.quota.staticMaxBytes, null, 'Ultra 静态配额也应为 null');
});

await test('setTier：非法等级拒绝，重复设置返回 TIER_UNCHANGED', async () => {
  const deviceId = `tier2-${Date.now().toString(16)}-abcdef`;
  const guest = await (await fetch(`${BASE}/api/auth/guest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId }),
  })).json();
  const userId = guest.userId;

  const bad = await fetch(`${BASE}/api/admin/action`, {
    method: 'POST',
    headers: { 'X-Admin-Token': adminToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'setTier', userId, tier: 'god' }),
  });
  assertEqual(bad.status, 400, '非法等级应 400');
  assertEqual((await bad.json()).error, 'INVALID_TIER');

  const same = await (await fetch(`${BASE}/api/admin/action`, {
    method: 'POST',
    headers: { 'X-Admin-Token': adminToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'setTier', userId, tier: 'user' }),
  })).json();
  assertEqual(same.error, 'TIER_UNCHANGED', '设置成当前等级应返回 TIER_UNCHANGED');
});

await test('降级到 user：游客链接恢复 10 分钟限制', async () => {
  const deviceId = `tier3-${Date.now().toString(16)}-abcdef`;
  const guest = await (await fetch(`${BASE}/api/auth/guest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId }),
  })).json();
  const userId = guest.userId;
  const userAuth = { 'X-Pagemake-Token': guest.token };

  // 建一个项目，再升到 SVIP（应清除过期时间）
  const created = await (await fetch(`${BASE}/api/projects/paste`, {
    method: 'POST',
    headers: { ...userAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ html: '<h1>tier</h1>' }),
  })).json();
  assert(created.ok, '游客建项目应成功');
  const projectId = created.project.id;

  await fetch(`${BASE}/api/admin/action`, {
    method: 'POST',
    headers: { 'X-Admin-Token': adminToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'setTier', userId, tier: 'svip' }),
  });

  const down = await (await fetch(`${BASE}/api/admin/action`, {
    method: 'POST',
    headers: { 'X-Admin-Token': adminToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'setTier', userId, tier: 'user' }),
  })).json();
  assert(down.ok, `降级应成功：${JSON.stringify(down)}`);
  assert(down.linksLimited >= 1, `降级后应至少有 1 个项目恢复限时（实际 ${down.linksLimited}）`);
  assert(projectId, '项目应已创建');
});

await test('邮箱密码登录入口已彻底删除（POST /api/auth/login → 404）', async () => {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'nobody@example.com', password: 'Test#Passw0rd1' }),
  });
  assertEqual(res.status, 404, '旧邮箱密码登录入口必须返回 404');
});

await test('管理后台页面不再出现 VIP 邮箱密码创建入口', async () => {
  const res = await fetch(`${BASE}/admin`);
  const html = await res.text();
  assert(!html.includes('createVIPUser'), '后台不得再创建邮箱 VIP');
  assert(!html.includes('vipPwd'), '后台不得再有 VIP 密码输入框');
  assert(html.includes("action: 'upgradeVIP'"), '后台应改为升级现有账号');
  assert(!html.includes('purgePasswordUsers'), '后台界面不得再暴露历史邮箱账号清理');
  assert(html.includes("action: 'reviewVIPRequest'"), '后台应提供 VIP 申请审核');
  assert(html.includes('id="vipRequestTable"'), '后台应展示待审核申请列表');
});

// 6. 游客 VIP 升级申请：提交 → 去重 → 后台批准 → 原会话立即生效
await test('游客提交 VIP 升级申请：状态 pending，重复提交返回同一记录', async () => {
  const guest = await guestLogin('vip-request');
  const created = await json(fetch(`${BASE}/api/vip-request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Pagemake-Token': guest.token },
    body: JSON.stringify({ note: '想创建更多页面' }),
  }));
  assertEqual(created.status, 200, `提交申请应成功，实际 ${created.status} ${JSON.stringify(created.body)}`);
  assertEqual(created.body.request.status, 'pending', '初始状态应为 pending');
  assertEqual(created.body.submitted, true, '首次提交应标记 submitted');
  assertEqual(created.body.request.note, '想创建更多页面', '申请说明应原样保留');
  assert(created.body.request.createdAt > 0, '应记录申请时间');

  const duplicate = await json(fetch(`${BASE}/api/vip-request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Pagemake-Token': guest.token },
    body: JSON.stringify({ note: '再次提交' }),
  }));
  assertEqual(duplicate.status, 200, '待审核期间重复提交不应报错');
  assertEqual(duplicate.body.duplicate, true, '重复提交应标记 duplicate');
  assertEqual(duplicate.body.request.note, '想创建更多页面', '重复提交不得覆盖原说明');

  const read = await json(fetch(`${BASE}/api/vip-request`, {
    headers: { 'X-Pagemake-Token': guest.token },
  }));
  assertEqual(read.status, 200, '读取申请状态应成功');
  assertEqual(read.body.request.status, 'pending', '读取应返回 pending');

  const ov = await overview(adminToken);
  assert(ov.body.vipRequests.some((r) => r.userId === guest.userId), '后台应看到该申请');
  assert(ov.body.stats.vipRequestCount >= 1, '待审核计数应至少为 1');
});

await test('升级申请仅对普通游客开放：VIP 与登录账号不得提交', async () => {
  const vipGuest = await guestLogin('vip-request-already');
  const upgraded = await adminAction(adminToken, { action: 'upgradeVIP', userId: vipGuest.userId });
  assertEqual(upgraded.status, 200, '应先升级为 VIP');
  const blocked = await json(fetch(`${BASE}/api/vip-request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Pagemake-Token': vipGuest.token },
    body: JSON.stringify({ note: '重复申请' }),
  }));
  assertEqual(blocked.status, 409, 'VIP 账号不得重复申请');
  assertEqual(blocked.body.error, 'ALREADY_VIP', '错误码应为 ALREADY_VIP');

  const anonymous = await json(fetch(`${BASE}/api/vip-request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: '未登录' }),
  }));
  assertEqual(anonymous.status, 401, '未登录不得提交申请');
});

await test('后台批准 VIP 申请：原游客会话立即获得 VIP 权益', async () => {
  const guest = await guestLogin('vip-request-approve');
  const first = await paste(guest.token, { name: 'before', html: '<h1>before</h1>' });
  assertEqual(first.status, 200, '升级前应能建第 1 个项目');
  const second = await paste(guest.token, { name: 'blocked', html: '<h1>x</h1>' });
  assertEqual(second.body.error, 'GUEST_LIMIT', '升级前第 2 个项目应被拒');

  await json(fetch(`${BASE}/api/vip-request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Pagemake-Token': guest.token },
    body: JSON.stringify({ note: '用于作品集' }),
  }));

  const approved = await adminAction(adminToken, {
    action: 'reviewVIPRequest',
    userId: guest.userId,
    approve: true,
    note: '审核通过',
  });
  assertEqual(approved.status, 200, `批准应成功，实际 ${approved.status} ${JSON.stringify(approved.body)}`);
  assertEqual(approved.body.approved, true, '应标记已批准');
  assertEqual(approved.body.role, 'vip', '角色应为 vip');
  assertEqual(approved.body.accountKind, 'guest-vip', '应保留游客 VIP 类型');

  const after = await json(fetch(`${BASE}/api/projects`, {
    headers: { 'X-Pagemake-Token': guest.token },
  }));
  assertEqual(after.body.role, 'vip', '原 token 应立即读到 VIP');
  assertEqual(after.body.accountKind, 'guest-vip', '原 token 应立即读到 guest-vip');
  const third = await paste(guest.token, { name: 'after', html: '<h1>after</h1>' });
  assertEqual(third.status, 200, `批准后第 2 个项目应成功，实际 ${third.status} ${JSON.stringify(third.body)}`);
  assertEqual(third.body.project.expiresAt, null, 'VIP 新项目应为长期链接');

  const again = await adminAction(adminToken, {
    action: 'reviewVIPRequest',
    userId: guest.userId,
    approve: true,
  });
  assertEqual(again.status, 409, '重复审核应被拒绝');
  assertEqual(again.body.error, 'VIP_REQUEST_ALREADY_REVIEWED', '错误码应为已审核');
});

await test('后台驳回 VIP 申请：保留游客限制，可带原因', async () => {
  const guest = await guestLogin('vip-request-reject');
  const keep = await paste(guest.token, { name: 'keep', html: '<h1>keep</h1>' });
  assertEqual(keep.status, 200, '驳回前应能建第 1 个项目');
  await json(fetch(`${BASE}/api/vip-request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Pagemake-Token': guest.token },
    body: JSON.stringify({ note: '批量建站' }),
  }));

  const rejected = await adminAction(adminToken, {
    action: 'reviewVIPRequest',
    userId: guest.userId,
    approve: false,
    note: '用途不符合规范',
  });
  assertEqual(rejected.status, 200, '驳回应成功');
  assertEqual(rejected.body.approved, false, '应标记未批准');

  const status = await json(fetch(`${BASE}/api/vip-request`, {
    headers: { 'X-Pagemake-Token': guest.token },
  }));
  assertEqual(status.body.request.status, 'rejected', '状态应为 rejected');
  assertEqual(status.body.request.reviewNote, '用途不符合规范', '应记录驳回原因');

  const stillLimited = await paste(guest.token, { name: 'still', html: '<h1>x</h1>' });
  assertEqual(stillLimited.status, 403, '驳回后第 2 个项目应被拒绝');
  assertEqual(stillLimited.body.error, 'GUEST_LIMIT', '驳回后仍受游客限制');

  // 被驳回后可重新提交，覆盖上一次申请
  const resubmit = await json(fetch(`${BASE}/api/vip-request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Pagemake-Token': guest.token },
    body: JSON.stringify({ note: '已了解规范，用于个人作品' }),
  }));
  assertEqual(resubmit.status, 200, '被驳回后应能重新提交');
  assertEqual(resubmit.body.request.status, 'pending', '重新提交应为 pending');
});

await test('审核不存在的申请：404', async () => {
  const ghost = await guestLogin('vip-request-ghost');
  const res = await adminAction(adminToken, {
    action: 'reviewVIPRequest',
    userId: ghost.userId,
    approve: true,
  });
  assertEqual(res.status, 404, '没有申请记录应 404');
});

server.kill();
try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
