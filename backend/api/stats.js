// GET /api/stats — 当前用户的用量统计（项目数 / 总大小 / 文件数 / 分维度用量）
// usedStatic / usedBackend 用于 App 侧配额进度条（静态与后端配额是两个独立维度）
import { accountKind, requireAuth } from '../lib/session.js';
import { kvGet, kvListAll, keys } from '../lib/kv.js';
import { decodeKey } from '../lib/base64.js';
import { ok } from '../lib/responses.js';
import { quotaViewJson, tierOf } from '../lib/tiers.js';
import { isBackendKind, normalizeKind } from '../lib/state.js';

export async function onRequest(context) {
  const auth = await requireAuth(context);
  if (auth.error) return auth.error;

  const prefix = keys.userProject(auth.user.userId, '');
  const indexKeys = await kvListAll(auth.kv, prefix);

  let projectCount = 0;
  let totalSize = 0;
  let fileCount = 0;
  let usedStatic = 0;
  let usedBackend = 0;

  for (const key of indexKeys) {
    const id = decodeKey(key.slice(prefix.length));
    const project = await kvGet(auth.kv, keys.project(id));
    if (!project) continue;
    projectCount += 1;
    totalSize += project.size || 0;
    fileCount += project.fileCount || 0;
    if (isBackendKind(normalizeKind(project.kind))) {
      usedBackend += project.size || 0;
    } else {
      usedStatic += project.size || 0;
    }
  }

  return ok({
    stats: { projectCount, totalSize, fileCount, usedStatic, usedBackend },
    role: tierOf(auth.user),
    tier: tierOf(auth.user),
    quota: quotaViewJson(auth.user),
    accountKind: accountKind(auth.user),
  });
}
