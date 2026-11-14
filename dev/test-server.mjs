// =============================================================================
// 自托管容器冒烟测试：启动真实 HTTP 服务，跑完整「上传 → 处理 → 公开访问 → 管理」全流程
// 运行：node dev/test-server.mjs
// =============================================================================
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildZip } from './make-zip.mjs';
import { keys as kvKeys } from '../backend/lib/kv.js';
import { textToBase64, base64ToText, bytesToBase64 } from '../backend/lib/base64.js';
import { encodeKey } from '../backend/lib/base64.js';

/** 直接往磁盘 KV 写一条记录（DEV_NO_AUTH 下用来伪造指定等级的用户） */
function seedKvRecord(dir, key, value) {
  fs.writeFileSync(path.join(dir, key), JSON.stringify(value));
}

/** 造一个指定等级的账号记录 */
function seedUser(dir, userId, role) {
  seedKvRecord(dir, `user_${encodeKey(userId)}`, {
    userId,
    email: `${userId}@example.com`,
    role,
    status: 'active',
    banLevel: 0,
    banUntil: null,
    banReason: null,
    createdAt: Math.floor(Date.now() / 1000),
  });
}

// base64url 编码（JWT 段必须无 padding、无 +/）
function toBase64Url(text) {
  return textToBase64(text).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

// base64url 编码二进制（JWT 签名段用；必须走原始字节，
// 不能 String.fromCharCode 后再 TextEncoder——非 Latin1 字节会被改成多字节序列）
function bytesToBase64Url(bytes) {
  return bytesToBase64(bytes).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

const PORT = 18786;
const BASE = `http://127.0.0.1:${PORT}`;
// DEV_NO_AUTH 会跳过 token 校验；这里仍然保留 Authorization 头，
// 让 requireAuth 走「存储会话」以外的测试路径（与线上一致地读取 header）。
const AUTH = { Authorization: 'Bearer dev-test-token-20130ba43d97b34c' };

let passed = 0;
let failed = 0;
let projectId = null;
let explorerId = null;

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

function killProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
}

async function waitForProjectReady(id, headers, attempts = 240) {
  for (let i = 0; i < attempts; i += 1) {
    const response = await fetch(`${BASE}/api/projects/${id}/status`, { headers });
    const json = await response.json();
    if (json.status === 'ready') return json;
    if (json.status === 'failed') {
      throw new Error(`项目处理失败：${json.errorCode || 'UNKNOWN'}`);
    }
    await sleep(500);
  }
  throw new Error('等待项目 ready 超时');
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
// 启动服务（DEV_NO_AUTH=1 跳过 Apple 登录；剥离大小写重复的代理变量避免回环被拦截）
// ---------------------------------------------------------------------------
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pagemake-server-'));
const spawnEnv = { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, DEV_NO_AUTH: '1' };
for (const key of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY']) {
  delete spawnEnv[key];
}

let server = spawn(process.execPath, [path.resolve('docker/server.mjs')], {
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

// ---------------------------------------------------------------------------
console.log('\n[容器冒烟测试]');

await test('服务启动', async () => {
  await waitForServer();
});

await test('健康检查 /healthz', async () => {
  const res = await fetch(`${BASE}/healthz`);
  assert(res.ok, '应返回 200');
  const json = await res.json();
  assert(json.service === 'page-make-container', '应标识容器服务');
});

await test('公开配置 /api/config', async () => {
  const res = await fetch(`${BASE}/api/config`);
  const json = await res.json();
  assert(json.ok, '应成功');
  assert(json.providers.includes('local'), '应包含线路列表（local）');
});

await test('容器布局兼容（server.mjs 与 backend/ 同级，模拟镜像内布局）', async () => {
  // 容器内 server.mjs 在 /app/server.mjs、backend/ 同级；本地在 docker/ 子目录
  const flatDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pagemake-flat-'));
  fs.copyFileSync(path.resolve('docker/server.mjs'), path.join(flatDir, 'server.mjs'));
  fs.cpSync(path.resolve('backend'), path.join(flatDir, 'backend'), { recursive: true });

  const PORT2 = PORT + 2;
  const server2 = spawn(process.execPath, [path.join(flatDir, 'server.mjs')], {
    env: { ...spawnEnv, PORT: String(PORT2), DATA_DIR: path.join(flatDir, 'data'), DEV_NO_AUTH: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    for (let i = 0; i < 50; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${PORT2}/api/config`);
        const json = await res.json();
        assert(json.ok, '扁平布局下 /api/config 应正常（ROOT 探测生效）');
        return;
      } catch {
        // 尚未启动
      }
      await sleep(200);
    }
    throw new Error('扁平布局服务启动失败');
  } finally {
    server2.kill();
    fs.rmSync(flatDir, { recursive: true, force: true });
  }
});

await test('未知路由返回 404', async () => {
  const res = await fetch(`${BASE}/no-such-route`);
  assert(res.status === 404, '应 404');
});

await test('未传线路时默认 local + 非法线路仍拒绝', async () => {
  // 单线路部署：provider 省略 → 默认 local
  const res = await fetch(`${BASE}/api/upload/init`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: [{ name: 'site.zip', size: 100 }] }),
  });
  const json = await res.json();
  assert(json.ok && json.uploadId, '缺省 provider 应默认 local 成功');

  // 非法 provider 仍拒绝
  const bad = await fetch(`${BASE}/api/upload/init`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'nope', files: [{ name: 'site.zip', size: 100 }] }),
  });
  const badJson = await bad.json();
  assert(bad.status === 400 && badJson.error === 'INVALID_PROVIDER', '非法 provider 应返回 INVALID_PROVIDER');
});

await test('分片上传初始化按等级执行 1MB / 10MB / 无上限配额', async () => {
  const vipId = 'tier-quota-vip';
  seedUser(dataDir, vipId, 'vip');
  const vipAuth = { 'X-Test-User': vipId };
  const init = (auth, size, kind = 'static') => fetch(`${BASE}/api/upload/init`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, files: [{ name: 'site.zip', size }] }),
  });

  const vipTooLarge = await init(vipAuth, 2 * 1024 * 1024);
  assertEqual(vipTooLarge.status, 413, 'VIP 超过 1MB 应拒绝');
  assertEqual((await vipTooLarge.json()).error, 'TOO_LARGE');

  const svipId = 'tier-quota-svip';
  seedUser(dataDir, svipId, 'svip');
  const svipAuth = { 'X-Test-User': svipId };
  const svipOk = await init(svipAuth, 8 * 1024 * 1024);
  assertEqual(svipOk.status, 200, 'SVIP 8MB 应允许初始化');
  const svipTooLarge = await init(svipAuth, 20 * 1024 * 1024);
  assertEqual(svipTooLarge.status, 413, 'SVIP 超过 10MB 应拒绝');

  const ultraId = 'tier-quota-ultra';
  seedUser(dataDir, ultraId, 'ultra');
  const ultraAuth = { 'X-Test-User': ultraId };
  const ultraOk = await init(ultraAuth, 1024 * 1024 * 1024);
  assertEqual(ultraOk.status, 200, 'Ultra 超大项目应允许初始化');
});

await test('反向代理头兼容（x-forwarded-proto 多值逗号分隔）', async () => {
  // ModelScope 网关会传 "https, https" 这种多值代理头，取第一个值
  const res = await fetch(`${BASE}/api/config`, {
    headers: {
      'x-forwarded-proto': 'https, https',
      'x-forwarded-host': 'a.example.com, b.example.com',
    },
  });
  assert(res.ok, '多值代理头不应导致 500');
  const json = await res.json();
  assert(json.ok, '应正常返回配置');
});

await test('完整上传流程：init → chunk → finish → 轮询 → ready', async () => {
  const zip = buildZip([
    ['index.html', '<!DOCTYPE html><html><head><link rel="stylesheet" href="style.css"></head><body><img src="img/logo.png" alt="logo"></body></html>'],
    ['img/logo.png', new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])],
  ]);

  // 1. 初始化（必须选线路）
  const initRes = await fetch(`${BASE}/api/upload/init`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: 'edgeone',
      files: [{ name: 'site.zip', size: zip.length }],
      name: '上传项目名称',
    }),
  });
  const init = await initRes.json();
  assert(init.ok && init.uploadId, 'init 应返回 uploadId');
  assert(init.chunkSize > 0, '应返回分片大小');

  // 2. 上传分片（整体 < 600KB，单片搞定）
  const chunkRes = await fetch(`${BASE}/api/upload/chunk`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      uploadId: init.uploadId,
      fileIndex: 0,
      chunkIndex: 0,
      data: zip.toString('base64'),
    }),
  });
  assert(chunkRes.ok, 'chunk 应成功');

  // 3. 完成上传（立即返回 processing，后台处理）
  const finishRes = await fetch(`${BASE}/api/upload/finish`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadId: init.uploadId }),
  });
  const finish = await finishRes.json();
  assert(finish.ok && finish.projectId, 'finish 应返回 projectId');
  assert(finish.status === 'processing', 'finish 应返回 processing 状态');
  projectId = finish.projectId;

  // 4. 轮询状态直到 ready
  let status = '';
  for (let i = 0; i < 60; i++) {
    await sleep(200);
    const res = await fetch(`${BASE}/api/projects/${projectId}/status`, { headers: AUTH });
    const json = await res.json();
    status = json.status;
    if (status === 'ready') break;
    if (status === 'failed') throw new Error(`处理失败：${json.errorCode}`);
  }
  assert(status === 'ready', `状态应为 ready，实际 ${status}`);
  const ready = await (await fetch(`${BASE}/api/projects/${projectId}/status`, { headers: AUTH })).json();
  assertEqual(ready.project.name, '上传项目名称', 'ready 项目应保留用户填写的名称');
});

await test('ZIP 上传：.php 文件被跳过，不会落库或公开下载', async () => {
  const zip = buildZip([
    ['index.html', '<html><body><h1>safe</h1></body></html>'],
    ['legacy.php', '<?php echo "MUST_NOT_LEAK"; ?>'],
    ['nested/admin.php', '<?php echo "MUST_NOT_LEAK_NESTED"; ?>'],
  ]);
  const init = await (await fetch(`${BASE}/api/upload/init`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: [{ name: 'legacy.zip', size: zip.length }] }),
  })).json();
  assert(init.ok && init.uploadId, 'init 应成功');
  await fetch(`${BASE}/api/upload/chunk`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      uploadId: init.uploadId, fileIndex: 0, chunkIndex: 0, data: zip.toString('base64'),
    }),
  });
  const finish = await (await fetch(`${BASE}/api/upload/finish`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadId: init.uploadId }),
  })).json();
  assert(finish.ok && finish.projectId, 'finish 应成功');

  let project;
  for (let i = 0; i < 60; i++) {
    await sleep(200);
    project = await (await fetch(`${BASE}/api/projects/${finish.projectId}/status`, { headers: AUTH })).json();
    if (project.status === 'ready' || project.status === 'failed') break;
  }
  assertEqual(project?.status, 'ready', `ZIP 应处理成功：${JSON.stringify(project)}`);
  const detail = await (await fetch(`${BASE}/api/projects/${finish.projectId}`, { headers: AUTH })).json();
  const fullProject = detail.project;
  assert(fullProject && Array.isArray(fullProject.files), '项目详情应包含文件清单');
  assert(!fullProject.files.some((file) => /\.php$/i.test(file.path)), '项目清单不得包含 .php');
  assertEqual((await fetch(`${BASE}/p/${finish.projectId}/legacy.php`)).status, 404, '.php 不得公开下载');
  assertEqual((await fetch(`${BASE}/p/${finish.projectId}/nested/admin.php`)).status, 404, '嵌套 .php 不得公开下载');
});

await test('历史项目：.php 入口不公开，重新发布后修复为 HTML 入口', async () => {
  seedUser(dataDir, 'svip-history', 'svip');
  const svipAuthH = { 'X-Test-User': 'svip-history' };
  const created = await (await fetch(`${BASE}/api/projects/explorer`, {
    method: 'POST',
    headers: { ...svipAuthH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'legacy-entry' }),
  })).json();
  assert(created.ok && created.project?.id, '创建项目应成功');
  const id = created.project.id;

  // DiskKV 的 key 即文件名；测试直接改临时数据目录，模拟升级前的历史项目。
  const phpSource = '<?php echo "HISTORIC_PHP_SOURCE";';
  const safeHtml = '<html><body><h1>HISTORIC_SAFE_PAGE</h1></body></html>';
  fs.writeFileSync(path.join(dataDir, kvKeys.siteFile(id, 'index.php')), phpSource);
  fs.writeFileSync(path.join(dataDir, kvKeys.siteFile(id, 'index.html')), safeHtml);
  // 服务启动时扫描磁盘建立索引，运行中直接写文件不会自动进索引，需重启模拟真实升级。
  fs.writeFileSync(path.join(dataDir, kvKeys.project(id)), JSON.stringify({
    ...created.project,
    entryPath: 'index.php',
    status: 'ready',
    files: [
      { path: 'index.php', size: Buffer.byteLength(phpSource) },
      { path: 'index.html', size: Buffer.byteLength(safeHtml) },
    ],
  }));
  server.kill();
  await new Promise((resolve) => server.once('exit', resolve));
  server = spawn(process.execPath, [path.resolve('docker/server.mjs')], {
    env: spawnEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  server.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  await waitForServer();

  // 修复前：旧 entryPath 指向 PHP，公开入口必须 404，且绝不能下发源码。
  const legacyPage = await fetch(`${BASE}/p/${id}`);
  assertEqual(legacyPage.status, 404, '历史 .php 入口应 404');
  assert(!(await legacyPage.text()).includes('HISTORIC_PHP_SOURCE'), '不得泄露 PHP 源码');
  assertEqual((await fetch(`${BASE}/p/${id}/index.php`)).status, 404, '.php 资源也不得公开下载');
  assertEqual(
    (await fetch(`${BASE}/api/projects/${id}/files?path=index.php`, { headers: svipAuthH })).status,
    400,
    '历史 .php 也不得通过文件接口读取'
  );

  // 重新发布：忽略历史 PHP 入口，自动选中项目内唯一 HTML 并修复链接。
  const published = await (await fetch(`${BASE}/api/projects/${id}`, {
    method: 'POST',
    headers: { ...svipAuthH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'publish' }),
  })).json();
  assert(published.ok, `历史项目重新发布应成功：${JSON.stringify(published)}`);
  assertEqual(published.project.entryPath, 'index.html', '入口应修复为 index.html');
  assert(!published.project.files.some((file) => /\.php$/i.test(file.path)), '文件清单不得暴露历史 PHP');

  const fixedPage = await fetch(`${BASE}/p/${id}`);
  assertEqual(fixedPage.status, 200, '修复后入口应可访问');
  const fixedHtml = await fixedPage.text();
  assert(fixedHtml.includes('HISTORIC_SAFE_PAGE'), '应返回 HTML 内容');
  assert(!fixedHtml.includes('HISTORIC_PHP_SOURCE'), '不得泄露 PHP 源码');

  // 刷新链接也必须重新校验入口，不能把 entryPath 退回历史 PHP。
  const refreshed = await (await fetch(`${BASE}/api/projects/${id}/refresh`, {
    method: 'POST',
    headers: svipAuthH,
  })).json();
  assert(refreshed.ok, `刷新应成功：${JSON.stringify(refreshed)}`);
  assertEqual(refreshed.project.entryPath, 'index.html', '刷新后入口应保持 index.html');
});

// zip 炸弹防护：306KB 的包可解压出 300MB，直接写满容器持久卷会让全站无法建站
await test('zip 炸弹：解压超限 → 项目 failed(TOO_LARGE) 且不写盘', async () => {
  const big = new Uint8Array(40 * 1024 * 1024); // 解压后 40MB > 32MB 上限
  const zip = buildZip([
    ['index.html', '<h1>bomb</h1>'],
    ['big.bin', big, { deflate: true }],
  ]);

  const initRes = await fetch(`${BASE}/api/upload/init`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: [{ name: 'bomb.zip', size: zip.length }] }),
  });
  const init = await initRes.json();
  assert(init.ok && init.uploadId, 'init 应成功（压缩包本身小于 5MB 上限）');

  await fetch(`${BASE}/api/upload/chunk`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      uploadId: init.uploadId, fileIndex: 0, chunkIndex: 0, data: zip.toString('base64'),
    }),
  });
  const finish = await (await fetch(`${BASE}/api/upload/finish`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadId: init.uploadId }),
  })).json();
  assert(finish.ok && finish.projectId, 'finish 应返回 projectId');

  let json = null;
  for (let i = 0; i < 60; i++) {
    await sleep(200);
    json = await (await fetch(`${BASE}/api/projects/${finish.projectId}/status`, { headers: AUTH })).json();
    if (json.status !== 'processing') break;
  }
  assertEqual(json.status, 'failed', 'zip 炸弹应被判为 failed');
  assertEqual(json.errorCode, 'TOO_LARGE', '错误码应为 TOO_LARGE');
  assert(!fs.existsSync(path.join(dataDir, `site_${kvKeys.project(finish.projectId).slice('project_'.length)}_`)),
    '超限内容不得写入磁盘');
});

await test('等级配额也约束解压后体积：VIP 压缩包小但解压超 1MB 仍失败', async () => {
  const vipId = 'vip-unzip-quota';
  seedUser(dataDir, vipId, 'vip');
  const vipAuth = { 'X-Test-User': vipId };
  const expanded = new Uint8Array(2 * 1024 * 1024); // 全零，deflate 后远小于 1MB
  const zip = buildZip([
    ['index.html', '<h1>vip quota</h1>'],
    ['large.bin', expanded, { deflate: true }],
  ]);

  const init = await (await fetch(`${BASE}/api/upload/init`, {
    method: 'POST',
    headers: { ...vipAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: [{ name: 'quota.zip', size: zip.length }] }),
  })).json();
  assert(init.ok && init.uploadId, '压缩包本身应通过 VIP 1MB 初始化校验');

  await fetch(`${BASE}/api/upload/chunk`, {
    method: 'POST',
    headers: { ...vipAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      uploadId: init.uploadId, fileIndex: 0, chunkIndex: 0, data: zip.toString('base64'),
    }),
  });
  const finish = await (await fetch(`${BASE}/api/upload/finish`, {
    method: 'POST',
    headers: { ...vipAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadId: init.uploadId }),
  })).json();
  assert(finish.ok && finish.projectId, 'finish 应返回 projectId');

  let json = null;
  for (let i = 0; i < 60; i++) {
    await sleep(200);
    json = await (await fetch(`${BASE}/api/projects/${finish.projectId}/status`, { headers: vipAuth })).json();
    if (json.status !== 'processing') break;
  }
  assertEqual(json.status, 'failed', 'VIP 解压后超过 1MB 应失败');
  assertEqual(json.errorCode, 'TOO_LARGE', '错误码应为 TOO_LARGE');
});

await test('公开访问：入口 HTML 与静态资源', async () => {
  assert(projectId, '需要先完成上传');

  const page = await fetch(`${BASE}/p/${projectId}`);
  assert(page.ok, '入口应可访问');
  const html = await page.text();
  assert(html.includes('</html>'), '应返回入口 HTML');
  assert((page.headers.get('content-type') || '').includes('text/html'), 'content-type 应为 text/html');

  const logo = await fetch(`${BASE}/p/${projectId}/img/logo.png`);
  assert(logo.ok, '资源应可访问');
  assert(logo.headers.get('content-type') === 'image/png', 'content-type 应为 image/png');
  const bytes = new Uint8Array(await logo.arrayBuffer());
  assert(bytes[0] === 137 && bytes[1] === 80, 'PNG 内容应完整');
});

await test('项目列表包含新项目', async () => {
  const res = await fetch(`${BASE}/api/projects`, { headers: AUTH });
  const json = await res.json();
  assert(json.projects.some((p) => p.id === projectId), '列表应包含项目');
});

await test('刷新链接', async () => {
  const res = await fetch(`${BASE}/api/projects/${projectId}/refresh`, {
    method: 'POST',
    headers: AUTH,
  });
  assert((await res.json()).ok, '刷新应成功');
});

await test('文件管理：添加 + 删除', async () => {
  const addRes = await fetch(`${BASE}/api/projects/${projectId}/files`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'style.css', content: Buffer.from('body { color: red; }').toString('base64') }),
  });
  const add = await addRes.json();
  assert(add.ok, '添加文件应成功');
  assert(add.project.files.some((f) => f.path === 'style.css'), '文件清单应包含新文件');

  const css = await fetch(`${BASE}/p/${projectId}/style.css`);
  assert(css.ok && (await css.text()).includes('color: red'), '新文件应可公开访问');

  const delRes = await fetch(`${BASE}/api/projects/${projectId}/files`, {
    method: 'DELETE',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'style.css' }),
  });
  const del = await delRes.json();
  assert(del.ok && !del.project.files.some((f) => f.path === 'style.css'), '删除后清单应不含该文件');

  const gone = await fetch(`${BASE}/p/${projectId}/style.css`);
  assert(gone.status === 404, '删除后资源应 404');
});

await test('取消上传：清理后端临时分片', async () => {
  const zip = buildZip([['index.html', '<html><body>cancel me</body></html>']]);
  const initRes = await fetch(`${BASE}/api/upload/init`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'edgeone', files: [{ name: 'site.zip', size: zip.length }] }),
  });
  const init = await initRes.json();
  await fetch(`${BASE}/api/upload/chunk`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadId: init.uploadId, fileIndex: 0, chunkIndex: 0, data: zip.toString('base64') }),
  });

  // 取消前磁盘上应有临时分片（key 经 encodeKey 编码）
  const chunkPrefix = kvKeys.uploadChunkPrefix(init.uploadId);
  const before = fs.readdirSync(dataDir).filter((f) => f.startsWith(chunkPrefix));
  assert(before.length > 0, '取消前应有临时分片文件');

  const cancelRes = await fetch(`${BASE}/api/upload/${init.uploadId}`, { method: 'DELETE', headers: AUTH });
  assert((await cancelRes.json()).ok, '取消应成功');

  const after = fs.readdirSync(dataDir).filter((f) => f.startsWith(chunkPrefix));
  assertEqual(after.length, 0, `取消后该上传的临时分片应清理（残留：${after.join(',')}）`);

  // 重复取消应 404
  const again = await fetch(`${BASE}/api/upload/${init.uploadId}`, { method: 'DELETE', headers: AUTH });
  assert(again.status === 404, '重复取消应 404');
});

await test('粘贴代码创建：注入 CSS + 公开访问（JS 已移除）', async () => {
  const html = '<!DOCTYPE html><html><head><title>paste</title></head><body><h1>Hi</h1></body></html>';
  const res = await fetch(`${BASE}/api/projects/paste`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'edgeone', html, css: 'h1{color:red}', js: 'console.log(1)', name: '粘贴测试' }),
  });
  const json = await res.json();
  assert(json.ok, `粘贴创建应成功：${JSON.stringify(json)}`);
  const project = json.project;
  assertEqual(project.status, 'ready', '粘贴项目应直接 ready');
  assertEqual(project.sourceType, 'paste', 'sourceType 应为 paste');
  assertEqual(project.name, '粘贴测试', '粘贴项目应保存用户填写的名称');
  assert(project.url, '应返回公开链接');

  // 公开页面应包含注入的 CSS/JS 引用
  const page = await (await fetch(`${BASE}/p/${project.id}`)).text();
  assert(page.includes('style.css'), '页面应注入 style.css 引用');
  assert(!page.includes('src="script.js"'), '粘贴模式不得再注入 script.js');

  // 静态资源可访问
  const css = await fetch(`${BASE}/p/${project.id}/style.css`);
  assertEqual(await css.text(), 'h1{color:red}', 'style.css 内容应一致');

  // 列表包含
  const list = await (await fetch(`${BASE}/api/projects`, { headers: AUTH })).json();
  assert(list.projects.some((p) => p.id === project.id), '列表应包含粘贴项目');
});

await test('粘贴代码创建：HTML 片段自动包裹完整文档', async () => {
  const res = await fetch(`${BASE}/api/projects/paste`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'edgeone', html: '<p>fragment</p>', name: '片段' }),
  });
  const json = await res.json();
  assert(json.ok, '片段创建应成功');
  assertEqual(json.project.autoGenerated, true, '片段应标记 autoGenerated');
  const page = await (await fetch(`${BASE}/p/${json.project.id}`)).text();
  assert(page.includes('<!DOCTYPE html>'), '应包裹为完整文档');
  assert(page.includes('<p>fragment</p>'), '片段内容应保留');
});

await test('粘贴代码创建：参数校验', async () => {
  // 缺 provider → 默认 local（单线路部署）
  const noProvider = await fetch(`${BASE}/api/projects/paste`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ html: '<p>x</p>' }),
  });
  const noProviderJson = await noProvider.json();
  assert(noProviderJson.ok, '缺 provider 应默认 local 成功');
  assertEqual(noProviderJson.project.provider, 'local', '项目线路应为 local');

  const noHtml = await fetch(`${BASE}/api/projects/paste`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'edgeone', html: '   ' }),
  });
  assertEqual((await noHtml.json()).error, 'BAD_REQUEST', '空 HTML 应报 BAD_REQUEST');
});

// 降级后不能靠「publish 不带 kind」继续占用后端常驻进程：
// 权限校验必须按最终生效的 kind 判断，而不是只在显式传 kind 时判断。
await test('降级后 publish 不带 kind 也不能继续跑后端项目', async () => {
  const uid = 'downgrade-publish';
  seedUser(dataDir, uid, 'svip');
  const auth = { 'X-Test-User': uid };

  const created = await (await fetch(`${BASE}/api/projects/explorer`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'downgrade-app', kind: 'npm' }),
  })).json();
  assert(created.ok, `SVIP 建后端项目应成功：${JSON.stringify(created)}`);
  const id = created.project.id;

  const put = await fetch(`${BASE}/api/projects/${id}/files`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path: 'package.json',
      content: textToBase64(JSON.stringify({
        name: 'x', version: '1.0.0', private: true, scripts: { start: 'node server.js' },
      })),
    }),
  });
  assertEqual(put.status, 200, '写入 package.json 应成功');

  // 降级为普通用户（DiskKV 每次读盘，改完立即生效）
  seedUser(dataDir, uid, 'user');

  const res = await fetch(`${BASE}/api/projects/${id}`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'publish' }), // 故意不带 kind
  });
  assertEqual(res.status, 403, `降级后发布后端项目应 403，实际 ${res.status}`);
  assertEqual((await res.json()).error, 'BACKEND_REQUIRES_VIP', '错误码应为 BACKEND_REQUIRES_VIP');
});

// 上传任务只能消费一次：否则同一份分片可以反复 finish，每次生成一个新项目
// （配额绕过），失败时 upload 记录还会被保留，可无限刷失败记录。
await test('finish 只能消费一次 + 缺分片直接拒绝 + 并发 finish 只成功一个', async () => {
  const zip = buildZip([['index.html', '<h1>once</h1>']]);
  const initUpload = async (size = zip.length) => (await fetch(`${BASE}/api/upload/init`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: [{ name: 'site.zip', size }] }),
  })).json();
  const putChunk = async (uploadId, bytes) => fetch(`${BASE}/api/upload/chunk`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadId, fileIndex: 0, chunkIndex: 0, data: bytes.toString('base64') }),
  });
  const finishOnce = async (uploadId) => {
    const res = await fetch(`${BASE}/api/upload/finish`, {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId }),
    });
    let json = null;
    try { json = await res.json(); } catch { /* 非 JSON 响应 */ }
    return { status: res.status, json };
  };

  // A. 一个分片都不传：直接 400，不能丢给后台对缺失分片反复重试
  const initA = await initUpload();
  const noChunk = await fetch(`${BASE}/api/upload/finish`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadId: initA.uploadId }),
  });
  assertEqual(noChunk.status, 400, `缺分片应 400，实际 ${noChunk.status}`);
  assertEqual((await noChunk.json()).message, 'CHUNKS_INCOMPLETE', '应提示分片不完整');

  // B. 正常上传后重复 finish：第二次必须被拒（成功路径会删 upload 记录 → 404）
  const initB = await initUpload();
  const chunkRes = await putChunk(initB.uploadId, zip);
  assert(chunkRes.ok, '分片上传应成功');
  const first = await finishOnce(initB.uploadId);
  assertEqual(first.status, 200, '首次 finish 应成功');
  const second = await finishOnce(initB.uploadId);
  assert(
    second.status === 404 || second.status === 409,
    `重复 finish 必须被拒，实际 ${second.status}`
  );

  // C. 失败路径：processUpload 失败时**保留** upload 记录（便于排查/重传），
  //    所以这里能稳定命中 409 UPLOAD_ALREADY_CONSUMED。
  //    B 的成功路径记录被删掉只会 404，单独断言 409 才真正覆盖「已消费」分支。
  const garbage = Buffer.from('definitely-not-a-zip-payload');
  const initC = await initUpload(garbage.length);
  assert((await putChunk(initC.uploadId, garbage)).ok, '垃圾分片应被接收（内容校验在处理阶段）');
  assertEqual((await finishOnce(initC.uploadId)).status, 200, '首次 finish 应成功（内容错误异步暴露）');
  const repeatC = await finishOnce(initC.uploadId);
  assertEqual(repeatC.status, 409, `已消费的上传再次 finish 应 409，实际 ${repeatC.status}`);
  assertEqual(repeatC.json?.message, 'UPLOAD_ALREADY_CONSUMED', '应提示已消费');

  // D. 并发 finish：加锁前两个请求都能读到 status=uploading 并各自生成项目
  //    （配额绕过）。这里用必然失败的载荷，保证 upload 记录不会被删，
  //    第二个请求能稳定走到 409 分支。
  const initD = await initUpload(garbage.length);
  assert((await putChunk(initD.uploadId, garbage)).ok, '并发用例分片上传应成功');
  const [r1, r2] = await Promise.all([finishOnce(initD.uploadId), finishOnce(initD.uploadId)]);
  const okCount = [r1, r2].filter((r) => r.status === 200).length;
  const conflictCount = [r1, r2].filter((r) => r.status === 409).length;
  assertEqual(okCount, 1, `并发 finish 必须只有一个成功，实际 ${JSON.stringify([r1.status, r2.status])}`);
  assertEqual(conflictCount, 1, `另一个必须是 409，实际 ${JSON.stringify([r1.status, r2.status])}`);
  const winner = r1.status === 200 ? r1 : r2;
  assert(/^[a-f0-9]{32}$/.test(String(winner.json?.projectId || '')), '成功方应返回 projectId');
});

// 请求体上限：readBody 发生在路由匹配与鉴权之前，超大 body 必须在读入阶段挡住，
// 否则公开端口上任何匿名请求都能把容器内存打满。
await test('请求体超限：返回 413 而不是把内存吃满', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pagemake-body-'));
  const port = 18796;
  const bodyEnv = {
    ...process.env,
    PORT: String(port),
    DATA_DIR: dir,
    DEV_NO_AUTH: '1',
    PAGEMAKE_MAX_BODY_BYTES: '1024',
  };
  for (const key of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY']) {
    delete bodyEnv[key];
  }
  const child = spawn(process.execPath, [path.resolve('docker/server.mjs')], {
    env: bodyEnv,
    stdio: 'ignore',
  });
  try {
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 75; i++) {
      try {
        const probe = await fetch(`${base}/healthz`);
        if (probe.ok) break;
      } catch {
        // 尚未启动
      }
      await sleep(200);
    }
    const res = await fetch(`${base}/api/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'feedback', message: 'x'.repeat(4096) }),
    });
    assertEqual(res.status, 413, `超限 body 应返回 413，实际 ${res.status}`);
    assertEqual((await res.json()).error, 'TOO_LARGE', '错误码应为 TOO_LARGE');
  } finally {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    } else {
      child.kill('SIGKILL');
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 反馈接口防刷：未登录可提交，但必须限流，否则脚本可无限灌入打满 KV
await test('反馈：可提交，且超限返回 429', async () => {
  const first = await (await fetch(`${BASE}/api/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'feedback', message: '第一条反馈' }),
  })).json();
  assert(first.ok, '正常反馈应被接收');

  let limited = 0;
  for (let i = 0; i < 15; i++) {
    const res = await fetch(`${BASE}/api/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'feedback', message: `刷量 ${i}` }),
    });
    if (res.status === 429) limited++;
  }
  assert(limited > 0, '超过每 IP 每分钟 10 次后应返回 429');

  const empty = await (await fetch(`${BASE}/api/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: '   ' }),
  })).json();
  assertEqual(empty.error, 'BAD_REQUEST', '空 message 应报 BAD_REQUEST');
});

await test('Google 登录：非法 token 拒绝 + 参数校验', async () => {
  const bad = await (await fetch(`${BASE}/api/auth/google`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken: 'fake.google.token' }),
  })).json();
  assertEqual(bad.error, 'INVALID_JWT_FORMAT', '非法 Google token 应被拒绝（JWT 格式错误）');

  const missing = await (await fetch(`${BASE}/api/auth/google`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })).json();
  assertEqual(missing.error, 'BAD_REQUEST', '缺 idToken 应报 BAD_REQUEST');
});

// ---------------------------------------------------------------------------
// Google 登录完整链路（含「handler 用了未 import 的函数」这一类回归）
// 背景：2026-10-25 线上 bug —— backend/api/auth/google.js 调用 isVIPUser() 但漏
// import。ESM 绑定是惰性的，`import('./google.js')` 照样成功，只有真正执行到那一行
// 才 ReferenceError → 容器 catch 全部 500 INTERNAL_ERROR。
// 表现为「OAuth 网页正常打开、邮件也到了、就是登录报 INTERNAL-ERROR」。
// 上面两个用例（非法 token / 缺参数）都在 isVIPUser 之前就返回，完全覆盖不到，
// 所以必须用一把真实签名的合法 token 跑完整链路。
// 实现：起独立实例 + 预置 DATA_DIR/jwks/google-jwks.json 磁盘缓存（JWKS 三级加载的
// 第二级，真实生产路径），并让实时拉取必然失败 → 走磁盘缓存验签。
// ---------------------------------------------------------------------------
await test('Google 登录：合法 token 走完整链路（VIP 判定不 500）', async () => {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify']
  );
  const publicJwk = {
    ...(await crypto.subtle.exportKey('jwk', keyPair.publicKey)),
    kid: 'test-google-kid',
    alg: 'RS256',
    use: 'sig',
  };

  const googleDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pagemake-google-'));
  // 预置 JWKS 磁盘缓存：实时拉取失败时加载器会读这里（生产同一条路径）
  fs.mkdirSync(path.join(googleDataDir, 'jwks'), { recursive: true });
  fs.writeFileSync(
    path.join(googleDataDir, 'jwks', 'google-jwks.json'),
    JSON.stringify({ keys: [publicJwk] })
  );

  const googlePort = PORT + 2;
  const googleEnv = {
    ...spawnEnv,
    PORT: String(googlePort),
    DATA_DIR: googleDataDir,
    GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com',
    // 让实时拉取必然失败（连不通的地址），确保走磁盘缓存分支
    GOOGLE_JWKS_URL: 'https://127.0.0.1:1/unreachable-jwks',
  };
  const googleServer = spawn(process.execPath, [path.resolve('docker/server.mjs')], {
    env: googleEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  googleServer.stderr.on('data', (d) => process.stderr.write(`[google-server] ${d}`));
  try {
    const gbase = `http://127.0.0.1:${googlePort}`;
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(`${gbase}/healthz`)).ok) break; } catch {}
      await sleep(200);
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const header = toBase64Url(JSON.stringify({ alg: 'RS256', kid: 'test-google-kid', typ: 'JWT' }));
    const payload = toBase64Url(JSON.stringify({
      iss: 'https://accounts.google.com',
      aud: 'test-client.apps.googleusercontent.com',
      sub: 'google-test-sub-123',
      email: 'google.tester@example.com',
      name: 'Google Tester',
      iat: nowSec,
      exp: nowSec + 600,
    }));
    const signingInput = `${header}.${payload}`;
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      keyPair.privateKey,
      new TextEncoder().encode(signingInput)
    );
    const idToken = `${signingInput}.${bytesToBase64Url(new Uint8Array(signature))}`;

    const res = await fetch(`${gbase}/api/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
    });
    const body = await res.json();
    assertEqual(
      res.status,
      200,
      `合法 Google token 应登录成功；实际 ${res.status} ${JSON.stringify(body)}（INTERNAL_ERROR 通常是 handler 漏 import）`
    );
    assert(body.token, '应返回会话 token');
    assertEqual(body.userId, 'google_google-test-sub-123', 'userId 应为 google_<sub>');
    assertEqual(body.email, 'google.tester@example.com', '应回传邮箱');
    assert(['user', 'vip'].includes(body.role), `role 应为 user/vip，实际 ${body.role}`);
  } finally {
    googleServer.kill();
    fs.rmSync(googleDataDir, { recursive: true, force: true });
  }
});

await test('邮箱密码体系已彻底删除（注册与登录路由均 404）', async () => {
  for (const path of ['/api/auth/register', '/api/auth/login']) {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@example.com', password: 'Str0ng#Pass99' }),
    });
    assertEqual(res.status, 404, `${path} 必须返回 404`);
  }
});

await test('游客登录：设备 ID 换会话（免费 Apple ID 兜底）', async () => {
  const deviceId = 'test-device-0123456789abcdef';
  const res = await fetch(`${BASE}/api/auth/guest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId }),
  });
  const json = await res.json();
  assert(json.ok, `游客登录应成功：${JSON.stringify(json)}`);
  assert(typeof json.token === 'string' && json.token.length > 0, '应返回 token');
  assert(json.userId.startsWith('guest_'), 'userId 应为 guest_ 前缀');

  // 同一设备重复登录应得到同一 userId（会话复用同一账号）
  const again = await (await fetch(`${BASE}/api/auth/guest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId }),
  })).json();
  assertEqual(again.userId, json.userId, '同一设备应得到同一 userId');

  // 非法 deviceId → 400
  const bad = await fetch(`${BASE}/api/auth/guest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: 'x' }),
  });
  assertEqual((await bad.json()).error, 'BAD_REQUEST', '非法 deviceId 应 400');
});

