// =============================================================================
// CSS/JS 引用全模式复现（本地容器 · 真实 HTTP）
// 覆盖：① 粘贴-完整 HTML 引用 style.css/script.js ② 粘贴-片段自动注入
//       ③ PHP 已移除 ④ 探索器发布三文件 ⑤ 上传 zip 管线
// 运行：node dev/test-assets.mjs
// =============================================================================
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 直接单测 diagnostics 的路径归一（不需要起服务）
import { analyzeHtml } from '../backend/lib/diagnostics.js';

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
  body: JSON.stringify({ email: `assets-${Date.now()}-${Math.random().toString(36).slice(2)}@t.com`, password: 'Test#Passw0rd1' }),
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

// ⓿ 诊断路径归一：必须与 normalizeRelPath 一致，否则文件存在却误报「引用缺失」
await test('诊断：../style.css、/style.css 不再误报缺失', async () => {
  const files = new Map([['index.html', new Uint8Array(0)], ['style.css', new Uint8Array(1)]]);
  // 服务端已把存储路径归一为 style.css，诊断必须能匹配上
  for (const ref of ['../style.css', './style.css', '/style.css', 'style.css']) {
    const d = analyzeHtml(`<link rel="stylesheet" href="${ref}">`, files);
    assertEqual(d.length, 0, `引用 ${ref} 不应产生告警，实际 ${JSON.stringify(d)}`);
  }
  // 原有行为必须保留：大小写不一致、真缺失、平铺宽容提示仍要报
  const caseD = analyzeHtml('<link href="Style.CSS">', files);
  assertEqual(caseD[0]?.kind, 'caseMismatch', '大小写不一致仍应报 caseMismatch');
  const missD = analyzeHtml('<link href="missing.css">', files);
  assertEqual(missD[0]?.kind, 'missingFile', '真缺失仍应报 missingFile');
  assert(missD[0]?.detail.includes('missing.css'), '应指出具体缺失文件');
  const flatD = analyzeHtml('<link href="css/style.css">', files);
  assertEqual(flatD[0]?.kind, 'missingFile', '平铺宽容提示仍应报');
  assert(flatD[0]?.detail.includes('style.css'), '应提示文件实际在 style.css');
});

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

// ③-b 相对路径写法（曾断链）：`../style.css` 原样存成文件名，
// 而浏览器请求 /p/<id>/../style.css 会被 URL 规范化成 /p/style.css → 404
// 必须同时断言「存储路径」和「下发 HTML 里的引用字符串」：
// 入口页是 /p/<id>（无尾斜杠），若 HTML 仍写 ../style.css，浏览器会解析成
// https://host/style.css 跳出 /p/ 前缀 → 404。只修存储名是半截修复。
await test('粘贴：../style.css 与 /style.css → 归一后仍可访问', async () => {
  const { token } = await login();

  const a = await paste(token, {
    name: 'parent',
    html: '<html><head><link rel="stylesheet" href="../style.css"><script src="../app.js"></script></head><body><h1>x</h1></body></html>',
    css: 'h1 { color: red; }',
    js: "console.log('a')",
  });
  assertEqual(a.status, 200, '粘贴应成功');
  const pathsA = a.body.project.files.map((f) => f.path);
  assert(pathsA.includes('style.css'), `CSS 应归一为 style.css，实际 ${pathsA.join(',')}`);
  assert(pathsA.includes('app.js'), `JS 应归一为 app.js，实际 ${pathsA.join(',')}`);
  assert(!pathsA.some((p) => p.includes('..')), '不得出现含 .. 的路径');
  assertEqual((await fetch(`${BASE}/p/${a.body.project.id}/style.css`)).status, 200, 'style.css 应 200');
  assertEqual((await fetch(`${BASE}/p/${a.body.project.id}/app.js`)).status, 200, 'app.js 应 200');
  const htmlA = await (await fetch(`${BASE}/p/${a.body.project.id}`)).text();
  assert(!htmlA.includes('href="../style.css"'), `HTML 引用应改写，实际仍含 ../：${htmlA.slice(0, 200)}`);
  assert(!htmlA.includes('src="../app.js"'), 'HTML 引用应改写，实际仍含 ../');
  assert(htmlA.includes('href="style.css"'), 'HTML 应引用归一后的 style.css');
  assert(htmlA.includes('src="app.js"'), 'HTML 应引用归一后的 app.js');

  const b = await paste(token, {
    name: 'root-abs',
    html: '<html><head><link rel="stylesheet" href="/style.css"></head><body><h1>x</h1></body></html>',
    css: 'h1 { color: blue; }',
  });
  assertEqual(b.status, 200, '粘贴应成功');
  assert(b.body.project.files.map((f) => f.path).includes('style.css'), '/style.css 应归一为 style.css');
  assertEqual((await fetch(`${BASE}/p/${b.body.project.id}/style.css`)).status, 200, '/style.css 归一后应 200');
  const htmlB = await (await fetch(`${BASE}/p/${b.body.project.id}`)).text();
  assert(!htmlB.includes('href="/style.css"'), 'HTML 里的 /style.css 应改写为 style.css');
  assert(htmlB.includes('href="style.css"'), 'HTML 应引用归一后的 style.css');
});

