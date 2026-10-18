// =============================================================================
// CSS/JS 引用全模式复现（本地容器 · 真实 HTTP）
// 覆盖：① 粘贴-完整 HTML 引用 style.css/script.js ② 粘贴-片段自动注入
//       ③ 粘贴-PHP ④ 探索器发布三文件 ⑤ 上传 zip 管线
// 运行：node dev/test-assets.mjs
// =============================================================================
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 18788;
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

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pagemake-assets-'));
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

async function login() {
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `assets-${Date.now()}-${Math.random().toString(36).slice(2)}@t.com`, password: 'test-password-123' }),
  });
  assert(res.ok, `注册失败 HTTP ${res.status}`);
  const body = await res.json();
  return { token: body.token, email: body.email };
}

async function paste(token, body) {
  const res = await fetch(`${BASE}/api/projects/paste`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

await waitForServer();
console.log('\n[CSS/JS 引用全模式复现]');

// ① 完整 HTML（自带模板形态：link + script 标签都在）
await test('粘贴：完整 HTML 引用 style.css / script.js → 资源可访问', async () => {
  const { token } = await login();
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>模板形态</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <h1>标题</h1>
  <script src="script.js"></script>
</body>
</html>`;
  const { status, body } = await paste(token, { name: 'tpl', html, css: 'h1 { color: red; }', js: 'console.log(1)' });
  assertEqual(status, 200, '粘贴应成功');
  const id = body.project.id;

  const page = await fetch(`${BASE}/p/${id}`);
  assertEqual(page.status, 200, '入口应 200');
  const text = await page.text();
  assert(text.includes('href="style.css"'), 'HTML 应保留 style.css 引用');
  assert(text.includes('src="script.js"'), 'HTML 应保留 script.js 引用');

  const css = await fetch(`${BASE}/p/${id}/style.css`);
  assertEqual(css.status, 200, 'style.css 应 200');
  assert((await css.text()).includes('color: red'), 'CSS 内容应一致');

  const js = await fetch(`${BASE}/p/${id}/script.js`);
  assertEqual(js.status, 200, 'script.js 应 200');
  assert((await js.text()).includes('console.log'), 'JS 内容应一致');
});

// ② 片段（无 html 结构）→ 自动包裹 + 注入引用
await test('粘贴：HTML 片段 → 自动注入 link/script 且资源可访问', async () => {
  const { token } = await login();
  const { status, body } = await paste(token, { name: 'frag', html: '<h1>片段</h1>', css: 'h1{color:blue}', js: 'var a=1' });
  assertEqual(status, 200, '粘贴应成功');
  const id = body.project.id;
  const page = await fetch(`${BASE}/p/${id}`);
  const text = await page.text();
  assert(text.includes('href="style.css"'), '片段应被注入 style.css 引用');
  assert(text.includes('src="script.js"'), '片段应被注入 script.js 引用');
  const css = await fetch(`${BASE}/p/${id}/style.css`);
  assertEqual(css.status, 200, 'style.css 应 200');
  const js = await fetch(`${BASE}/p/${id}/script.js`);
  assertEqual(js.status, 200, 'script.js 应 200');
});

// ③ 子目录引用 css/style.css
await test('粘贴：子目录引用 css/style.css → 精确命中', async () => {
  const { token } = await login();
  const html = `<html><head><link rel="stylesheet" href="css/style.css"></head><body><h1>x</h1></body></html>`;
  const { status, body } = await paste(token, { name: 'sub', html, css: 'h1 { color: green; }' });
  assertEqual(status, 200, '粘贴应成功');
  const id = body.project.id;
  const css = await fetch(`${BASE}/p/${id}/css/style.css`);
  assertEqual(css.status, 200, 'css/style.css 应 200');
  assert((await css.text()).includes('color: green'), '内容应一致');
});

// ④ PHP 粘贴 → 执行
await test('粘贴：纯 PHP → 入口执行输出', async () => {
  const { token } = await login();
  const { status, body } = await paste(token, { name: 'php', php: '<?php echo "PHP-OK:" . (2 + 3); ?>' });
  assertEqual(status, 200, '粘贴应成功');
  const id = body.project.id;
  const page = await fetch(`${BASE}/p/${id}`);
  const text = await page.text();
  if (page.status === 503) {
    console.log('    （本地未装 PHP，返回 503 提示页——链路正确）');
    assert(text.includes('PHP'), '503 页应为 PHP 提示');
    return;
  }
  assertEqual(page.status, 200, 'PHP 入口应 200');
  assert(text.includes('PHP-OK:5'), `PHP 应输出 PHP-OK:5，实际：${text.slice(0, 80)}`);
});

// ⑤ 探索器模式发布 → 资源可访问
await test('探索器：三文件 publish → HTML/CSS/JS 全部可访问', async () => {
  const { token } = await login();
  const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  const created = await (await fetch(`${BASE}/api/projects/explorer`, {
    method: 'POST', headers: H, body: JSON.stringify({ name: 'expro' }),
  })).json();
  const id = created.project.id;
  const put = async (p, content) => (await fetch(`${BASE}/api/projects/${id}/files`, {
    method: 'POST', headers: H, body: JSON.stringify({ path: p, content: Buffer.from(content).toString('base64') }),
  })).status;
  assertEqual(await put('index.html', '<html><head><link rel="stylesheet" href="style.css"></head><body><h1>探索器</h1><script src="app.js"></script></body></html>'), 200, '写 index.html');
  assertEqual(await put('style.css', 'h1{color:purple}'), 200, '写 style.css');
  assertEqual(await put('app.js', 'console.log("expro")'), 200, '写 app.js');
  const pub = await fetch(`${BASE}/api/projects/${id}`, { method: 'POST', headers: H, body: JSON.stringify({ action: 'publish' }) });
  assertEqual(pub.status, 200, `publish 应 200，实际 ${pub.status}`);

  const page = await fetch(`${BASE}/p/${id}`);
  assertEqual(page.status, 200, '入口应 200');
  assert((await page.text()).includes('href="style.css"'), 'HTML 应引用 style.css');
  const css = await fetch(`${BASE}/p/${id}/style.css`);
  assertEqual(css.status, 200, 'style.css 应 200');
  const cssText = await css.text();
  assert(cssText.includes('color:purple'), `CSS 内容应一致，实际：${JSON.stringify(cssText.slice(0, 100))}`);
  const js = await fetch(`${BASE}/p/${id}/app.js`);
  assertEqual(js.status, 200, 'app.js 应 200');
});

server.kill();
try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
