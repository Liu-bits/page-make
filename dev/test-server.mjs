// =============================================================================
// 自托管容器冒烟测试：启动真实 HTTP 服务，跑完整「上传 → 处理 → 公开访问 → 管理」全流程
// 运行：node dev/test-server.mjs
// =============================================================================
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildZip } from './make-zip.mjs';
import { keys as kvKeys } from '../edge-functions/lib/kv.js';

const PORT = 18786;
const BASE = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: 'Bearer dev-test-token' };

let passed = 0;
let failed = 0;
let projectId = null;

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
// 启动服务（DEV_NO_AUTH=1 跳过 Apple 登录；剥离大小写重复的代理变量避免回环被拦截）
// ---------------------------------------------------------------------------
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pagemake-server-'));
const spawnEnv = { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, DEV_NO_AUTH: '1' };
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
  assert(json.providers.includes('edgeone'), '应包含线路列表');
});

await test('未知路由返回 404', async () => {
  const res = await fetch(`${BASE}/no-such-route`);
  assert(res.status === 404, '应 404');
});

await test('未选线路时 init 返回 INVALID_PROVIDER', async () => {
  const res = await fetch(`${BASE}/api/upload/init`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: [{ name: 'site.zip', size: 100 }] }),
  });
  const json = await res.json();
  assert(res.status === 400 && json.error === 'INVALID_PROVIDER', '应返回 400 INVALID_PROVIDER');
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
    body: JSON.stringify({ provider: 'edgeone', files: [{ name: 'site.zip', size: zip.length }] }),
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

await test('删除项目后公开链接失效', async () => {
  const res = await fetch(`${BASE}/api/projects/${projectId}`, { method: 'DELETE', headers: AUTH });
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
    server2.kill();
  }
});

// ---------------------------------------------------------------------------
console.log(`\n结果：${passed} 通过，${failed} 失败\n`);

server.kill();
try {
  fs.rmSync(dataDir, { recursive: true, force: true });
} catch {}

process.exit(failed > 0 ? 1 : 0);