// ---------------------------------------------------------------------------
// Apple 登录完整链路（与 Google 同源：handler 漏 import 只会在合法 token 时暴露）
// ---------------------------------------------------------------------------
await test('Apple 登录：合法 identityToken 走完整链路（VIP 判定不 500）', async () => {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify']
  );
  const publicJwk = {
    ...(await crypto.subtle.exportKey('jwk', keyPair.publicKey)),
    kid: 'test-apple-kid',
    alg: 'RS256',
    use: 'sig',
  };

  const appleDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pagemake-apple-'));
  fs.mkdirSync(path.join(appleDataDir, 'jwks'), { recursive: true });
  fs.writeFileSync(
    path.join(appleDataDir, 'jwks', 'apple-jwks.json'),
    JSON.stringify({ keys: [publicJwk] })
  );

  const applePort = PORT + 3;
  const appleServer = spawn(process.execPath, [path.resolve('docker/server.mjs')], {
    env: {
      ...spawnEnv,
      PORT: String(applePort),
      DATA_DIR: appleDataDir,
      APPLE_CLIENT_ID: 'com.pagemake.app',
      APPLE_JWKS_URL: 'https://127.0.0.1:1/unreachable-jwks',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  appleServer.stderr.on('data', (d) => process.stderr.write(`[apple-server] ${d}`));
  try {
    const abase = `http://127.0.0.1:${applePort}`;
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(`${abase}/healthz`)).ok) break; } catch {}
      await sleep(200);
    }

    const nonce = 'test-nonce-abc';
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(nonce));
    const nonceHash = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');

    const nowSec = Math.floor(Date.now() / 1000);
    const header = toBase64Url(JSON.stringify({ alg: 'RS256', kid: 'test-apple-kid', typ: 'JWT' }));
    const payload = toBase64Url(JSON.stringify({
      iss: 'https://appleid.apple.com',
      aud: 'com.pagemake.app',
      sub: 'apple-test-sub-001',
      email: 'apple.tester@example.com',
      nonce: nonceHash,
      iat: nowSec,
      exp: nowSec + 600,
    }));
    const signingInput = `${header}.${payload}`;
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      keyPair.privateKey,
      new TextEncoder().encode(signingInput)
    );
    const identityToken = `${signingInput}.${bytesToBase64Url(new Uint8Array(signature))}`;

    const res = await fetch(`${abase}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identityToken, nonce }),
    });
    const body = await res.json();
    assertEqual(
      res.status,
      200,
      `合法 Apple token 应登录成功；实际 ${res.status} ${JSON.stringify(body)}`
    );
    assert(body.token, '应返回会话 token');
    assertEqual(body.userId, 'apple-test-sub-001', 'userId 应为 Apple sub');
    assertEqual(body.email, 'apple.tester@example.com', '应回传邮箱');
    assert(['user', 'vip'].includes(body.role), `role 应为 user/vip，实际 ${body.role}`);
  } finally {
    appleServer.kill();
    fs.rmSync(appleDataDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 部署形态三选一：纯前端 / npm / pnpm
// ---------------------------------------------------------------------------
await test('普通用户项目模式不可用；后端形态校验按等级生效', async () => {
  for (const kind of ['npm', 'pnpm']) {
    const res = await fetch(`${BASE}/api/projects/explorer`, {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `blocked-${kind}`, kind }),
    });
    const json = await res.json();
    assertEqual(res.status, 403, `普通用户建 ${kind} 项目应被拒绝`);
    assertEqual(json.error, 'EXPLORER_REQUIRES_SVIP', `应返回 EXPLORER_REQUIRES_SVIP（实际 ${json.error}）`);
  }
  // 纯前端仍然可以
  const okRes = await fetch(`${BASE}/api/projects/explorer`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'static-ok', kind: 'static' }),
  });
  assertEqual(okRes.status, 403, '普通用户项目模式不可用（SVIP 门槛在前）');
});

await test('SVIP 非法部署形态被拒绝（INVALID_KIND，不静默降级）', async () => {
  // 该账号在下一个用例才 seed，这里先提前写入，避免回退到 dev-user
  seedUser(dataDir, 'vip-backend-001', 'svip');
  const res = await fetch(`${BASE}/api/projects/explorer`, {
    method: 'POST',
    headers: { 'X-Test-User': 'vip-backend-001', 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'bad-kind', kind: 'php' }),
  });
  assertEqual(res.status, 400, '非法 kind 应 400');
  assertEqual((await res.json()).error, 'INVALID_KIND');
});

await test('SVIP 后端项目：npm 部署 → 进程常驻 → /p/ 反向代理生效', async () => {
  const vipId = 'vip-backend-001';
  seedUser(dataDir, vipId, 'svip');
  const vipAuth = { 'X-Test-User': vipId };

  const created = await (await fetch(`${BASE}/api/projects/explorer`, {
    method: 'POST',
    headers: { ...vipAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'node-app', kind: 'npm' }),
  })).json();
  assert(created.ok, `VIP 建后端项目应成功：${JSON.stringify(created)}`);
  const id = created.project.id;
  assertEqual(created.project.kind, 'npm', '项目应记录 kind=npm');

  const pkg = JSON.stringify({
    name: 'demo-app',
    version: '1.0.0',
    private: true,
    scripts: { start: 'node server.js' },
  });
  const server = [
    "const http = require('node:http');",
    'const port = Number(process.env.PORT);',
    'http.createServer((req, res) => {',
    // 204：无 body 状态码，代理层必须传 null body（否则 Response 构造抛错 → 500）
    "  if (req.url === '/status204') { res.writeHead(204); res.end(); return; }",
    // 多条 Set-Cookie：不能被逗号合并（Expires 本身含逗号）
    "  if (req.url === '/cookies') {",
    "    res.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': [",
    "      'a=1; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT',",
    "      'b=2; Path=/',",
    '    ] });',
    "    res.end('cookies-ok');",
    '    return;',
    '  }',
    "  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });",
    "  res.end('backend-alive:' + req.url + '|prefix:' + (req.headers['x-forwarded-prefix'] || ''));",
    '}).listen(port, "127.0.0.1");',
  ].join('\n');

  for (const [filePath, content] of [['package.json', pkg], ['server.js', server]]) {
    const put = await fetch(`${BASE}/api/projects/${id}/files`, {
      method: 'POST',
      headers: { ...vipAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath, content: textToBase64(content) }),
    });
    assertEqual(put.status, 200, `写入 ${filePath} 应成功`);
  }

  const published = await (await fetch(`${BASE}/api/projects/${id}`, {
    method: 'POST',
    headers: { ...vipAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'publish', kind: 'npm' }),
  })).json();
  assert(published.ok, `发布后端项目应成功：${JSON.stringify(published)}`);
  assertEqual(published.project.status, 'processing', '后端发布应立即返回 processing');
  const ready = await waitForProjectReady(id, vipAuth);
  assert(typeof ready.project.runtimePort === 'number', '应返回内部分配的端口');

  // 反向代理：入口页与任意子路径都应落到项目自己的 Node 进程
  const root = await fetch(`${BASE}/p/${id}`);
  assertEqual(root.status, 200, '后端项目入口应 200');
  const rootText = await root.text();
  assert(
    rootText.includes(`backend-alive:/|prefix:/p/${id}`),
    `入口应剥掉 /p/<id> 前缀并透传代理前缀，实际：${rootText}`
  );

  const sub = await fetch(`${BASE}/p/${id}/api/hello?x=1`);
  assertEqual(sub.status, 200, '子路径也应被代理');
  assert((await sub.text()).includes('/api/hello?x=1'), '子路径应剥掉 /p/<id> 前缀且查询串原样透传');

  // 尾斜杠归一：/p/<id>/ 与 /p/<id> 是同一个入口
  const slash = await fetch(`${BASE}/p/${id}/`);
  assertEqual(slash.status, 200, '尾斜杠不应 404');

  // 204 无 body 状态码：修复前 Response 构造会抛错，整条请求变 500
  const noContent = await fetch(`${BASE}/p/${id}/status204`);
  assertEqual(noContent.status, 204, `上游 204 应原样透传，实际 ${noContent.status}`);

  // 多条 Set-Cookie 必须逐条透传，不能被逗号合并成一条
  const cookieRes = await fetch(`${BASE}/p/${id}/cookies`);
  assertEqual(cookieRes.status, 200, '多 Cookie 响应应 200');
  const cookieList = typeof cookieRes.headers.getSetCookie === 'function'
    ? cookieRes.headers.getSetCookie()
    : [];
  assertEqual(cookieList.length, 2, `应透传 2 条 Set-Cookie，实际 ${cookieList.length}：${JSON.stringify(cookieList)}`);

  // 刷新链接必须走后端重启链路，不能误走纯前端 HTML 入口部署。
  const refreshed = await fetch(`${BASE}/api/projects/${id}/refresh`, {
    method: 'POST',
    headers: { ...vipAuth, 'Content-Type': 'application/json' },
    body: '{}',
  });
  const refreshedJson = await refreshed.json();
  assertEqual(refreshed.status, 200, '后端项目刷新应成功');
  assertEqual(refreshedJson.project.status, 'processing', '后端刷新应立即返回 processing');
  const refreshedReady = await waitForProjectReady(id, vipAuth);
  assert(typeof refreshedReady.project.runtimePort === 'number', '刷新后应重新分配运行端口');

  // 项目删除后进程必须被回收（否则端口泄漏、内存泄漏）
  const del = await fetch(`${BASE}/api/projects/${id}`, {
    method: 'POST',
    headers: { ...vipAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'delete' }),
  });
  assertEqual(del.status, 200, '删除后端项目应成功');

  const runtimeConfig = await (await fetch(`${BASE}/api/config`)).json();
  assertEqual(
    runtimeConfig.runtime?.running,
    0,
    '删除后端项目后常驻进程必须被回收，不能继续占用端口'
  );
});

// 用户后端应用按「部署在站点根目录」假设写代码，代理必须补齐前缀语义，否则
// 应用内按钮的表现不确定：res.redirect('/x')（Location 不改写）跳到宿主根、
// fetch('/api/x')（绝对路径，<base> 管不到）打到宿主自身 API → 401/404 →
// 应用前端错误处理把界面重置回初始状态。
await test('后端项目代理改写：Location / Set-Cookie / HTML 注入 / Referer 兜底', async () => {
  const rwUserId = 'dev-proxy-rewrite';
  seedUser(dataDir, rwUserId, 'svip');
  const rwAuth = { 'X-Test-User': rwUserId };

  const created = await (await fetch(`${BASE}/api/projects/explorer`, {
    method: 'POST',
    headers: { ...rwAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'rewrite-app', kind: 'js' }),
  })).json();
  assert(created.ok, `建 js 项目应成功：${JSON.stringify(created)}`);
  const id = created.project.id;

  // js 形态（单文件，无 npm install）行为与 npm 形态同一条代理链路
  const serverSrc = [
    "const http = require('node:http');",
    "const zlib = require('node:zlib');",
    'const port = Number(process.env.PORT);',
    'const pageHtml = (prefix) => [',
    "  '<!doctype html><html><head><title>t</title></head><body>',",
    "  '<link rel=\"stylesheet\" href=\"style.css\">',",
    "  '<a href=\"/\">home</a><a href=\"/page2\">p2</a>',",
    "  '<a href=\"' + prefix + '/self\">self</a>',",
    "  '<form action=\"/submit\" method=\"post\"><input name=\"a\"></form>',",
    "  '<img srcset=\"/a.png 1x, /b.png 2x\" src=\"/logo.png\">',",
    "  '<script>fetch(\\'/api/x\\').then(function(r){return r.json()});'",
    "    + 'var u=new URL(\\'/u\\', location.href);</script>',",
    "  '</body></html>',",
    "].join('');",
    'http.createServer((req, res) => {',
    "  const prefix = req.headers['x-forwarded-prefix'] || '';",
    "  if (req.url === '/' || req.url === '/html') {",
    "    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });",
    '    res.end(pageHtml(prefix));',
    '    return;',
    '  }',
    "  if (req.url === '/302root') { res.writeHead(302, { location: '/' }); res.end(); return; }",
    "  if (req.url === '/302abs') { res.writeHead(302, { location: '/done?x=1' }); res.end(); return; }",
    "  if (req.url === '/302rel') { res.writeHead(302, { location: 'step3.html' }); res.end(); return; }",
    "  if (req.url === '/302proto') { res.writeHead(302, { location: '//evil.example/x' }); res.end(); return; }",
    "  if (req.url === '/302ext') { res.writeHead(302, { location: 'https://example.com/y' }); res.end(); return; }",
    "  if (req.url === '/302self') {",
    "    res.writeHead(302, { location: 'http://127.0.0.1:' + port + '/self' });",
    '    res.end();',
    '    return;',
    '  }',
    "  if (req.url === '/cookiepath') {",
    "    res.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': [",
    "      'sid=abc; Path=/; HttpOnly',",
    "      'plain=1',",
    '    ] });',
    "    res.end('cookies-ok');",
    '    return;',
    '  }',
    "  if (req.url === '/gbk') {",
    "    res.writeHead(200, { 'content-type': 'text/html; charset=iso-8859-1' });",
    "    res.end(Buffer.from('<html><body>proxy-untouched-latin1-e9</body></html>', 'latin1'));",
    '    return;',
    '  }',
    "  if (req.url === '/gz') {",
    "    const gz = zlib.gzipSync(Buffer.from('<html><body>gz-content</body></html>'));",
    "    res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });",
    '    res.end(gz);',
    '    return;',
    '  }',
    "  if (req.url === '/big') {",
    "    const body = '<div class=\"x\">p</div>'.repeat(12000);",
    "    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });",
    '    res.end(body);',
    '    return;',
    '  }',
    "  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });",
    "  res.end('backend-alive:' + req.url);",
    "}).listen(port, '127.0.0.1');",
  ].join('\n');
  const put = await fetch(`${BASE}/api/projects/${id}/files`, {
    method: 'POST',
    headers: { ...rwAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'server.js', content: textToBase64(serverSrc) }),
  });
  assertEqual(put.status, 200, '写入 server.js 应成功');

  const published = await (await fetch(`${BASE}/api/projects/${id}`, {
    method: 'POST',
    headers: { ...rwAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'publish', kind: 'js' }),
  })).json();
  assert(published.ok, `发布 js 后端项目应成功：${JSON.stringify(published)}`);
  await waitForProjectReady(id, rwAuth);

  // ---- Location 改写：POST-Redirect-GET 是应用表单推进的主流模式 ----
  const manual = (path) => fetch(`${BASE}/p/${id}${path}`, { redirect: 'manual' });
  const r1 = await manual('/302root');
  assertEqual(r1.status, 302, '上游 302 应透传 302');
  assertEqual(r1.headers.get('location'), `/p/${id}`, `Location: / 应改写为应用入口，实际 ${r1.headers.get('location')}`);
  const r2 = await manual('/302abs');
  assertEqual(r2.headers.get('location'), `/p/${id}/done?x=1`, '根绝对 Location 应加公开前缀');
  const r3 = await manual('/302rel');
  assertEqual(r3.headers.get('location'), 'step3.html', '相对 Location 原样');
  const r4 = await manual('/302proto');
  assertEqual(r4.headers.get('location'), '//evil.example/x', '协议相对 Location 原样');
  const r5 = await manual('/302ext');
  assertEqual(r5.headers.get('location'), 'https://example.com/y', '外链 Location 原样');
  const r6 = await manual('/302self');
  assertEqual(r6.headers.get('location'), `/p/${id}/self`, '按上游 Host 拼的 127.0.0.1 绝对 Location 应还原为公开前缀');

  // ---- Set-Cookie Path 收进应用前缀（防应用 cookie 泄漏到宿主 /admin） ----
  const cookieRes = await fetch(`${BASE}/p/${id}/cookiepath`);
  const cookieList = typeof cookieRes.headers.getSetCookie === 'function'
    ? cookieRes.headers.getSetCookie()
    : [];
  assertEqual(cookieList.length, 2, `应透传 2 条 Set-Cookie，实际 ${cookieList.length}`);
  assert(cookieList[0].includes(`Path=/p/${id}/`), `显式 Path=/ 应改写为应用前缀，实际：${cookieList[0]}`);
  assert(cookieList[1].includes(`Path=/p/${id}/`), `无 Path 的 cookie 应补应用前缀 Path，实际：${cookieList[1]}`);

  // ---- HTML 注入：<base> + 静态改写 + 运行时 shim ----
  const htmlRes = await fetch(`${BASE}/p/${id}/html`);
  assertEqual(htmlRes.status, 200);
  const html = await htmlRes.text();
  assert(html.includes(`<base href="/p/${id}/">`), '应注入项目级 <base>');
  assert(html.includes('href="style.css"'), '相对引用保留');
  assert(html.includes('href="./"'), '根引用 / 应改写为 ./');
  assert(html.includes('href="page2"'), '根绝对链接应改写为相对');
  assert(html.includes(`href="/p/${id}/self"`), '已带公开前缀的引用应原样保留');
  assert(html.includes('action="submit"'), 'form action 根绝对应改写为相对');
  assert(html.includes('srcset="a.png 1x, b.png 2x"'), 'srcset 应逐候选改写');
  assert(html.includes("fetch('/api/x')"), 'script 内容里的 fetch 字符串不被静态改写（由 shim 运行时处理）');
  assert(html.includes('data-pagemake-proxy-shim'), '应注入运行时 shim');
  assert(html.includes(`var BASE = '/p/${id}'`), 'shim BASE 应为实际公开前缀');
  const entryRes = await fetch(`${BASE}/p/${id}`);
  const entryHtml = await entryRes.text();
  assert(
    entryHtml.includes(`<base href="/p/${id}/">`) && entryHtml.includes('data-pagemake-proxy-shim'),
    '入口页同样应注入 base 与 shim'
  );

  // ---- 非 UTF-8 字符集：跳过改写（decode→re-encode 会乱码） ----
  const gbkRes = await fetch(`${BASE}/p/${id}/gbk`);
  const gbkText = new TextDecoder('latin1').decode(new Uint8Array(await gbkRes.arrayBuffer()));
  assert(gbkText.includes('proxy-untouched-latin1-e9'), 'latin1 内容应原样透传');
  assert(
    !gbkText.includes('<base') && !gbkText.includes('data-pagemake-proxy-shim'),
    '非 UTF-8 字符集应整段跳过改写'
  );

  // ---- 上游强行压缩：整段跳过改写（fetch 会自动解压，解压后内容不应被注入） ----
  const gzRes = await fetch(`${BASE}/p/${id}/gz`);
  const gzText = await gzRes.text();
  assert(gzText.includes('gz-content'), 'gzip 响应解压后内容完整');
  assert(!gzText.includes('<base') && !gzText.includes('data-pagemake-proxy-shim'), '压缩响应应整段跳过改写');

  // ---- 大响应耗时（改写必须线性，防 ReDoS 回归） ----
  const started = Date.now();
  const bigRes = await fetch(`${BASE}/p/${id}/big`);
  const bigHtml = await bigRes.text();
  const bigCost = Date.now() - started;
  assert(bigHtml.length > 200 * 1024, '大响应应超过 200KB');
  assert(bigHtml.includes(`<base href="/p/${id}/">`), '大响应也应被注入 base');
  assert(bigCost < 1500, `200KB HTML 代理改写 + 传输应在 1.5s 内完成，实际 ${bigCost}ms`);

  // ---- Referer 兜底：location.href='/x' 这类 shim 覆盖不到的逃逸 ----
  const fromPage = await fetch(`${BASE}/nowhere-page`, {
    headers: { referer: `${BASE}/p/${id}/html` },
    redirect: 'manual',
  });
  assertEqual(fromPage.status, 302, '未匹配路由且来源是应用页 → 302 回应用内同名路径');
  assertEqual(fromPage.headers.get('location'), `/p/${id}/nowhere-page`, '兜底目标应是应用内同名路径');
  const noRef = await fetch(`${BASE}/nowhere-page`, { redirect: 'manual' });
  assertEqual(noRef.status, 404, '无 Referer 不兜底（保持宿主 404 语义）');
  const postRef = await fetch(`${BASE}/nowhere-page`, {
    method: 'POST',
    headers: { referer: `${BASE}/p/${id}/html`, 'Content-Type': 'application/json' },
    body: '{}',
    redirect: 'manual',
  });
  assertEqual(postRef.status, 404, 'POST 不兜底（重定向会丢请求体）');

  // ---- 清理 ----
  const del = await fetch(`${BASE}/api/projects/${id}`, {
    method: 'POST',
    headers: { ...rwAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'delete' }),
  });
  assertEqual(del.status, 200, '删除后端项目应成功');
});

// js 形态（单文件 Node 脚本）没有 package.json 是**正常状态**。
// refresh.js 曾漏掉 `kind !== 'js'` 例外，导致这类项目永远刷新失败
// （400 MISSING_PACKAGE_JSON），而 publish 走的是 projects/[id].js 的正确判定。
await test('js 形态后端项目：无 package.json 也能刷新链接', async () => {
  const jsUserId = 'dev-js-refresh';
  seedUser(dataDir, jsUserId, 'svip');
  const jsAuth = { 'X-Test-User': jsUserId };

  const created = await (await fetch(`${BASE}/api/projects/explorer`, {
    method: 'POST',
    headers: { ...jsAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'js-app', kind: 'js' }),
  })).json();
  assert(created.ok, `建 js 项目应成功：${JSON.stringify(created)}`);
  const id = created.project.id;

  const serverSrc = [
    "const http = require('node:http');",
    'http.createServer((req, res) => {',
    "  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });",
    "  res.end('js-runtime-ok');",
    "}).listen(Number(process.env.PORT), '127.0.0.1');",
  ].join('\n');
  const put = await fetch(`${BASE}/api/projects/${id}/files`, {
    method: 'POST',
    headers: { ...jsAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'server.js', content: textToBase64(serverSrc) }),
  });
  assertEqual(put.status, 200, '写入 server.js 应成功（故意不写 package.json）');

  const published = await (await fetch(`${BASE}/api/projects/${id}`, {
    method: 'POST',
    headers: { ...jsAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'publish', kind: 'js' }),
  })).json();
  assert(published.ok, `发布 js 项目应成功：${JSON.stringify(published)}`);
  await waitForProjectReady(id, jsAuth);

  const refreshed = await fetch(`${BASE}/api/projects/${id}/refresh`, {
    method: 'POST',
    headers: { ...jsAuth, 'Content-Type': 'application/json' },
    body: '{}',
  });
  const refreshedJson = await refreshed.json();
  assertEqual(
    refreshed.status,
    200,
    `js 形态刷新不应要求 package.json，实际 ${refreshed.status}：${JSON.stringify(refreshedJson)}`
  );
  await waitForProjectReady(id, jsAuth);
  const live = await fetch(`${BASE}/p/${id}`);
  assertEqual(live.status, 200, '刷新后 js 项目仍可访问');
  assert((await live.text()).includes('js-runtime-ok'), '刷新后应返回项目自身响应');

  const del = await fetch(`${BASE}/api/projects/${id}`, {
    method: 'POST',
    headers: { ...jsAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'delete' }),
  });
  assertEqual(del.status, 200, '删除 js 项目应成功');
});

await test('导出备份：VIP 可下载 ZIP，普通用户被拒', async () => {
  // 普通用户：先建一个纯前端项目
  const created = await (await fetch(`${BASE}/api/projects/paste`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ html: '<h1>export-me</h1>', css: 'h1{color:red}' }),
  })).json();
  assert(created.ok, '创建项目应成功');
  const id = created.project.id;

  const denied = await fetch(`${BASE}/api/projects/${id}/export`, { headers: AUTH });
  assertEqual(denied.status, 403, '普通用户导出应被拒绝');
  assertEqual((await denied.json()).error, 'EXPORT_REQUIRES_VIP');

  // 把项目所有者改成 VIP：导出应返回可解压的 ZIP
  seedUser(dataDir, 'dev-user', 'svip');
  const probe = await (await fetch(`${BASE}/api/stats`, { headers: AUTH })).json();
  assertEqual(probe.tier, 'svip', `seed 后 tier 应为 svip（实际 ${probe.tier}，role=${probe.role}）`);
  const res = await fetch(`${BASE}/api/projects/${id}/export`, { headers: AUTH });
  assertEqual(res.status, 200, 'VIP 导出应成功');
  assertEqual(res.headers.get('content-type'), 'application/zip');
  const buffer = new Uint8Array(await res.arrayBuffer());
  const { unzip } = await import('../backend/lib/zip.js');
  const files = await unzip(buffer);
  assert(files.size >= 1, '导出包应至少含一个文件');
  const names = [...files.keys()];
  assert(names.some((n) => /\.html?$/i.test(n)), `导出包应含 HTML（实际 ${names.join(',')}）`);
  assert(!names.some((n) => n.includes('node_modules')), '不应导出 node_modules');
});

await test('POST 删除项目（网关拦截 DELETE 的替代方案）', async () => {
  // 创建
  const created = await (await fetch(`${BASE}/api/projects/paste`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'edgeone', html: '<p>post delete</p>' }),
  })).json();
  assert(created.ok, '创建应成功');
  const id = created.project.id;

  // POST + action=delete
  const del = await (await fetch(`${BASE}/api/projects/${id}`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'delete' }),
  })).json();
  assert(del.ok && del.deleted === true, `POST 删除应成功：${JSON.stringify(del)}`);

  // 公开链接应失效
  const page = await fetch(`${BASE}/p/${id}`);
  assertEqual(page.status, 404, '删除后公开链接应 404');
});

await test('粘贴：CSS 文件名跟随 HTML 的 link 引用', async () => {
  const html = '<!DOCTYPE html><html><head><link rel="stylesheet" href="main.css"></head><body><h1>styled</h1></body></html>';
  const res = await (await fetch(`${BASE}/api/projects/paste`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ html, css: 'h1{color:blue}', name: 'link测试' }),
  })).json();
  assert(res.ok, `创建应成功：${JSON.stringify(res)}`);
  const id = res.project.id;

  // CSS 应保存为用户指定的 main.css
  const css = await fetch(`${BASE}/p/${id}/main.css`);
  assertEqual(css.status, 200, 'main.css 应可访问');
  assertEqual(await css.text(), 'h1{color:blue}', 'CSS 内容应一致');

  // 不应额外注入 style.css
  const page = await (await fetch(`${BASE}/p/${id}`)).text();
  assert(!page.includes('style.css'), '已有 link 时不应重复注入 style.css');
  assert(page.includes('main.css'), '页面应保留用户的 main.css 引用');
});

await test('游客限 1 个：第二次创建返回 GUEST_LIMIT', async () => {
  const deviceId = `guest-limit-${Date.now()}`;
  const login = await (await fetch(`${BASE}/api/auth/guest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId }),
  })).json();
  assert(login.ok, '游客登录应成功');
  // 调试模式下用 X-Test-User 指定游客身份（DEV_NO_AUTH 会跳过鉴权）
  const guestAuth = { 'X-Test-User': login.userId };

  // 第一个成功
  const first = await (await fetch(`${BASE}/api/projects/paste`, {
    method: 'POST',
    headers: { ...guestAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ html: '<p>guest one</p>' }),
  })).json();
  assert(first.ok, '游客首个项目应成功');

  // 第二个被拒
  const second = await (await fetch(`${BASE}/api/projects/paste`, {
    method: 'POST',
    headers: { ...guestAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ html: '<p>guest two</p>' }),
  })).json();
  assertEqual(second.error, 'GUEST_LIMIT', '游客第二个项目应返回 GUEST_LIMIT');
});

