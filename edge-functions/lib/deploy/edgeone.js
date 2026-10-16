// EdgeOne 线路部署适配器（第一版）
// 实现：文件写入 EdgeOne KV（同一 PAGEMAKE 命名空间），公开链接由本项目
//       p/[projectId] 路由从 KV 读取并返回。
// 选型理由：EdgeOne Pages 的程序化部署 API 尚未完整公开，KV + Functions
//           是已文档化、可跑通的方案（与社区 EoPageKV 项目做法一致）。
// 已知限制：EdgeOne 默认域名有 3 小时预览限制 → expiresAt 设为 3 小时，
//           用户可在 App 内手动刷新，或后续版本加后台自动续期。
import { kvPut, kvDel, kvListAll, keys, nowSeconds } from '../kv.js';
import { EDGEONE_PREVIEW_TTL_SECONDS } from '../state.js';

export async function deployToEdgeOne({ kv, projectId, files, entryPath, name }) {
  // 清理旧文件（同一节点立即可见；跨节点 60s 内自然过期）
  const stale = await kvListAll(kv, keys.sitePrefix(projectId));
  for (const key of stale) await kvDel(kv, key);

  // 写入文件（每个文件一个 KV 键，值 ≤ 25MB）
  for (const [path, bytes] of files) {
    await kvPut(kv, keys.siteFile(projectId, path), bytes);
  }

  // 元信息（入口 / 清单）
  const manifest = [...files.entries()].map(([path, bytes]) => ({ path, size: bytes.length }));
  await kvPut(kv, keys.siteMeta(projectId), JSON.stringify({
    name,
    entryPath,
    fileCount: files.size,
    size: manifest.reduce((a, f) => a + f.size, 0),
    files: manifest,
    deployedAt: nowSeconds(),
  }));

  return { expiresAt: nowSeconds() + EDGEONE_PREVIEW_TTL_SECONDS };
}
