// =============================================================================
// 游客 10 分钟试用链路专项验证（真实 HTTP · 真实游客会话 · 无 DEV_NO_AUTH）
// 覆盖：游客登录 → 粘贴建页 → 公开可访问 → 到期 410 → 状态 expired
//       → 游客名额限制（1 个）→ 刷新重新计时 → 新游客身份重置
// 运行：node dev/test-guest-ttl.mjs
// =============================================================================
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { keys } from '../backend/lib/kv.js';

const PORT = 18787;
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

// ---------------------------------------------------------------------------
// 启动服务（真实鉴权；游客会话无需 Apple 凭证）
// ---------------------------------------------------------------------------
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pagemake-guest-'));
const spawnEnv = { ...process.env, PORT: String(PORT), DATA_DIR: dataDir };
for (const key of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY']) {
  delete spawnEnv[key];
}

const server = spawn(process.execPath, [path.resolve('docker/server.mjs')], {
  env: spawnEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
server.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));

async function waitForServer(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return;
    } catch {
      // 尚未启动
    }
    await sleep(200);
  }
  throw new Error('服务启动超时');
}

async function guestLogin(deviceId) {
  const res = await fetch(`${BASE}/api/auth/guest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId }),
  });
  assert(res.ok, `游客登录失败：HTTP ${res.status}`);
  const body = await res.json();
  assert(body.token, '游客登录未返回 token');
  assert(body.userId?.startsWith('guest_'), `userId 应为 guest_ 前缀，实际 ${body.userId}`);
  return body;
}

async function guestPaste(token, name = 'guest-page') {
  const res = await fetch(`${BASE}/api/projects/paste`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      name,
      html: '<html><body><h1>guest trial</h1></body></html>',
      css: 'h1 { color: red; }',
    }),
  });
  return res;
}

/// 篡改磁盘上的项目记录：把 expiresAt 改成过去（模拟 10 分钟到期）
/// 磁盘 KV 的文件名 = encodeKey 后的完整 key（keys.project 已含编码）
function expireProjectOnDisk(projectId) {
  const file = path.join(dataDir, keys.project(projectId));
  const project = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert(project.expiresAt, '游客项目应带 expiresAt');
  project.expiresAt = Math.floor(Date.now() / 1000) - 1; // 1 秒前
  fs.writeFileSync(file, JSON.stringify(project));
  return project;
}

function readProjectFromDisk(projectId) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, keys.project(projectId)), 'utf8'));
}

// ---------------------------------------------------------------------------
console.log('\n[游客 10 分钟试用链路]');

await waitForServer();

// 1. 游客登录 → 建页 → expiresAt ≈ now + 600
let deviceId1 = 'a1b2c3d4e5f6a7b8'; // DEVICE_ID_RE：16-64 位 [A-Za-z0-9-]
let session1 = null;
let project1 = null;

await test('游客登录 → 粘贴建页 → expiresAt = now + 600', async () => {
  session1 = await guestLogin(deviceId1);
  const res = await guestPaste(session1.token);
  assertEqual(res.status, 200, '游客粘贴应成功');
  const body = await res.json();
  project1 = body.project;
  assert(project1.expiresAt, '游客项目必须设置 expiresAt');
  const delta = project1.expiresAt - Math.floor(Date.now() / 1000);
  assert(delta > 590 && delta <= 600, `expiresAt 应约为 now+600，实际偏差 ${delta}s`);
  assert(project1.url?.includes(`/p/${project1.id}`), 'url 应为 /p/<id> 形式');
});

// 2. 未过期 → 公开访问 200（首页 + 静态资源）
await test('游客链接未到期 → 公开访问 200（入口 + 注入的 CSS）', async () => {
  const entry = await fetch(`${BASE}/p/${project1.id}`);
  assertEqual(entry.status, 200, '入口应 200');
  const html = await entry.text();
  assert(html.includes('guest trial'), '入口 HTML 应包含正文');
  // CSS 文件名跟随 HTML 引用，取项目清单里的非入口文件
  const cssFile = project1.files.find((f) => f.path.endsWith('.css'));
  assert(cssFile, '应注入 CSS 文件');
  const css = await fetch(`${BASE}/p/${project1.id}/${cssFile.path}`);
  assertEqual(css.status, 200, 'CSS 资源应 200');
  assert((await css.text()).includes('color: red'), 'CSS 内容应一致');
});

// 3. 游客名额限制：第二个项目 → 403 GUEST_LIMIT
await test('游客最多创建 1 个网页（第二个 → 403 GUEST_LIMIT）', async () => {
  const res = await guestPaste(session1.token, 'second-page');
  assertEqual(res.status, 403, '第二个项目应被拒绝');
  const body = await res.json();
  assertEqual(body.error, 'GUEST_LIMIT', '错误码应为 GUEST_LIMIT');
});

// 4. 到期后：入口 410 / 资源 410 / 状态 expired
await test('到期后：/p/<id> 与 /p/<id>/* 均返回 410 过期页', async () => {
  expireProjectOnDisk(project1.id);
  const entry = await fetch(`${BASE}/p/${project1.id}`);
  assertEqual(entry.status, 410, '到期入口应 410');
  const html = await entry.text();
  assert(/过期|expired/i.test(html), '410 页应提示过期');
  const cssFile = project1.files.find((f) => f.path.endsWith('.css'));
  const asset = await fetch(`${BASE}/p/${project1.id}/${cssFile.path}`);
  assertEqual(asset.status, 410, '到期资源也应 410');
});

await test('到期后：项目状态接口报 expired', async () => {
  const res = await fetch(`${BASE}/api/projects/${project1.id}/status`, {
    headers: { Authorization: `Bearer ${session1.token}` },
  });
  assertEqual(res.status, 200, '状态查询应 200');
  const body = await res.json();
  assertEqual(body.status, 'expired', '状态应为 expired');
  assertEqual(body.project, null, '过期项目的 project 详情应为 null');
});

// 5. 已过期的游客项目：刷新 → 重新计时 10 分钟 → 恢复 200
await test('游客刷新已过期项目 → 重新计时 10 分钟 → 恢复访问', async () => {
  const res = await fetch(`${BASE}/api/projects/${project1.id}/refresh`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${session1.token}` },
  });
  assertEqual(res.status, 200, `刷新应成功，实际 ${res.status}`);
  const after = readProjectFromDisk(project1.id);
  const delta = after.expiresAt - Math.floor(Date.now() / 1000);
  assert(delta > 590 && delta <= 600, `刷新后 expiresAt 应重新约为 now+600，实际偏差 ${delta}s`);
  const entry = await fetch(`${BASE}/p/${project1.id}`);
  assertEqual(entry.status, 200, '刷新后应恢复 200');
});