// ---------------------------------------------------------------------------
// 项目模式（explorer）：空白项目 → 虚拟文件创建/读取/校验 → publish 生成链接
// ---------------------------------------------------------------------------
await test('项目模式：创建空白项目（无文件无链接）', async () => {
  const res = await (await fetch(`${BASE}/api/projects/explorer`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '我的项目模式' }),
  })).json();
  assert(res.ok, `创建应成功：${JSON.stringify(res)}`);
  explorerId = res.project.id;
  assertEqual(res.project.sourceType, 'explorer', 'sourceType 应为 explorer');
  assertEqual(res.project.fileCount, 0, '初始文件数应为 0');
  assertEqual(res.project.url, null, '初始不应有链接');
  assertEqual(res.project.name, '我的项目模式', '名称应保存');
});

await test('项目模式：空项目公开访问 404、publish 报 NO_ENTRY', async () => {
  const page = await fetch(`${BASE}/p/${explorerId}`);
  assertEqual(page.status, 404, '无入口时公开链接应 404');

  const pub = await (await fetch(`${BASE}/api/projects/${explorerId}`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'publish' }),
  })).json();
  assertEqual(pub.error, 'NO_ENTRY', '无 HTML 文件时 publish 应报 NO_ENTRY');
});

await test('项目模式：创建虚拟文件夹内文件（index.html + css/style.css）', async () => {
  const html = '<!DOCTYPE html><html><head><link rel="stylesheet" href="css/style.css"></head><body><h1>项目模式页</h1></body></html>';
  const add1 = await (await fetch(`${BASE}/api/projects/${explorerId}/files`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'index.html', content: textToBase64(html) }),
  })).json();
  assert(add1.ok, `添加 index.html 应成功：${JSON.stringify(add1)}`);
  assertEqual(add1.project.entryPath, 'index.html', '首个 html 应自动成为入口');

  const add2 = await (await fetch(`${BASE}/api/projects/${explorerId}/files`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'css/style.css', content: textToBase64('h1{color:red}') }),
  })).json();
  assert(add2.ok, `添加 css/style.css 应成功：${JSON.stringify(add2)}`);
  assertEqual(add2.project.fileCount, 2, '文件数应为 2');
  assert(add2.project.folders.includes('css'), '文件路径的父目录应持久化为文件夹');
});

