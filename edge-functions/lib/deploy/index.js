// 部署路由：按 provider 走对应平台
// 无论哪条线路，文件都会写入 EdgeOne KV（用于刷新 / 管理 / 灾备服务）
import { getKV, keys, kvPut, kvDel, kvListAll, nowSeconds } from '../kv.js';
import { deployToEdgeOne } from './edgeone.js';
import { deployToCloudflare } from './cloudflare.js';
import { ERR } from '../state.js';

async function persistToKV(kv, projectId, files, entryPath, name) {
  const stale = await kvListAll(kv, keys.sitePrefix(projectId));
  for (const key of stale) await kvDel(kv, key);
  for (const [path, bytes] of files) {
    await kvPut(kv, keys.siteFile(projectId, path), bytes);
  }
  const manifest = [...files.entries()].map(([path, bytes]) => ({ path, size: bytes.length }));
  await kvPut(kv, keys.siteMeta(projectId), JSON.stringify({
    name,
    entryPath,
    fileCount: files.size,
    size: manifest.reduce((a, f) => a + f.size, 0),
    files: manifest,
    deployedAt: nowSeconds(),
  }));
}

/**
 * 部署项目
 * @param {object} args { kv, env, provider, projectId, files, entryPath, name }
 * @returns {Promise<{expiresAt: number|null, deploymentUrl: string|null}>}
 */
export async function deploySite(args) {
  const { env, provider, projectId, files, entryPath, name } = args;
  const kv = args.kv || getKV(env);

  // 先落 KV（两条线路都需要：刷新、文件管理、灾备）
  await persistToKV(kv, projectId, files, entryPath, name);

  if (provider === 'edgeone') {
    const result = await deployToEdgeOne({ kv, projectId, files, entryPath, name });
    return { expiresAt: result.expiresAt, deploymentUrl: null };
  }

  if (provider === 'cloudflare') {
    const apiToken = env.CLOUDFLARE_API_TOKEN;
    const accountId = env.CLOUDFLARE_ACCOUNT_ID;
    const cfProject = env.CLOUDFLARE_PAGES_PROJECT;
    if (!apiToken || !accountId || !cfProject) {
      throw Object.assign(
        new Error('CLOUDFLARE_NOT_CONFIGURED'),
        { code: 'STORAGE_ERROR', message: 'Cloudflare 线路未配置：缺少 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_PAGES_PROJECT' }
      );
    }
    const result = await deployToCloudflare({ apiToken, accountId, projectName: cfProject, files });
    return { expiresAt: null, deploymentUrl: result.url };
  }

  throw Object.assign(new Error(`未知线路：${provider}`), { code: ERR.INVALID_PROVIDER });
}
