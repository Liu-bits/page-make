// =============================================================================
// 刷新内置 JWKS 种子（Google / Apple 登录验签用公钥）
// 用法：node scripts/refresh-jwks.mjs
// 时机：CI 部署前（保证镜像内种子新鲜）+ 每日定时（密钥轮换后自动跟进）
// 失败时不写文件（保留旧种子），退出码 1 以便 CI 可见；调用方按需 `|| true` 不阻断部署
//
// 关键语义：**只有公钥集合真的变了才写文件**
//   - 旧实现每次拉取都无条件重写（含 fetchedAt 时间戳）→ 每日必有一次 diff →
//     jwks-refresh.yaml 天天提交一次种子 → 与分支上已有的种子提交互相冲突，
//     定时任务从 2026-11-17 起连续 Failed。
//   - 现在先规范化再比较（keys 按 kid 排序、每个 key 的字段名按字母序），
//     内容没变就完全不写盘（连 fetchedAt 都不动），这样 `git diff --quiet`
//     才真正等于“密钥轮换了”。
// =============================================================================
import { readFile, writeFile, mkdir } from 'node:fs/promises';
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

    const nextKeys = canonicalKeys(data.keys);
    const prevKeys = canonicalKeys(await readKeys(file));

    if (JSON.stringify(nextKeys) === JSON.stringify(prevKeys)) {
      console.log(`= ${source.name}: ${nextKeys.length} 把密钥（无变化，不写文件）→ ${path.relative(ROOT, file)}`);
      continue;
    }

    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      `${JSON.stringify({ keys: nextKeys, fetchedAt: new Date().toISOString(), source: 'ci' }, null, 2)}\n`,
    );
    console.log(`✓ ${source.name}: ${nextKeys.length} 把密钥（有更新）→ ${path.relative(ROOT, file)}`);
    console.log(`  kid: [${prevKeys.map((k) => k.kid).join(',')}] → [${nextKeys.map((k) => k.kid).join(',')}]`);
  } catch (error) {
    failed++;
    console.error(`✗ ${source.name}: ${error?.message || error}（保留旧种子）`);
  }
}

if (failed) {
  console.error(`${failed} 个 JWKS 源刷新失败`);
  process.exit(1);
}

// 规范化公钥集合：数组按 kid 排序、每个 key 的字段名按字母序输出。
// Google / Apple 每次响应的字段与数组顺序并不稳定，不规范化会让“没轮换”也产生 diff。
function canonicalKeys(keys) {
  if (!Array.isArray(keys)) return [];
  return keys
    .filter((key) => key && typeof key === 'object')
    .map((key) => {
      const sorted = {};
      for (const name of Object.keys(key).sort()) sorted[name] = key[name];
      return sorted;
    })
    .sort((a, b) => String(a.kid || '').localeCompare(String(b.kid || '')));
}

async function readKeys(file) {
  try {
    const data = JSON.parse(await readFile(file, 'utf8'));
    return data.keys || [];
  } catch {
    return [];
  }
}