await test('项目模式：空文件夹可创建、重命名并删除', async () => {
  const request = async (body) => (await fetch(`${BASE}/api/projects/${explorerId}/files`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })).json();
  const created = await request({ action: 'createFolder', path: 'assets/images' });
  assert(created.ok, `创建文件夹应成功：${JSON.stringify(created)}`);
  assert(created.project.folders.includes('assets'), '应保留父文件夹 assets');
  assert(created.project.folders.includes('assets/images'), '应保留空文件夹 assets/images');

  const renamed = await request({ action: 'rename', from: 'assets', to: 'static' });
  assert(renamed.ok, `重命名文件夹应成功：${JSON.stringify(renamed)}`);
  assert(renamed.project.folders.includes('static/images'), '子文件夹应随父目录迁移');
  assert(!renamed.project.folders.includes('assets'), '旧文件夹不应残留');

  const removed = await request({ action: 'removeFolder', path: 'static' });
  assert(removed.ok, `删除文件夹应成功：${JSON.stringify(removed)}`);
  assert(!removed.project.folders.some((folder) => folder === 'static' || folder.startsWith('static/')),
    '删除文件夹后其子树不应残留');
});

await test('项目模式：文件可重命名且内容保留', async () => {
  const request = async (body) => (await fetch(`${BASE}/api/projects/${explorerId}/files`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })).json();
  const renamed = await request({ action: 'rename', from: 'css/style.css', to: 'css/theme.css' });
  assert(renamed.ok, `重命名文件应成功：${JSON.stringify(renamed)}`);
  assert(renamed.project.files.some((file) => file.path === 'css/theme.css'), '应出现新路径');
  assert(!renamed.project.files.some((file) => file.path === 'css/style.css'), '旧路径应消失');
  const content = await (await fetch(`${BASE}/api/projects/${explorerId}/files?path=css%2Ftheme.css`, {
    headers: AUTH,
  })).json();
  assertEqual(base64ToText(content.content), 'h1{color:red}', '重命名后内容应保留');
});