// ③-b2 查询串形态的归一：引用字符串也要跟着归一，否则浏览器仍请求不到
await test('粘贴：../a.css?v=1 → 引用与存储同时归一', async () => {
  const { token } = await login();
  const { status, body } = await paste(token, {
    name: 'query-parent',
    html: '<html><head><link rel="stylesheet" href="../style.css?v=1"></head><body><h1>x</h1></body></html>',
    css: 'h1 { color: red; }',
  });
  assertEqual(status, 200, '粘贴应成功');
  assert(body.project.files.map((f) => f.path).includes('style.css'), '应存 style.css');
  const html = await (await fetch(`${BASE}/p/${body.project.id}`)).text();
  assert(!html.includes('href="../'), `HTML 引用不得残留 ../，实际：${html.slice(0, 200)}`);
  // normalizeRelPath 会剥掉查询串/锚点（统一归一语义），服务端取文件本就忽略查询串
  assert(html.includes('href="style.css"'), '查询串应被剥掉并归一为 style.css');
  assertEqual((await fetch(`${BASE}/p/${body.project.id}/style.css?v=1`)).status, 200, 'style.css?v=1 应 200');
});

// ③-b3 外链与 data URI 不得被改写（用户的远程引用必须原样保留）
await test('粘贴：外链引用字符串保持原样', async () => {
  const { token } = await login();
  const html = '<html><head>'
    + '<link rel="stylesheet" href="https://cdn.example.com/a.css">'
    + '<script src="//cdn.example.com/b.js"></script>'
    + '</head><body><h1>x</h1></body></html>';
  const { status, body } = await paste(token, { name: 'ext', html, css: 'h1{color:red}', js: 'var a=1' });
  assertEqual(status, 200, '粘贴应成功');
  const served = await (await fetch(`${BASE}/p/${body.project.id}`)).text();
  assert(served.includes('href="https://cdn.example.com/a.css"'), '外链 CSS 应原样保留');
  assert(served.includes('src="//cdn.example.com/b.js"'), '协议相对引用应原样保留');
  // 用户显式粘贴的 CSS/JS 内容优先：即使 HTML 里已有外链引用，
  // 也要注入本地 style.css/script.js，否则粘贴的内容就丢了
  assert(served.includes('href="style.css"'), 'HTML 无本地 CSS 引用时应注入本地 style.css');
  assert(served.includes('src="script.js"'), 'HTML 无本地 JS 引用时应注入本地 script.js');
  const paths = body.project.files.map((f) => f.path);
  assert(paths.includes('style.css'), '粘贴的 CSS 内容应入库');
  assert(paths.includes('script.js'), '粘贴的 JS 内容应入库');
  assertEqual((await fetch(`${BASE}/p/${body.project.id}/style.css`)).status, 200, 'style.css 应 200');
  assertEqual((await fetch(`${BASE}/p/${body.project.id}/script.js`)).status, 200, 'script.js 应 200');
});