// 6. 游客退出 → 新游客身份（新设备号）→ 可再次建页（试用重置）
await test('退出后以新游客身份登录 → 重新获得 1 个创建名额', async () => {
  const deviceId2 = 'ffffffffffffffff';
  const session2 = await guestLogin(deviceId2);
  assert(session2.userId !== session1.userId, '新游客应为不同 userId');
  const res = await guestPaste(session2.token, 'fresh-trial');
  assertEqual(res.status, 200, '新游客应能再次建页');
  const body = await res.json();
  assert(body.project.id !== project1.id, '应为全新项目');
});

// 7. 回归：登录用户（邮箱密码）不受 10 分钟限制
await test('回归：登录用户项目无 expiresAt（链接长期有效）', async () => {
  const email = `user-${Date.now()}@example.com`;
  const reg = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password: 'Test#Passw0rd1' }),
  });
  assertEqual(reg.status, 200, '注册应成功');
  const auth = await reg.json();
  assert(!auth.token.startsWith('guest'), '注册用户不应是游客');
  const res = await guestPaste(auth.token, 'user-page');
  assertEqual(res.status, 200, '登录用户粘贴应成功');
  const body = await res.json();
  assertEqual(body.project.expiresAt ?? null, null, '登录用户项目 expiresAt 应为 null');
});

// ---------------------------------------------------------------------------
server.kill();
try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 忽略清理失败 */ }

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