await test('项目模式：重命名含文件的文件夹后目录与入口同步迁移', async () => {
  const create = await (await fetch(`${BASE}/api/projects/explorer`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'rename-folder-files' }),
  })).json();
  const id = create.project.id;
  const request = async (body) => (await fetch(`${BASE}/api/projects/${id}/files`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })).json();

  assert((await request({ action: 'createFolder', path: 'pages' })).ok, '创建 pages 应成功');
  assert((await request({
    path: 'pages/about.html',
    content: textToBase64('<html><body>about</body></html>'),
  })).ok, '创建 pages/about.html 应成功');
  assert((await request({
    path: 'pages/detail.html',
    content: textToBase64('<html><body>detail</body></html>'),
  })).ok, '创建 pages/detail.html 应成功');

  const renamed = await request({ action: 'rename', from: 'pages', to: 'content' });
  assert(renamed.ok, `重命名文件夹应成功：${JSON.stringify(renamed)}`);
  assert(renamed.project.files.some((file) => file.path === 'content/about.html'),
    '文件应迁移到 content/about.html');
  assert(!renamed.project.files.some((file) => file.path.startsWith('pages/')),
    '旧 pages 路径不应残留');
  assert(renamed.project.folders.includes('content'), '新文件夹 content 应保留');
  assert(!renamed.project.folders.includes('pages'), '旧文件夹 pages 不应残留');
  assertEqual(renamed.project.entryPath, 'content/about.html', '入口应随文件夹迁移');
});

