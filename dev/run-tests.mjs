// =============================================================================
// Page-make 后端单元测试（Node 22，无第三方依赖）
// 运行：node dev/run-tests.mjs
// =============================================================================
import { buildZip } from './make-zip.mjs';
import { unzip, ZipError } from '../edge-functions/lib/zip.js';
import { findEntry, analyzeHtml, autoPreviewHtml } from '../edge-functions/lib/diagnostics.js';
import {
  keys, pathFromSiteKey, nowSeconds,
} from '../edge-functions/lib/kv.js';
import { bytesToBase64, base64ToBytes, base64urlToBytes, encodeKey, decodeKey } from '../edge-functions/lib/base64.js';
import { decodeJwt } from '../edge-functions/lib/apple-auth.js';
import { processUpload } from '../edge-functions/lib/process.js';
import {
  STATUS, ERR, PROVIDERS, SESSION_TTL_SECONDS, EDGEONE_PREVIEW_TTL_SECONDS,
  MAX_TOTAL_BYTES, CHUNK_BYTES, BAN_LEVELS,
} from '../edge-functions/lib/state.js';
import { contentTypeFor } from '../edge-functions/lib/responses.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ✓ ${name}`);
    })
    .catch((error) => {
      failed++;
      console.error(`  ✗ ${name}`);
      console.error(`    ${error?.message || error}`);
    });
}

function assert(condition, message) {
  if (!condition) throw new Error(message || '断言失败');
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || '断言失败'}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

// 内存 KV mock（模拟 EdgeOne KV API）
function createMockKV() {
  const store = new Map();
  return {
    async put(key, value) { store.set(key, value); },
    async get(key, opts) {
      const v = store.get(key);
      if (v === undefined || v === null) return null;
      const type = typeof opts === 'string' ? opts : opts?.type || 'text';
      if (type === 'json') {
        return typeof v === 'string' ? JSON.parse(v) : v;
      }
      if (type === 'arrayBuffer') {
        const u8 = typeof v === 'string' ? new TextEncoder().encode(v) : v;
        return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
      }
      return typeof v === 'string' ? v : null;
    },
    async delete(key) { store.delete(key); },
    async list(opts = {}) {
      const prefix = opts.prefix || '';
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).slice(0, opts.limit || 256);
      return { complete: true, cursor: null, keys: keys.map((k) => ({ key: k })) };
    },
    _store: store,
  };
}

// ---------------------------------------------------------------------------
console.log('\n[1] ZIP 解压');

await test('解压 stored + deflate 混合条目', async () => {
  const zip = buildZip([
    ['index.html', '<html><body>Hello</body></html>', { deflate: true }],
    ['css/style.css', 'body { color: red; }'],
  ]);
  const files = await unzip(zip);
  assertEqual(files.size, 2);
  assertEqual(new TextDecoder().decode(files.get('index.html')), '<html><body>Hello</body></html>');
  assertEqual(new TextDecoder().decode(files.get('css/style.css')), 'body { color: red; }');
});

await test('过滤 __MACOSX / .DS_Store / 隐藏文件', async () => {
  const zip = buildZip([
    ['index.html', '<html></html>'],
    ['__MACOSX/._index.html', 'junk'],
    ['.DS_Store', 'junk'],
    ['.git/config', 'junk'],
    ['assets/logo.png', new Uint8Array([1, 2, 3, 4])],
  ]);
  const files = await unzip(zip);
  assertEqual(files.size, 2);
  assert(files.has('index.html'));
  assert(files.has('assets/logo.png'));
});

await test('二进制内容完整（deflate 往返）', async () => {
  const binary = new Uint8Array(1000);
  for (let i = 0; i < binary.length; i++) binary[i] = (i * 7) % 256;
  const zip = buildZip([['data.bin', binary, { deflate: true }]]);
  const files = await unzip(zip);
  const decoded = files.get('data.bin');
  assertEqual(decoded.length, binary.length);
  for (let i = 0; i < binary.length; i++) assertEqual(decoded[i], binary[i]);
});

