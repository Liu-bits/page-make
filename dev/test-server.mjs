// =============================================================================
// 自托管容器冒烟测试：启动真实 HTTP 服务，跑完整「上传 → 处理 → 公开访问 → 管理」全流程
// 运行：node dev/test-server.mjs
// =============================================================================
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildZip } from './make-zip.mjs';
import { keys as kvKeys } from '../backend/lib/kv.js';
import { textToBase64, base64ToText } from '../backend/lib/base64.js';

const PORT = 18786;
const BASE = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: 'Bearer dev-test-token' };

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
  const created = await (await fetch(`${BASE}/api/projects/explorer`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
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
    (await fetch(`${BASE}/api/projects/${id}/files?path=index.php`, { headers: AUTH })).status,
    400,
    '历史 .php 也不得通过文件接口读取'
  );

  // 重新发布：忽略历史 PHP 入口，自动选中项目内唯一 HTML 并修复链接。
  const published = await (await fetch(`${BASE}/api/projects/${id}`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
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
    headers: AUTH,
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

await test('粘贴代码创建：注入 CSS/JS + 公开访问', async () => {
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
  assert(page.includes('script.js'), '页面应注入 script.js 引用');

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

// 反馈接口防刷：未登录可提交，但必须限流，否则脚本可无限灌入打满 KV
await test('反馈：可提交，且超限返回 429', async () => {
  const first = await (await fetch(`${BASE}/api/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'feedback', message: '第一条反馈' }),
  })).json();
  assert(first.ok, '正常反馈应被接收');

  let limited = 0;
  for (let i = 0; i < 10; i++) {
    const res = await fetch(`${BASE}/api/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'feedback', message: `刷量 ${i}` }),
    });
    if (res.status === 429) limited++;
  }
  assert(limited > 0, '超过每 IP 每分钟 5 次后应返回 429');

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

await test('邮箱密码：普通注册已下线，登录只接受 VIP 账号', async () => {
  const email = `user${Date.now()}@example.com`;
  const password = 'Str0ng#Pass99';

  // 普通注册入口必须不存在（避免 App/攻击者绕过管理员发放 VIP）
  const reg = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assertEqual(reg.status, 404, '普通注册路由应下线');

  // 账号不存在与密码错误统一错误码
  const login = await (await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })).json();
  assertEqual(login.error, 'INVALID_CREDENTIALS', '非 VIP/账号不存在应统一返回 INVALID_CREDENTIALS');

  const badEmail = await (await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'not-an-email', password }),
  })).json();
  assertEqual(badEmail.error, 'INVALID_CREDENTIALS', '非法邮箱也不应泄露校验细节');

  const missing = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assertEqual(missing.status, 401, '缺参数应稳定返回 401');
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
    server2.kill();
  }
});

// ---------------------------------------------------------------------------
// 登录限速放在最后：本套件所有用例共用同一 IP，先跑会占用错误密码配额影响后续用例
await test('登录限速：连续错误密码触发 429（防暴力破解）', async () => {
  const email = `ratelimit-${Date.now()}@t.local`;

  let limited = 0;
  let unauthorized = 0;
  for (let i = 0; i < 14; i++) {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: `wrong-${i}-pass` }),
    });
    if (res.status === 429) limited++;
    else if (res.status === 401) unauthorized++;
  }
  assert(limited > 0, `连续错误密码应触发 429，实际 401=${unauthorized} 429=${limited}`);
});

// ---------------------------------------------------------------------------
console.log(`\n结果：${passed} 通过，${failed} 失败\n`);

server.kill();
try {
  fs.rmSync(dataDir, { recursive: true, force: true });
} catch {}

process.exit(failed > 0 ? 1 : 0);