await test('项目模式：新建 HTML 起始模板引用 style.css', async () => {
  const source = await (await import('node:fs/promises')).readFile('ios/PageMake/Views/ExplorerView.swift', 'utf8');
  assert(source.includes('<link rel="stylesheet" href="\\(cssHref)">'),
    '资源管理器 HTML 起始模板必须显式引用 style.css');
});

await test('项目模式：重命名冲突与非法目标被拒绝', async () => {
  const request = async (body) => (await fetch(`${BASE}/api/projects/${explorerId}/files`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })).json();

  const create = async (path, content) => request({
    path,
    content: textToBase64(content),
  });
  assert((await create('about.html', '<p>about</p>')).ok, '应能创建 about.html');
  assert((await create('assets/app.js', 'console.log(1)')).ok, '应能创建 assets/app.js');

  const folderOnFile = await request({ action: 'createFolder', path: 'about.html' });
  assertEqual(folderOnFile.error, 'CONFLICT', '不能在文件路径上创建文件夹');
  const fileUnderFile = await request({ action: 'createFolder', path: 'about.html/nested' });
  assertEqual(fileUnderFile.error, 'CONFLICT', '不能在文件下创建子目录');

  const folderCollision = await request({ action: 'rename', from: 'assets', to: 'css' });
  assertEqual(folderCollision.error, 'CONFLICT', '文件夹不能重命名为已有目录');

  const fileCollision = await request({ action: 'rename', from: 'about.html', to: 'index.html' });
  assertEqual(fileCollision.error, 'CONFLICT', '文件不能覆盖已有文件');

  const badFileTarget = await request({ action: 'rename', from: 'about.html', to: 'about.txt' });
  assertEqual(badFileTarget.error, 'BAD_REQUEST', '文件重命名仍须限制白名单扩展名');
});

await test('项目模式：非法扩展名与路径穿越被拒绝', async () => {
  const bad1 = await (await fetch(`${BASE}/api/projects/${explorerId}/files`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'evil.exe', content: textToBase64('MZbinary') }),
  })).json();
  assertEqual(bad1.error, 'BAD_REQUEST', '.exe 应被拒绝');

  const bad2 = await (await fetch(`${BASE}/api/projects/${explorerId}/files`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: '../escape.html', content: textToBase64('<p>x</p>') }),
  })).json();
  assertEqual(bad2.error, 'BAD_REQUEST', '路径穿越应被拒绝');

  const bad3 = await (await fetch(`${BASE}/api/projects/${explorerId}/files`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'a\\b.html', content: textToBase64('<p>x</p>') }),
  })).json();
  assertEqual(bad3.error, 'BAD_REQUEST', '反斜杠路径应被拒绝');
});

await test('项目模式：读取文件内容（GET 回读一致，含中文）', async () => {
  const res = await (await fetch(`${BASE}/api/projects/${explorerId}/files?path=css%2Ftheme.css`, { headers: AUTH })).json();
  assert(res.ok, '读取应成功');
  assertEqual(base64ToText(res.content), 'h1{color:red}', 'CSS 内容应一致');

  const missing = await fetch(`${BASE}/api/projects/${explorerId}/files?path=nope.html`, { headers: AUTH });
  assertEqual(missing.status, 404, '不存在的文件应 404');
});

await test('项目模式：publish 生成链接 → 公开访问生效', async () => {
  // 文件重命名测试已把 css/style.css 改为 css/theme.css，先同步入口引用
  const rewrite = await (await fetch(`${BASE}/api/projects/${explorerId}/files`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path: 'index.html',
      content: textToBase64('<!DOCTYPE html><html><head><link rel="stylesheet" href="css/theme.css"></head><body><h1>项目模式页</h1></body></html>'),
    }),
  })).json();
  assert(rewrite.ok, '更新入口 CSS 引用应成功');

  const res = await (await fetch(`${BASE}/api/projects/${explorerId}`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'publish' }),
  })).json();
  assert(res.ok, `publish 应成功：${JSON.stringify(res)}`);
  assert(res.project.url?.includes(`/p/${explorerId}`), '应生成公开链接');
  assertEqual(res.project.entryPath, 'index.html', '入口应为 index.html');

  const page = await fetch(`${BASE}/p/${explorerId}`);
  assertEqual(page.status, 200, 'publish 后入口应可访问');
  const text = await page.text();
  assert(text.includes('项目模式页'), '页面应包含内容');

  const css = await fetch(`${BASE}/p/${explorerId}/css/theme.css`);
  assertEqual(css.status, 200, '虚拟文件夹内 CSS 应可访问');
  assertEqual(await css.text(), 'h1{color:red}', 'CSS 内容应一致');
});