// ③-e ZIP 上传管线：ZIP 内 HTML 写 ../style.css 时，存储与引用必须同时归一
// （粘贴链路已修，这里覆盖上传链路，防止只修一半）
await test('ZIP 上传：HTML 内 ../style.css → 引用改写且可访问', async () => {
  const { buildZip } = await import('./make-zip.mjs');
  const { token } = await login();
  const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  const zip = buildZip([
    ['index.html', '<html><head><link rel="stylesheet" href="../style.css"></head><body><h1>zip</h1></body></html>'],
    ['style.css', 'h1 { color: teal; }'],
  ]);
  const init = await (await fetch(`${BASE}/api/upload/init`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ files: [{ name: 'site.zip', size: zip.length }] }),
  })).json();
  const { uploadId } = init;
  const chunkSize = init.chunkSize;
  for (let i = 0; i * chunkSize < zip.length; i++) {
    const part = zip.subarray(i * chunkSize, Math.min((i + 1) * chunkSize, zip.length));
    const up = await fetch(`${BASE}/api/upload/chunk`, {
      method: 'POST', headers: H,
      body: JSON.stringify({
        uploadId, fileIndex: 0, chunkIndex: i,
        data: Buffer.from(part).toString('base64'),
      }),
    });
    assertEqual(up.status, 200, `分片 ${i} 应 200`);
  }
  const fin = await fetch(`${BASE}/api/upload/finish`, { method: 'POST', headers: H, body: JSON.stringify({ uploadId }) });
  assertEqual(fin.status, 200, `finish 应 200，实际 ${fin.status}`);
  const finBody = await fin.json();
  const id = finBody.projectId || finBody.project?.id;

  // 等异步处理完成
  let project = null;
  for (let i = 0; i < 60; i++) {
    const st = await (await fetch(`${BASE}/api/projects/${id}/status`, { headers: H })).json();
    if (st.status === 'ready' || st.status === 'failed') { project = st; break; }
    await sleep(200);
  }
  assertEqual(project?.status, 'ready', `项目应 ready，实际 ${JSON.stringify(project)}`);

  const html = await (await fetch(`${BASE}/p/${id}`)).text();
  assert(!html.includes('href="../'), `ZIP HTML 引用不得残留 ../，实际：${html.slice(0, 200)}`);
  assert(html.includes('href="style.css"'), 'ZIP HTML 应引用归一后的 style.css');
  const css = await fetch(`${BASE}/p/${id}/style.css`);
  assertEqual(css.status, 200, 'style.css 应 200');
  assert((await css.text()).includes('color: teal'), 'CSS 内容应一致');
});

// ③-f 项目模式 publish：用户手写 ../style.css 引用时同步归一
await test('探索器：HTML 写 ../style.css → publish 归一且可访问', async () => {
  const { token } = await login();
  const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  const created = await (await fetch(`${BASE}/api/projects/explorer`, {
    method: 'POST', headers: H, body: JSON.stringify({ name: 'expro-parent' }),
  })).json();
  const id = created.project.id;
  const put = async (p, content) => (await fetch(`${BASE}/api/projects/${id}/files`, {
    method: 'POST', headers: H, body: JSON.stringify({ path: p, content: Buffer.from(content).toString('base64') }),
  })).status;
  assertEqual(await put('index.html', '<html><head><link rel="stylesheet" href="../style.css"></head><body><h1>x</h1></body></html>'), 200, '写 index.html');
  assertEqual(await put('style.css', 'h1{color:orange}'), 200, '写 style.css');
  const pub = await fetch(`${BASE}/api/projects/${id}`, { method: 'POST', headers: H, body: JSON.stringify({ action: 'publish' }) });
  assertEqual(pub.status, 200, `publish 应 200，实际 ${pub.status}`);

  const html = await (await fetch(`${BASE}/p/${id}`)).text();
  assert(!html.includes('href="../'), `HTML 引用不得残留 ../，实际：${html.slice(0, 200)}`);
  assert(html.includes('href="style.css"'), 'HTML 应引用归一后的 style.css');
  const css = await fetch(`${BASE}/p/${id}/style.css`);
  assertEqual(css.status, 200, 'style.css 应 200');
  assert((await css.text()).includes('color:orange'), 'CSS 内容应一致');
});

