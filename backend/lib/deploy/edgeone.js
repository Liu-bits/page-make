// 本地服务部署适配器（原 EdgeOne 线路，自托管容器模式）
// 实现：文件写入存储（容器版 = DATA_DIR 磁盘 KV），公开链接由本项目
//       p/[projectId] 路由直接读取并返回。
// 说明：此前的 EdgeOne 默认域名 3 小时预览限制是边缘函数方案的约束；
//       自托管容器无此限制 → expiresAt 为 null，链接长期有效（直到用户删除）。
import { kvPut, kvDel, kvListAll, keys, nowSeconds } from '../kv.js';

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

  // 自托管模式：无预览域名限制，链接长期有效
  return { expiresAt: null };
}
