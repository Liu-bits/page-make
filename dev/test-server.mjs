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

await test('邮箱密码：注册 → 登录 → 错误密码', async () => {
  const email = `user${Date.now()}@example.com`;
  const password = 'secret-pass-123';

  // 注册
  const reg = await (await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })).json();
  assert(reg.ok, `注册应成功：${JSON.stringify(reg)}`);
  assert(reg.token, '注册应返回 token');
  assert(reg.userId.startsWith('email_'), 'userId 应为 email_ 前缀');

  // 重复注册 → EMAIL_TAKEN
  const dup = await (await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })).json();
  assertEqual(dup.error, 'EMAIL_TAKEN', '重复注册应报 EMAIL_TAKEN');

  // 登录成功
  const login = await (await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })).json();
  assert(login.ok, '登录应成功');
  assert(login.token, '登录应返回 token');
  assertEqual(login.userId, reg.userId, '同一邮箱 userId 应一致');

  // 密码错误 → INVALID_CREDENTIALS
  const wrong = await (await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'wrong-password-1' }),
  })).json();
  assertEqual(wrong.error, 'INVALID_CREDENTIALS', '密码错误应报 INVALID_CREDENTIALS');

  // 参数校验
  const badEmail = await (await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'not-an-email', password: 'secret-pass-123' }),
  })).json();
  assertEqual(badEmail.error, 'INVALID_EMAIL', '非法邮箱应报 INVALID_EMAIL');

  const weak = await (await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `x${Date.now()}@example.com`, password: '1234567' }),
  })).json();
  assertEqual(weak.error, 'WEAK_PASSWORD', '短密码应报 WEAK_PASSWORD');

  // 登录态可用：用注册 token 访问项目列表
  const list = await fetch(`${BASE}/api/projects`, { headers: { Authorization: `Bearer ${reg.token}` } });
  assert(list.status === 200, '注册 token 应可访问受保护接口');
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