// ③-c 引用带查询串 / type 属性 / 多属性（曾因正则缺陷匹配不到 → 重复注入 + 断链）
await test('粘贴：带查询串与 type 属性的引用 → 不重复注入且可访问', async () => {
  const { token } = await login();
  const { status, body } = await paste(token, {
    name: 'query',
    html: '<html><head>'
      + '<script type="text/javascript" src="app.js?v=9"></script>'
      + '<link rel="stylesheet" type="text/css" href="style.css?v=123">'
      + '</head><body><h1>x</h1></body></html>',
    css: 'h1 { color: red; }',
    js: "console.log('q')",
  });
  assertEqual(status, 200, '粘贴应成功');
  const paths = body.project.files.map((f) => f.path);
  assert(paths.includes('style.css'), `应存 style.css，实际 ${paths.join(',')}`);
  assert(paths.includes('app.js'), `应存 app.js，实际 ${paths.join(',')}`);
  assert(!paths.includes('script.js'), '不得因误判而重复注入 script.js');
  assertEqual((await fetch(`${BASE}/p/${body.project.id}/app.js`)).status, 200, 'app.js?v=9 应 200');
  assertEqual((await fetch(`${BASE}/p/${body.project.id}/style.css`)).status, 200, 'style.css?v=123 应 200');
});

// ③-d 外链 / data URI 不得被当成本地文件路径
await test('粘贴：外链与 data URI 引用被忽略', async () => {
  const { token } = await login();
  const { status, body } = await paste(token, {
    name: 'external',
    html: '<html><head>'
      + '<link rel="stylesheet" href="https://cdn.example.com/a.css">'
      + '<link rel="stylesheet" href="//cdn.example.com/b.css">'
      + '<link rel="stylesheet" href="data:text/css,h1{}">'
      + '</head><body><h1>x</h1></body></html>',
    css: 'h1 { color: red; }',
  });
  assertEqual(status, 200, '粘贴应成功');
  const paths = body.project.files.map((f) => f.path);
  assert(!paths.some((p) => p.includes('://') || p.startsWith('//') || p.startsWith('data:')),
    `外链不得入库，实际 ${paths.join(',')}`);
  assert(paths.includes('style.css'), '无本地引用时应注入默认 style.css');
});

