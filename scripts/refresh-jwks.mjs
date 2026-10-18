// =============================================================================
// 刷新内置 JWKS 种子（Google / Apple 登录验签用公钥）
// 用法：node scripts/refresh-jwks.mjs
// 时机：CI 部署前（保证镜像内种子新鲜）+ 每日定时（密钥轮换后自动跟进）
// 失败时不写文件（保留旧种子），退出码 1 以便 CI 可见；调用方按需 `|| true` 不阻断部署
// =============================================================================
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SOURCES = [
  { name: 'google', url: 'https://www.googleapis.com/oauth2/v3/certs' },
  { name: 'apple', url: 'https://appleid.apple.com/auth/keys' },
];

let failed = 0;

for (const source of SOURCES) {
  const file = path.join(ROOT, 'backend', 'data', `${source.name}-jwks.json`);
  try {
    const response = await fetch(source.url, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data.keys) || data.keys.length === 0) throw new Error('JWKS 响应为空');
    const kidBefore = await readKids(file);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify({ keys: data.keys, fetchedAt: new Date().toISOString(), source: 'ci' }, null, 2)}\n`);
    const kidAfter = data.keys.map((k) => k.kid).join(',');
    console.log(`✓ ${source.name}: ${data.keys.length} 把密钥（${kidBefore === kidAfter ? '无变化' : '有更新'}）→ ${path.relative(ROOT, file)}`);
  } catch (error) {
    failed++;
    console.error(`✗ ${source.name}: ${error?.message || error}（保留旧种子）`);
  }
}

async function readKids(file) {
  try {
    const data = JSON.parse(await (await import('node:fs/promises')).readFile(file, 'utf8'));
    return (data.keys || []).map((k) => k.kid).join(',');
  } catch {
    return '';
  }
}

if (failed) {
  console.error(`${failed} 个 JWKS 源刷新失败`);
  process.exit(1);
}