await test('项目模式：PHP 文件被拒绝（已移除 PHP 运行时）', async () => {
  const add = await (await fetch(`${BASE}/api/projects/${explorerId}/files`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'api.php', content: textToBase64('<?php echo "PHP_OK_12345";') }),
  })).json();
  assertEqual(add.error, 'BAD_REQUEST', '添加 .php 应被拒绝');
});

await test('粘贴：PHP 字段被忽略 → 仍按 HTML 建站', async () => {
  const res = await (await fetch(`${BASE}/api/projects/paste`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ html: '<p>only html</p>', php: '<?php echo "PASTE_PHP_67890";', name: '忽略PHP' }),
  })).json();
  assert(res.ok, `HTML 粘贴应成功：${JSON.stringify(res)}`);
  assertEqual(res.project.entryPath, 'index.html', '入口必须是 index.html');
  assert(!res.project.files.some((f) => f.path.endsWith('.php')), '不得生成 PHP 文件');

  // 粘贴空 HTML 应拒绝（PHP 不再作为入口）
  const empty = await (await fetch(`${BASE}/api/projects/paste`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ html: '  ', php: '' }),
  })).json();
  assertEqual(empty.error, 'BAD_REQUEST', '空 HTML 应报 BAD_REQUEST');
});

await test('账号删除：删除项目与用户 → 会话失效', async () => {
  const guest = await (await fetch(`${BASE}/api/auth/guest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: `delete-${Date.now()}-abcdef` }),
  })).json();
  assert(guest.ok, `创建测试用户应成功：${JSON.stringify(guest)}`);
  // DEV_NO_AUTH 下用 X-Test-User 指定身份；真实 token 一并携带（生产环境走令牌）
  const userAuth = { 'X-Test-User': guest.userId, 'X-Pagemake-Token': guest.token };

  // 建一个项目
  const created = await (await fetch(`${BASE}/api/projects/paste`, {
    method: 'POST',
    headers: { ...userAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ html: '<p>bye</p>' }),
  })).json();
  assert(created.ok, '建项目应成功');

  // 不带 confirm 应拒绝
  const noConfirm = await (await fetch(`${BASE}/api/auth/delete`, {
    method: 'POST',
    headers: { ...userAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })).json();
  assertEqual(noConfirm.error, 'BAD_REQUEST', '缺 confirm 应 400');

  // 确认删除
  const del = await (await fetch(`${BASE}/api/auth/delete`, {
    method: 'POST',
    headers: { ...userAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: true }),
  })).json();
  assert(del.ok && del.deleted === true, '删除应成功');

  // 用户记录应从 KV（磁盘）中消失（DEV_NO_AUTH 下令牌校验被跳过，直接查存储验证）
  const userFile = path.join(dataDir, kvKeys.user(guest.userId));
  assert(!fs.existsSync(userFile), '用户记录应已删除');

  // 项目相关 KV 也必须全部清除（site_ 文件 / project_ 记录 / uproject_ 索引 / meta_ 元信息）
  // 历史 bug：这里只校验了 user_ 记录，导致索引 key 未 decodeKey 时删除静默失败，
  // 数据残留且 /p/<id> 公开链接继续可访问——用户以为删号成功，内容却仍在公网
  const leftovers = [];
  for (const name of fs.readdirSync(dataDir)) {
    if (name.startsWith(`site_${kvKeys.project(created.project.id).slice('project_'.length)}`)) {
      leftovers.push(name);
    }
  }
  assertEqual(leftovers.length, 0, `site_ 文件应全部删除，实际残留：${leftovers.join(',')}`);

  const indexPrefix = kvKeys.userProject(guest.userId, '');
  const indexLeftovers = fs.readdirSync(dataDir).filter((n) => n.startsWith(indexPrefix));
  assertEqual(indexLeftovers.length, 0, `uproject_ 索引应全部删除，实际残留：${indexLeftovers.join(',')}`);

  const projectFile = path.join(dataDir, kvKeys.project(created.project.id));
  assert(!fs.existsSync(projectFile), 'project_ 记录应已删除');

  const metaFile = path.join(dataDir, kvKeys.siteMeta(created.project.id));
  assert(!fs.existsSync(metaFile), 'meta_ 元信息应已删除');

  // 公开链接必须失效（隐私硬性要求：删号后内容不得再被任何人访问）
  const pub = await fetch(`${BASE}/p/${created.project.id}`);
  assertEqual(pub.status, 404, '删号后公开链接应 404');

  // 用户 token 对应身份已删除；即使 DEV_NO_AUTH 放行调试身份，数据也不得复活
  const relist = await fetch(`${BASE}/api/projects`, { headers: userAuth });
  assertEqual(relist.status, 200, '调试模式请求可返回空列表');
  assertEqual((await relist.json()).projects.length, 0, '删除后项目列表必须为空');
});

await test('项目模式：平铺三文件（无文件夹）→ 引用写错目录也能显示', async () => {
  // 新手场景：三个文件全在根目录，HTML 里却引用了 css/style.css
  const id3 = (await (await fetch(`${BASE}/api/projects/explorer`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '平铺三文件' }),
  })).json()).project.id;

  const put = async (p, text) => {
    const r = await (await fetch(`${BASE}/api/projects/${id3}/files`, {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: p, content: textToBase64(text) }),
    })).json();
    assert(r.ok, `添加 ${p} 应成功：${JSON.stringify(r)}`);
  };
  await put('about.html', '<!DOCTYPE html><html><head><link rel="stylesheet" href="css/style.css"><script src="js/app.js"></script></head><body><h1>flat ok</h1></body></html>');
  await put('style.css', 'h1{color:green}');
  await put('app.js', 'console.log("hi")');

  // publish：唯一 html（about.html）应自动成为入口
  const pub = await (await fetch(`${BASE}/api/projects/${id3}`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'publish' }),
  })).json();
  assert(pub.ok, `publish 应成功：${JSON.stringify(pub)}`);
  assertEqual(pub.project.entryPath, 'about.html', '平铺三个文件时唯一 html 应成为入口');

  // 页面可访问
  const page = await fetch(`${BASE}/p/${id3}`);
  assertEqual(page.status, 200, '入口应可访问');

  // 宽容兜底：引用 css/style.css（实际文件是 style.css）→ 仍返回正确内容
  const css = await fetch(`${BASE}/p/${id3}/css/style.css`);
  assertEqual(css.status, 200, '写错目录的引用应被宽容兜底');
  assertEqual(await css.text(), 'h1{color:green}', '兜底应返回 style.css 内容');

  const js = await fetch(`${BASE}/p/${id3}/js/app.js`);
  assertEqual(js.status, 200, '写错目录的 JS 引用应被宽容兜底');

  // 诊断给出新手友好提示
  const diag = pub.project.diagnostics.find((d) => d.kind === 'missingFile' && d.detail.includes('style.css'));
  assert(diag, '应产出 missingFile 诊断');
  assert(diag.detail.includes('其实'), `诊断应说明文件实际位置：${diag.detail}`);
  assert(diag.suggestion.includes('不用建文件夹'), '建议文案应平易近人');
});

await test('删除项目后公开链接失效', async () => {  const res = await fetch(`${BASE}/api/projects/${projectId}`, { method: 'DELETE', headers: AUTH });
  assert((await res.json()).ok, '删除应成功');
  const page = await fetch(`${BASE}/p/${projectId}`);
  assert(page.status === 404, '删除后入口应 404');
});

await test('服务重启后数据仍在（磁盘 KV 持久化）', async () => {
  // 用同一 DATA_DIR 再起一个实例，验证项目记录与文件未丢失
  const server2 = spawn(process.execPath, [path.resolve('docker/server.mjs')], {
    env: { ...spawnEnv, PORT: String(PORT + 1) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const base2 = `http://127.0.0.1:${PORT + 1}`;
    for (let i = 0; i < 50; i++) {
      try {
        if ((await fetch(`${base2}/healthz`)).ok) break;
      } catch {}
      await sleep(200);
    }
    // 已删除的项目应仍不存在；未删除的入口文件应仍在
    const gone = await fetch(`${base2}/p/${projectId}`);
    assert(gone.status === 404, '已删除项目应保持 404');
    const res = await fetch(`${base2}/api/projects`, { headers: AUTH });
    const json = await res.json();
    assert(Array.isArray(json.projects), '重启后列表接口应正常');
  } finally {
    killProcessTree(server2);
  }
});

// ---------------------------------------------------------------------------
// 站点访问统计：入口页命中计数 → 项目详情实时可见 → 项目删除后 stat_ 记录清理
await test('站点访问统计：入口命中计数 / 项目隔离 / 删除清理', async () => {
  const stAuth = { 'X-Test-User': 'dev-visit-stats' };
  seedUser(dataDir, 'dev-visit-stats', 'svip');

  const pasteOne = async (name) => {
    const res = await (await fetch(`${BASE}/api/projects/paste`, {
      method: 'POST',
      headers: { ...stAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        html: `<!doctype html><html><head><title>${name}</title></head><body><p>${name}</p></body></html>`,
        css: 'body{margin:0}',
      }),
    })).json();
    assert(res.ok, `粘贴建站应成功：${JSON.stringify(res)}`);
    return res.project.id;
  };
  const idA = await pasteOne('visit-a');
  const idB = await pasteOne('visit-b');

  // 命中 A 入口 2 次；B 不访问。入口 404 的子路径不应计数（走 [[default]] 不入口）
  for (let i = 0; i < 2; i++) {
    const page = await fetch(`${BASE}/p/${idA}`);
    assertEqual(page.status, 200, '入口页应 200');
    await page.text();
  }
  const detail = await (await fetch(`${BASE}/api/projects/${idA}`, { headers: stAuth })).json();
  assert(detail.ok, '详情接口应成功');
  assertEqual(detail.visitStats.total, 2, `入口命中应计数 2 次，实际 ${JSON.stringify(detail.visitStats)}`);
  assert(detail.visitStats.today >= 2, '今日计数应包含全部命中');
  assert(detail.visitStats.days && Object.keys(detail.visitStats.days).length >= 1, '应有按天明细');

  // 项目隔离：B 未被访问，计数为 0
  const detailB = await (await fetch(`${BASE}/api/projects/${idB}`, { headers: stAuth })).json();
  assertEqual(detailB.visitStats.total, 0, '未访问的项目计数应为 0');

  // 删除 A 后 stat_ 记录应一并清理，不留孤儿统计
  const del = await fetch(`${BASE}/api/projects/${idA}`, {
    method: 'POST',
    headers: { ...stAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'delete' }),
  });
  assertEqual(del.status, 200, '删除项目应成功');
  const statFile = path.join(dataDir, `stat_${encodeKey(idA)}`);
  assert(!fs.existsSync(statFile), `删除项目后 stat_ 记录应被清理：${statFile}`);

  // 清理 B，避免影响后续用例的统计断言（本项目无）
  await fetch(`${BASE}/api/projects/${idB}`, {
    method: 'POST',
    headers: { ...stAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'delete' }),
  });
});