// ④ PHP 粘贴 → 必须拒绝（PHP 已移除）
await test('粘贴：PHP 字段不再生成可执行入口', async () => {
  const { token } = await login();
  const { status, body } = await paste(token, { name: 'php', php: '<?php echo "PHP-OK:" . (2 + 3); ?>' });
  assertEqual(status, 400, '只有 PHP 字段时应拒绝');
  assertEqual(body.error, 'BAD_REQUEST', '错误码应为 BAD_REQUEST');
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

// ⑥ CSS 内部 url() 引用归一（背景图 / @font-face 字体）
// 与 HTML 的 link/script 同一根因，但 HTML 侧修复完全覆盖不到 CSS 文件内容：
// style.css 以 /p/<id>/style.css 引入，其中 url(../img/bg.png) 会被浏览器
// 解析到 /p/ 前缀之外 → 404，症状是背景图/字体不显示，排查时容易误判成断链。
await test('粘贴：CSS 内部 url() 引用归一后可访问', async () => {
  const { token } = await login();
  const css = [
    '.hero { background-image: url(../img/bg.png); }',
    '.logo { background: url("img/logo.png") no-repeat; }',
    '.ico { background: url(\'../icon.ico\'); }',
    '@font-face { font-family: F; src: url(../fonts/f.woff2); }',
    // 外链与 data URI 必须原样保留，不能被当成本地引用改写
    '.ext { background: url(https://cdn.example.com/a.png); }',
    '.data { background: url(data:image/png;base64,iVBORw0KGgo=); }',
  ].join('\n');
  const html = '<html><head><link rel="stylesheet" href="style.css"></head><body><h1>x</h1></body></html>';
  const { status, body } = await paste(token, { name: 'cssurl', html, css, js: '' });
  assertEqual(status, 200, '粘贴应成功');
  const id = body.project.id;

  const served = await (await fetch(`${BASE}/p/${id}/style.css`)).text();
  assert(served.includes('url(img/bg.png)'), `url(../img/bg.png) 应归一为 url(img/bg.png)，实际：${JSON.stringify(served.slice(0, 200))}`);
  assert(!served.includes('url(../img/bg.png)'), '不得仍含 ../ 引用');
  assert(served.includes("url('icon.ico')"), '单引号形式应归一并保留引号风格');
  assert(served.includes('url(fonts/f.woff2)'), '@font-face 的字体引用应归一');
  // 已是规范路径的不应被改写
  assert(served.includes('url("img/logo.png")'), '规范路径 img/logo.png 不应被改写');
  // 外链 / data URI 原样保留
  assert(served.includes('url(https://cdn.example.com/a.png)'), '外链必须原样保留');
  assert(served.includes('url(data:image/png;base64,iVBORw0KGgo=)'), 'data URI 必须原样保留');
});

// ⑧ CSS @import 字符串形式：@import "../other.css"; 此前完全漏过
// （只处理了 url() 形式，而 @import 有两种等价语法）
await test('粘贴：CSS @import 字符串形式归一后可访问', async () => {
  const { rewriteCssRefs } = await import('../backend/lib/paths.js');
  // 字符串形式：@import "x"; / @import 'x';
  assertEqual(rewriteCssRefs('@import "../other.css";').trim(), '@import "other.css";', '双引号 @import 应归一');
  assertEqual(rewriteCssRefs("@import '../b.css';").trim(), "@import 'b.css';", '单引号 @import 应归一');
  assertEqual(rewriteCssRefs('@import "sub/a.css" screen;').trim(), '@import "sub/a.css" screen;', '规范路径与 media query 不应被改');
  // url() 形式仍要工作
  assertEqual(rewriteCssRefs('@import url("../other.css");').trim(), '@import url("other.css");', 'url() 形式应归一');
  // 外链与其它 @ 规则不能误伤
  assertEqual(rewriteCssRefs('@import "https://cdn.example.com/a.css";').trim(), '@import "https://cdn.example.com/a.css";', '外链 @import 应原样保留');
  assertEqual(rewriteCssRefs('@charset "utf-8";').trim(), '@charset "utf-8";', '@charset 不能被误改');
  assertEqual(rewriteCssRefs('@media screen { .a { color: red } }').trim(), '@media screen { .a { color: red } }', '@media 不能被误改');
});

// ⑧-b 注释与普通字符串不能被引用归一变坏
await test('CSS 引用归一：注释与 content 字符串保持原样', async () => {
  const { rewriteCssRefs, rewriteLocalRefs } = await import('../backend/lib/paths.js');
  // 注释与字符串里的示例不能被当成真实引用改写
  assertEqual(
    rewriteCssRefs('/* url(../old.png) @import "../old.css"; */\n.a{background:url(../bg.png)}').trim(),
    '/* url(../old.png) @import "../old.css"; */\n.a{background:url(bg.png)}',
    'CSS 注释内容必须原样保留'
  );
  assertEqual(
    rewriteCssRefs('.a::before{content:"url(../x.png) @import \\"../y.css\\";"}').trim(),
    '.a::before{content:"url(../x.png) @import \\"../y.css\\";"}',
    'CSS 字符串内容必须原样保留（含转义引号）'
  );
  assertEqual(
    rewriteCssRefs('@import url("../a.css"); /* url(../b.png) */').trim(),
    '@import url("a.css"); /* url(../b.png) */',
    '@import url() 与注释应各自处理'
  );
  assertEqual(
    rewriteCssRefs('@import/*x*/"../a.css";').trim(),
    '@import/*x*/"a.css";',
    '@import 与路径之间夹注释时，注释必须保留'
  );
  assertEqual(
    rewriteCssRefs('@IMPORT "../a.css";').trim(),
    '@IMPORT "a.css";',
    '@import 关键字大小写必须保留'
  );
  assertEqual(
    rewriteCssRefs('.a{background:url(../bg.png)}').trim(),
    '.a{background:url(bg.png)}',
    '无引号 url() 必须归一'
  );
  assertEqual(
    rewriteCssRefs('.a::before{content:"url(../x.png)"}').trim(),
    '.a::before{content:"url(../x.png)"}',
    'content 字符串里的 url() 不能误改'
  );
  assertEqual(
    rewriteLocalRefs('<div style="content:&quot;url(../x.png)&quot;"></div>').trim(),
    '<div style="content:&quot;url(../x.png)&quot;"></div>',
    'HTML 内联 style 的 content 实体文本不能误改'
  );
});

// ⑥-b 上传 ZIP 链路：ZIP 里的 style.css 内部 url() 同样要归一
// （HTML 侧归一覆盖不到 CSS 文件内容，上传管线必须单独处理）
await test('上传 ZIP：CSS 内部 url() 归一后可访问', async () => {
  const { buildZip } = await import('./make-zip.mjs');
  const { token } = await login();
  const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  const zip = buildZip([
    ['index.html', '<html><head><link rel="stylesheet" href="../style.css"></head><body><h1>zip</h1></body></html>'],
    ['style.css', '.hero { background-image: url(../img/bg.png); }'],
  ]);
  const init = await (await fetch(`${BASE}/api/upload/init`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ files: [{ name: 'site.zip', size: zip.length }] }),
  })).json();
  const { uploadId, chunkSize } = init;
  for (let i = 0; i * chunkSize < zip.length; i++) {
    const part = zip.subarray(i * chunkSize, Math.min((i + 1) * chunkSize, zip.length));
    const up = await fetch(`${BASE}/api/upload/chunk`, {
      method: 'POST', headers: H,
      body: JSON.stringify({
        uploadId, fileIndex: 0, chunkIndex: i,
        data: Buffer.from(part).toString('base64'),
      }),
    });
    assertEqual(up.status, 200, `分片 ${i} 应 200`);
  }
  const fin = await fetch(`${BASE}/api/upload/finish`, { method: 'POST', headers: H, body: JSON.stringify({ uploadId }) });
  assertEqual(fin.status, 200, `finish 应 200，实际 ${fin.status}`);
  const finBody = await fin.json();
  const id = finBody.projectId || finBody.project?.id;

  let project = null;
  for (let i = 0; i < 60; i++) {
    const st = await (await fetch(`${BASE}/api/projects/${id}/status`, { headers: H })).json();
    if (st.status === 'ready' || st.status === 'failed') { project = st; break; }
    await sleep(200);
  }
  assertEqual(project?.status, 'ready', `项目应 ready，实际 ${JSON.stringify(project)}`);

  const page = await fetch(`${BASE}/p/${id}`);
  assertEqual(page.status, 200, '入口应 200');
  const pageText = await page.text();
  assert(!pageText.includes('href="../style.css"'), 'HTML 引用应已归一');
  const css = await fetch(`${BASE}/p/${id}/style.css`);
  assertEqual(css.status, 200, 'style.css 应 200');
  assert((await css.text()).includes('url(img/bg.png)'), 'ZIP 内 CSS 的 url() 应归一');
});