await test('损坏的 zip 抛 BAD_ZIP', async () => {
  let error;
  try {
    await unzip(new ArrayBuffer(64));
  } catch (e) {
    error = e;
  }
  assert(error instanceof ZipError, '应为 ZipError');
  assertEqual(error.code, 'BAD_ZIP');
});

// ---------------------------------------------------------------------------
console.log('\n[2] 入口查找');

await test('优先根目录 index.html（大小写不敏感）', async () => {
  const files = new Map([['Index.HTML', new Uint8Array()], ['sub/page.html', new Uint8Array()]]);
  assertEqual(findEntry(files), 'Index.HTML');
});

await test('没有 index 时取根目录任意 html', async () => {
  const files = new Map([['about.html', new Uint8Array()], ['sub/page.html', new Uint8Array()]]);
  assertEqual(findEntry(files), 'about.html');
});

await test('没有 html 返回 null', async () => {
  const files = new Map([['style.css', new Uint8Array()]]);
  assertEqual(findEntry(files), null);
});

// ---------------------------------------------------------------------------
console.log('\n[3] 静态诊断');

await test('缺失文件 / 大小写 / 中文路径全部识别', async () => {
  const html = `<!DOCTYPE html>
<html>
<head>
  <link rel="stylesheet" href="style.css">
  <link rel="stylesheet" href="STYLE.CSS">
  <link rel="stylesheet" href="missing.css">
  <link rel="icon" href="图/logo.png">
  <script src="app.js"></script>
</head>
<body><img src="https://cdn.example.com/x.png"></body>
</html>`;
  const files = new Map([
    ['STYLE.CSS', new Uint8Array()],
    ['app.js', new Uint8Array()],
  ]);
  const diagnostics = analyzeHtml(html, files);
  const kinds = diagnostics.map((d) => d.kind);
  assert(kinds.includes('missingFile'), '应识别缺失的 missing.css');
  assert(kinds.includes('caseMismatch'), '应识别 style.css 与 STYLE.CSS 大小写不一致');
  assert(kinds.includes('chinesePath'), '应识别中文路径');
  assert(!diagnostics.some((d) => d.detail.includes('app.js')), '存在的文件不应报缺失');
  assert(!diagnostics.some((d) => d.detail.includes('cdn.example.com')), '外链应忽略');
  const missing = diagnostics.find((d) => d.kind === 'missingFile' && d.detail.includes('missing.css'));
  assert(missing, 'missing.css 应报 missingFile');
  assertEqual(missing.line, 6, '行号应为 6');
  assert(missing.suggestion.length > 0, '应带小白话建议');
});

await test('引用与实际大小写不一致时识别 caseMismatch', async () => {
  const html = '<html><head><link href="Style.css"></head></html>';
  const files = new Map([['style.css', new Uint8Array()]]);
  const diagnostics = analyzeHtml(html, files);
  assertEqual(diagnostics.length, 1);
  assertEqual(diagnostics[0].kind, 'caseMismatch');
});

// ---------------------------------------------------------------------------
console.log('\n[4] 自动预览页');

await test('自动生成预览页包含标题', () => {
  const html = autoPreviewHtml('my-site.zip');
  assert(html.startsWith('<!DOCTYPE html>'), '应为完整 HTML');
  assert(html.includes('my-site.zip'), '应包含文件名');
});

await test('HTML 转义防注入', () => {
  const html = autoPreviewHtml('<script>alert(1)</script>');
  assert(!html.includes('<script>alert(1)</script>'), '应转义危险字符');
  assert(html.includes('&lt;script&gt;'));
});

// ---------------------------------------------------------------------------
console.log('\n[5] KV key 编码');

await test('encodeKey/decodeKey 可逆（含中文与特殊字符）', () => {
  for (const input of ['user-123', 'css/style.css', '图/logo.png', 'a b&c=d', 'index.html']) {
    const encoded = encodeKey(input);
    assert(/^[0-9a-f]*$/.test(encoded), '编码结果应只含十六进制字符');
    assertEqual(decodeKey(encoded), input);
  }
});

await test('site key 前缀与路径还原', () => {
  const projectId = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  const key = keys.siteFile(projectId, 'css/style.css');
  assert(key.startsWith(`site_${encodeKey(projectId)}_`));
  assertEqual(pathFromSiteKey(key), 'css/style.css');
});