// ---------------------------------------------------------------------------
// bun 形态后端项目：bun install 装依赖 + 用 bun 跑 TS 入口（node 跑不了 TS，
// 断言内容来自 TS 文件即证明启动命令走的是 bun 而非 node 回退）。
await test('bun 形态后端项目：bun install + TS 入口由 bun 运行', async () => {
  // 本机未装 bun 时跳过（CI runner 会安装 bun，跳过计数仍算通过）
  const probe = spawnSync('bun', ['--version'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    console.log('  - 本机无 bun，跳过 bun 形态用例（CI 上仍会执行）');
    return;
  }

  const bunUserId = 'dev-bun-backend';
  seedUser(dataDir, bunUserId, 'svip');
  const bunAuth = { 'X-Test-User': bunUserId };

  const created = await (await fetch(`${BASE}/api/projects/explorer`, {
    method: 'POST',
    headers: { ...bunAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'bun-app', kind: 'bun' }),
  })).json();
  assert(created.ok, `建 bun 项目应成功：${JSON.stringify(created)}`);
  const id = created.project.id;
  assertEqual(created.project.kind, 'bun', '项目应记录 kind=bun');

  // 故意不写 scripts.start / main：走「常见入口文件」回退，且入口是 TS ——
  // 只有 bun 能跑，node 回退会直接失败
  const pkg = JSON.stringify({
    name: 'bun-demo',
    version: '1.0.0',
    private: true,
  });
  const serverTs = [
    "import { createServer } from 'node:http';",
    'const port = Number(process.env.PORT);',
    'createServer((req, res) => {',
    "  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });",
    "  res.end('bun-server-alive:' + req.url + '|bun:' + typeof Bun);",
    '}).listen(port, "127.0.0.1");',
  ].join('\n');

  for (const [filePath, content] of [['package.json', pkg], ['server.ts', serverTs]]) {
    const put = await fetch(`${BASE}/api/projects/${id}/files`, {
      method: 'POST',
      headers: { ...bunAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath, content: textToBase64(content) }),
    });
    assertEqual(put.status, 200, `写入 ${filePath} 应成功`);
  }

  const published = await (await fetch(`${BASE}/api/projects/${id}`, {
    method: 'POST',
    headers: { ...bunAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'publish', kind: 'bun' }),
  })).json();
  assert(published.ok, `发布 bun 项目应成功：${JSON.stringify(published)}`);
  const ready = await waitForProjectReady(id, bunAuth);
  assertEqual(ready.project.status, 'ready', `bun 项目应部署成功，errorCode=${ready.project.errorCode ?? '无'}`);

  const page = await fetch(`${BASE}/p/${id}`);
  assertEqual(page.status, 200, 'bun 项目入口应 200');
  const text = await page.text();
  assert(
    text.startsWith('bun-server-alive:/|bun:object'),
    `应由 bun 运行 TS 入口并暴露 Bun 全局对象，实际：${text.slice(0, 120)}`
  );

  // 删除回收进程
  const del = await fetch(`${BASE}/api/projects/${id}`, {
    method: 'POST',
    headers: { ...bunAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'delete' }),
  });
  assertEqual(del.status, 200, '删除 bun 项目应成功');
});

// ---------------------------------------------------------------------------
// 运行日志：后端项目 stdout/stderr 环形缓冲 → App 内可见（调试刚需）
await test('后端项目运行日志：stdout 收集 → /logs 接口可见', async () => {
  const lgUserId = 'dev-runtime-logs';
  seedUser(dataDir, lgUserId, 'svip');
  const lgAuth = { 'X-Test-User': lgUserId };

  const created = await (await fetch(`${BASE}/api/projects/explorer`, {
    method: 'POST',
    headers: { ...lgAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'logs-app', kind: 'js' }),
  })).json();
  assert(created.ok, `建 js 项目应成功：${JSON.stringify(created)}`);
  const id = created.project.id;

  const serverSrc = [
    "const http = require('node:http');",
    'let n = 0;',
    'http.createServer((req, res) => {',
    "  console.log('log-line-' + (++n) + ':' + req.url);",
    "  res.writeHead(200, { 'content-type': 'text/plain' });",
    "  res.end('logs-ok');",
    "}).listen(Number(process.env.PORT), '127.0.0.1');",
  ].join('\n');
  const put = await fetch(`${BASE}/api/projects/${id}/files`, {
    method: 'POST',
    headers: { ...lgAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'server.js', content: textToBase64(serverSrc) }),
  });
  assertEqual(put.status, 200, '写入 server.js 应成功');

  const published = await (await fetch(`${BASE}/api/projects/${id}`, {
    method: 'POST',
    headers: { ...lgAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'publish', kind: 'js' }),
  })).json();
  assert(published.ok, `发布应成功：${JSON.stringify(published)}`);
  await waitForProjectReady(id, lgAuth);

  // 触发两次请求产生 stdout 输出
  await fetch(`${BASE}/p/${id}/hit1`);
  await fetch(`${BASE}/p/${id}/hit2`);
  await new Promise((r) => setTimeout(r, 300));

  const logsRes = await (await fetch(`${BASE}/api/projects/${id}/logs`, { headers: lgAuth })).json();
  assert(logsRes.ok, '日志接口应成功');
  assertEqual(logsRes.running, true, '进程在跑应返回 running=true');
  assert(
    typeof logsRes.logs === 'string' && logsRes.logs.includes('log-line-1'),
    `日志应包含 stdout 输出，实际：${String(logsRes.logs).slice(0, 200)}`
  );

  // 静态项目不提供日志接口
  const staticPaste = await (await fetch(`${BASE}/api/projects/paste`, {
    method: 'POST',
    headers: { ...lgAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'no-logs', html: '<html><body>s</body></html>', css: '' }),
  })).json();
  const logsStatic = await fetch(`${BASE}/api/projects/${staticPaste.project.id}/logs`, { headers: lgAuth });
  assertEqual(logsStatic.status, 400, '静态项目请求日志应 400 LOGS_ONLY_BACKEND');

  await fetch(`${BASE}/api/projects/${id}`, {
    method: 'POST',
    headers: { ...lgAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'delete' }),
  });
  await fetch(`${BASE}/api/projects/${staticPaste.project.id}`, {
    method: 'POST',
    headers: { ...lgAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'delete' }),
  });
});

// ---------------------------------------------------------------------------
// 表单收集 + 自定义 404 + SEO meta + 快照回滚（四个 S/M 级功能一组验证）
await test('表单收集 / 自定义 404 / SEO meta / 快照回滚', async () => {
  const mixUserId = 'dev-mix-features';
  seedUser(dataDir, mixUserId, 'svip');
  const mixAuth = { 'X-Test-User': mixUserId };

  const pasted = await (await fetch(`${BASE}/api/projects/paste`, {
    method: 'POST',
    headers: { ...mixAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'mix-site',
      html: '<!doctype html><html><head><title>Mix</title></head><body><h1>v1</h1></body></html>',
      css: 'body{margin:0}',
    }),
  })).json();
  assert(pasted.ok, `粘贴建站应成功：${JSON.stringify(pasted)}`);
  const id = pasted.project.id;

  // ---- 表单收集：浏览器原生表单（urlencoded）----
  const formPost = await fetch(`${BASE}/p/${id}/__form`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'name=alice&msg=hello',
  });
  assertEqual(formPost.status, 200, '表单提交应 200');
  const formText = await formPost.text();
  assert(formText.includes('提交成功'), `浏览器原生表单应返回成功页，实际：${formText.slice(0, 150)}`);

  // fetch(JSON) 形态
  const jsonPost = await fetch(`${BASE}/p/${id}/__form`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ name: 'bob' }),
  });
  assertEqual(jsonPost.status, 200, 'JSON 表单应 200');
  assertEqual((await jsonPost.json()).submitted, true, 'JSON 形态应返回 submitted=true');

  // 管理接口：列表 → 删单条 → 清空
  let formList = await (await fetch(`${BASE}/api/projects/${id}/form`, { headers: mixAuth })).json();
  assertEqual(formList.count, 2, '应收集 2 条提交');
  const first = formList.submissions[0];
  const target = formList.submissions.find((s) => s.fields.name === 'alice');
  assert(target, '应包含 urlencoded 提交的字段');
  assertEqual(target.fields.msg, 'hello', '字段值应原样保留');
  const del = await fetch(`${BASE}/api/projects/${id}/form`, {
    method: 'POST',
    headers: { ...mixAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'delete', id: target.id }),
  });
  assertEqual(del.status, 200, '删单条应成功');
  formList = await (await fetch(`${BASE}/api/projects/${id}/form`, { headers: mixAuth })).json();
  assertEqual(formList.count, 1, '删除后应剩 1 条');

  // ---- 自定义 404：写 404.html → 未命中路径返回它（状态码仍 404）----
  const put404 = await fetch(`${BASE}/api/projects/${id}/files`, {
    method: 'POST',
    headers: { ...mixAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path: '404.html',
      content: textToBase64('<!doctype html><html><head><title>404</title></head><body><p>custom-not-found-page</p></body></html>'),
    }),
  });
  assertEqual(put404.status, 200, '写入 404.html 应成功');
  const missing = await fetch(`${BASE}/p/${id}/no-such-page`);
  assertEqual(missing.status, 404, '未命中路径应返回 404 状态码');
  const missingText = await missing.text();
  assert(missingText.includes('custom-not-found-page'), `应返回项目内自定义 404 页，实际：${missingText.slice(0, 150)}`);
  assert(missingText.includes(`<base href="/p/${id}/">`), '自定义 404 页应注入项目级 base');

  // ---- SEO meta：无 meta 的入口自动注入（标题取 <title>），用户自己的不被覆盖 ----
  const entry = await (await fetch(`${BASE}/p/${id}`)).text();
  assert(entry.includes('<meta name="description" content="Mix">'), '应注入 description（取自 <title>）');
  assert(entry.includes('<meta property="og:title" content="Mix">'), '应注入 og:title');
  // 用户写了自己的 description 后不再被覆盖
  const putMeta = await fetch(`${BASE}/api/projects/${id}/files`, {
    method: 'POST',
    headers: { ...mixAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path: 'index.html',
      content: textToBase64('<!doctype html><html><head><title>Mix</title><meta name="description" content="own-desc"></head><body><h1>v1</h1></body></html>'),
    }),
  });
  assertEqual(putMeta.status, 200, '更新入口应成功');
  const entry2 = await (await fetch(`${BASE}/p/${id}`)).text();
  assert(entry2.includes('content="own-desc"'), '用户自己的 description 应保留');
  assertEqual(
    (entry2.match(/name="description"/g) || []).length,
    1,
    '用户已有 description 时不应重复注入'
  );
  assert(entry2.includes('<meta property="og:title" content="Mix">'), '缺失的 og:title 仍应补齐');

  // ---- 快照：备份 → 改文件 → 恢复 → 内容回到备份点 ----
  const snapCreate = await fetch(`${BASE}/api/projects/${id}/snapshot`, {
    method: 'POST',
    headers: { ...mixAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'create' }),
  });
  assertEqual(snapCreate.status, 200, `创建快照应成功：${JSON.stringify(await snapCreate.json())}`);

  // 备份后改入口为 v2
  await fetch(`${BASE}/api/projects/${id}/files`, {
    method: 'POST',
    headers: { ...mixAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path: 'index.html',
      content: textToBase64('<!doctype html><html><head><title>Mix</title></head><body><h1>v2-changed</h1></body></html>'),
    }),
  });
  const beforeRestore = await (await fetch(`${BASE}/p/${id}`)).text();
  assert(beforeRestore.includes('v2-changed'), '修改后入口应显示 v2');

  const restore = await fetch(`${BASE}/api/projects/${id}/snapshot`, {
    method: 'POST',
    headers: { ...mixAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'restore' }),
  });
  assertEqual(restore.status, 200, `恢复快照应成功：${JSON.stringify(await restore.json())}`);
  const afterRestore = await (await fetch(`${BASE}/p/${id}`)).text();
  assert(afterRestore.includes('v1') && !afterRestore.includes('v2-changed'), '恢复后应回到备份点内容');

  // 普通账号（无 VIP）在自己的项目上不可用快照（容量成本 = 全站文件副本，仅 VIP+）
  const plainUser = 'dev-mix-plain';
  seedUser(dataDir, plainUser, 'user');
  const plainPaste = await (await fetch(`${BASE}/api/projects/paste`, {
    method: 'POST',
    headers: { 'X-Test-User': plainUser, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'plain-site', html: '<html><body>plain</body></html>', css: '' }),
  })).json();
  assert(plainPaste.ok, '普通用户建站应成功');
  const plainDenied = await fetch(`${BASE}/api/projects/${plainPaste.project.id}/snapshot`, {
    method: 'POST',
    headers: { 'X-Test-User': plainUser, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'create' }),
  });
  assertEqual(plainDenied.status, 403, '非 VIP 应 403 SNAPSHOT_REQUIRES_VIP');
  await fetch(`${BASE}/api/projects/${plainPaste.project.id}`, {
    method: 'POST',
    headers: { 'X-Test-User': plainUser, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'delete' }),
  });

  // 删除快照 → 信息为 null
  await fetch(`${BASE}/api/projects/${id}/snapshot`, {
    method: 'POST',
    headers: { ...mixAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'delete' }),
  });
  const snapInfo = await (await fetch(`${BASE}/api/projects/${id}/snapshot`, { headers: mixAuth })).json();
  assertEqual(snapInfo.snapshot, null, '删除后快照信息应为 null');

  // 清理项目（含表单/快照孤儿清理断言）
  await fetch(`${BASE}/api/projects/${id}`, {
    method: 'POST',
    headers: { ...mixAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'delete' }),
  });
  const statFileGone = !fs.existsSync(path.join(dataDir, `formsub_${encodeKey(id)}_x`));
  assert(statFileGone, '表单记录应随项目删除清理');
});

// ---------------------------------------------------------------------------
console.log(`\n结果：${passed} 通过，${failed} 失败\n`);

killProcessTree(server);
try {
  fs.rmSync(dataDir, { recursive: true, force: true });
} catch {}

process.exit(failed > 0 ? 1 : 0);