// ⑥-c 项目模式 publish：编辑器里 CSS 的 url() 引用同样归一
await test('探索器：CSS 内 url(../img/x.png) → publish 归一', async () => {
  const { token } = await login();
  const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  const created = await (await fetch(`${BASE}/api/projects/explorer`, {
    method: 'POST', headers: H, body: JSON.stringify({ name: 'cssurl-expro' }),
  })).json();
  const id = created.project.id;
  const put = async (p, content) => (await fetch(`${BASE}/api/projects/${id}/files`, {
    method: 'POST', headers: H, body: JSON.stringify({ path: p, content: Buffer.from(content).toString('base64') }),
  })).status;
  assertEqual(await put('index.html', '<html><head><link rel="stylesheet" href="style.css"></head><body><h1>e</h1></body></html>'), 200, '写 index.html');
  assertEqual(await put('style.css', '.hero { background-image: url(../img/bg.png); }'), 200, '写 style.css');
  const pub = await fetch(`${BASE}/api/projects/${id}`, { method: 'POST', headers: H, body: JSON.stringify({ action: 'publish' }) });
  assertEqual(pub.status, 200, `publish 应 200，实际 ${pub.status}`);

  const css = await fetch(`${BASE}/p/${id}/style.css`);
  assertEqual(css.status, 200, 'style.css 应 200');
  const text = await css.text();
  assert(text.includes('url(img/bg.png)'), `CSS 内 url() 应归一，实际：${JSON.stringify(text.slice(0, 120))}`);
  assert(!text.includes('url(../'), '不得残留 ../ 引用');
});