// ---------------------------------------------------------------------------
console.log('\n[6] base64');

await test('base64 往返（二进制）', () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
  const b64 = bytesToBase64(bytes);
  const decoded = base64ToBytes(b64);
  assertEqual(decoded.length, bytes.length);
  for (let i = 0; i < bytes.length; i++) assertEqual(decoded[i], bytes[i]);
});

await test('base64url → bytes（JWT 用）', () => {
  const bytes = base64urlToBytes('eyJhbGciOiJSUzI1NiJ9'); // {"alg":"RS256"}
  const text = new TextDecoder().decode(bytes);
  assert(text.includes('RS256'), '应解码出 JWT header');
});

// ---------------------------------------------------------------------------
console.log('\n[7] JWT 解码');

await test('decodeJwt 解析 header/payload', async () => {
  const header = bytesToBase64(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', kid: 'ABC' })))
    .replace(/=+$/, '');
  const payload = bytesToBase64(new TextEncoder().encode(JSON.stringify({ sub: 'user-xyz', iss: 'https://appleid.apple.com' })))
    .replace(/=+$/, '');
  const token = `${header}.${payload}.signature`;
  const decoded = decodeJwt(token);
  assertEqual(decoded.header.alg, 'RS256');
  assertEqual(decoded.header.kid, 'ABC');
  assertEqual(decoded.payload.sub, 'user-xyz');
});

// ---------------------------------------------------------------------------
console.log('\n[8] 完整上传管线（内存 KV · EdgeOne 线路）');

await test('zip 上传 → 解压 → 诊断 → 部署 → 项目记录', async () => {
  const kv = createMockKV();
  const uploadId = 'a'.repeat(32);
  const projectId = 'b'.repeat(32);
  const origin = 'https://page-make.edgeone.app';

  // 构造 zip：index.html 引用缺失的 style.css 与存在的 img/logo.png
  const html = `<!DOCTYPE html>
<html>
<head>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <img src="img/logo.png" alt="logo">
</body>
</html>`;
  const zip = buildZip([
    ['index.html', html, { deflate: true }],
    ['img/logo.png', new Uint8Array([137, 80, 78, 71]), { deflate: true }],
    ['__MACOSX/._index.html', 'junk'],
  ]);

  await kv.put(keys.uploadChunk(uploadId, 0, 0), new Uint8Array(zip));
  await kv.put(keys.upload(uploadId), JSON.stringify({
    uploadId,
    userId: 'user-1',
    provider: 'edgeone',
    files: [{ name: 'site.zip', size: zip.length }],
    createdAt: nowSeconds(),
  }));

  await processUpload({ kv, upload: JSON.parse(await kv.get(keys.upload(uploadId))), projectId, origin, env: {} });

  const project = await kv.get(keys.project(projectId), { type: 'json' });
  assertEqual(project.status, STATUS.READY);
  assertEqual(project.provider, 'edgeone');
  assertEqual(project.entryPath, 'index.html');
  assertEqual(project.url, `${origin}/p/${projectId}`);
  assert(project.expiresAt > nowSeconds(), 'expiresAt 应在未来');
  assert(project.expiresAt <= nowSeconds() + EDGEONE_PREVIEW_TTL_SECONDS + 5, '应在 3 小时窗口内');
  assertEqual(project.autoGenerated, false);
  assertEqual(project.sourceType, 'zip');
  assertEqual(project.fileCount, 2, '__MACOSX 应被过滤');

  // 诊断：style.css 缺失
  const missing = project.diagnostics.find((d) => d.kind === 'missingFile' && d.detail.includes('style.css'));
  assert(missing, '应报告 style.css 缺失');

  // 文件已写入 site keys，可被 /p/ 路由读取
  const entryBytes = await kv.get(keys.siteFile(projectId, 'index.html'), { type: 'arrayBuffer' });
  assert(entryBytes, '入口文件应可从 KV 读取');
  const logoBytes = await kv.get(keys.siteFile(projectId, 'img/logo.png'), { type: 'arrayBuffer' });
  assertEqual(new Uint8Array(logoBytes).length, 4);

  // 临时分片已清理
  assertEqual(await kv.get(keys.uploadChunk(uploadId, 0, 0), { type: 'arrayBuffer' }), null);
  assertEqual(await kv.get(keys.upload(uploadId)), null);

  // 项目索引存在
  const index = await kv.get(keys.userProject('user-1', projectId), { type: 'json' });
  assert(index && typeof index.createdAt === 'number');

  // 内容类型
  assertEqual(contentTypeFor('index.html'), 'text/html; charset=utf-8');
  assertEqual(contentTypeFor('css/style.css'), 'text/css; charset=utf-8');
  assertEqual(contentTypeFor('app.js'), 'application/javascript; charset=utf-8');
  assertEqual(contentTypeFor('img/logo.png'), 'image/png');
  assertEqual(contentTypeFor('data.bin'), 'application/octet-stream');
});

await test('没有 HTML → 自动生成预览页（autoGenerated）', async () => {
  const kv = createMockKV();
  const uploadId = 'c'.repeat(32);
  const projectId = 'd'.repeat(32);
  const zip = buildZip([['readme.txt', 'hello']]);
  await kv.put(keys.uploadChunk(uploadId, 0, 0), new Uint8Array(zip));
  const upload = {
    uploadId, userId: 'user-2', provider: 'edgeone',
    files: [{ name: 'site.zip', size: zip.length }], createdAt: nowSeconds(),
  };

  await processUpload({ kv, upload, projectId, origin: 'https://x.edgeone.app', env: {} });
  const project = await kv.get(keys.project(projectId), { type: 'json' });
  assertEqual(project.status, STATUS.READY);
  assertEqual(project.autoGenerated, true);
  assertEqual(project.entryPath, 'index.html');
  const entry = new TextDecoder().decode(new Uint8Array(await kv.get(keys.siteFile(projectId, 'index.html'), { type: 'arrayBuffer' })));
  assert(entry.includes('预览页'), '自动预览页应含提示文案');
});

await test('单文件（非 zip）上传走 single 类型', async () => {
  const kv = createMockKV();
  const uploadId = 'e'.repeat(32);
  const projectId = 'f'.repeat(32);
  const content = new TextEncoder().encode('<html><body>hi</body></html>');
  await kv.put(keys.uploadChunk(uploadId, 0, 0), content);
  const upload = {
    uploadId, userId: 'user-3', provider: 'edgeone',
    files: [{ name: 'index.html', size: content.length }], createdAt: nowSeconds(),
  };
  await processUpload({ kv, upload, projectId, origin: 'https://x.edgeone.app', env: {} });
  const project = await kv.get(keys.project(projectId), { type: 'json' });
  assertEqual(project.status, STATUS.READY);
  assertEqual(project.sourceType, 'single');
  assertEqual(project.fileCount, 1);
});

// ---------------------------------------------------------------------------
console.log('\n[9] 状态机与常量');

await test('状态码与错误码齐全', () => {
  for (const s of ['uploading', 'processing', 'ready', 'failed', 'expired']) {
    assert(Object.values(STATUS).includes(s), `缺少状态 ${s}`);
  }
  for (const e of ['NO_ENTRY', 'TOO_LARGE', 'BAD_ZIP', 'STORAGE_ERROR', 'DB_ERROR', 'INVALID_PROVIDER', 'EXPIRED']) {
    assert(Object.values(ERR).includes(e), `缺少错误码 ${e}`);
  }
  assert(PROVIDERS.has('edgeone') && PROVIDERS.has('cloudflare'));
  assertEqual(SESSION_TTL_SECONDS, 7 * 24 * 3600, '登录态 7 天');
  assertEqual(EDGEONE_PREVIEW_TTL_SECONDS, 3 * 3600, 'EdgeOne 默认域名 3 小时');
  assertEqual(MAX_TOTAL_BYTES, 5 * 1024 * 1024, '总大小 5MB');
  assert(CHUNK_BYTES <= 900 * 1024, '分片应保证 base64 后 < 1MB body 限制');
  assertEqual(BAN_LEVELS.L1.days, 1);
  assertEqual(BAN_LEVELS.L4.days, null);
});

// ---------------------------------------------------------------------------
console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
process.exit(failed > 0 ? 1 : 0);