// ⑦ HTML 其他引用标签：此前只归一 link[href]/script[src]，
// img/iframe/source/a/form 等全部漏掉——用户写 ../img/a.png 时图片 404、
// 内页链接跳到站点外，与 CSS/JS 断链同一症状但漏了半边
await test('HTML 其他引用标签归一（img/iframe/source/a/form/srcset）', async () => {
  const { token } = await login();
  const html = `<html><head><link rel="stylesheet" href="../style.css"></head>
<body>
  <img src="../img/a.png" alt="a">
  <img srcset="../img/a.png 1x, ../img/b.png 2x">
  <a href="../about.html">关于</a>
  <iframe src="../frame.html"></iframe>
  <source src="../v.mp4" type="video/mp4">
  <form action="../submit.html"></form>
  <div style="background:url(../img/bg.png)">x</div>
</body></html>`;
  const { status, body } = await paste(token, { name: 'tags', html, css: 'h1{color:red}', js: '' });
  assertEqual(status, 200, '粘贴应成功');
  const id = body.project.id;
  const served = await (await fetch(`${BASE}/p/${id}`)).text();
  assert(served.includes('src="img/a.png"'), `img src 应归一，实际：${served.slice(0, 400)}`);
  assert(served.includes('srcset="img/a.png 1x, img/b.png 2x"'), `srcset 应逐候选归一，实际片段：${(served.match(/srcset="[^"]*"/) || [''])[0]}`);
  assert(served.includes('href="about.html"'), 'a href 应归一');
  assert(served.includes('src="frame.html"'), 'iframe src 应归一');
  assert(served.includes('src="v.mp4"'), 'source src 应归一');
  assert(served.includes('action="submit.html"'), 'form action 应归一');
  assert(served.includes('url(img/bg.png)'), '内联 style 的 url() 应归一');
  assert(!served.includes('../'), `不得残留 ../ 引用，实际：${served.slice(0, 600)}`);
});

// ⑦-b 外链与 data URI 必须原样保留（不能被当成本地引用改写）
await test('外链与 data URI 引用保持原样', async () => {
  const { token } = await login();
  const html = `<html><head><link rel="stylesheet" href="https://cdn.example.com/s.css"></head>
<body>
  <img src="https://cdn.example.com/a.png" alt="ext">
  <img src="data:image/png;base64,iVBORw0KGgo=" alt="d">
  <a href="https://example.com/page">外站</a>
  <a href="#top">锚点</a>
  <a href="mailto:a@b.com">邮件</a>
  <script src="//cdn.example.com/j.js"></script>
</body></html>`;
  const { status, body } = await paste(token, { name: 'ext', html, css: '', js: '' });
  assertEqual(status, 200, '粘贴应成功');
  const served = await (await fetch(`${BASE}/p/${body.project.id}`)).text();
  assert(served.includes('href="https://cdn.example.com/s.css"'), '外链样式表应原样保留');
  assert(served.includes('src="https://cdn.example.com/a.png"'), '外链图片应原样保留');
  assert(served.includes('src="data:image/png;base64,iVBORw0KGgo="'), 'data URI 应原样保留');
  assert(served.includes('href="https://example.com/page"'), '外站链接应原样保留');
  assert(served.includes('href="#top"'), '锚点应原样保留');
  assert(served.includes('href="mailto:a@b.com"'), 'mailto 应原样保留');
  assert(served.includes('src="//cdn.example.com/j.js"'), '协议相对 URL 应原样保留');
});

server.kill();
try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
