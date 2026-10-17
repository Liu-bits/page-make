// 项目辅助：归属校验 / 文件清单维护 / 项目删除
import { kvGet, kvPut, kvDel, kvListAll, keys, pathFromSiteKey, nowSeconds } from './kv.js';
import { requireAuth } from './session.js';
import { fail } from './responses.js';
import { ERR } from './state.js';

/**
 * 读取项目并校验归属
 * @returns {Promise<{project, kv, user}|{error: Response}>}
 */
export async function getOwnedProject(context, id) {
  const auth = await requireAuth(context);
  if (auth.error) return auth;

  const project = await kvGet(auth.kv, keys.project(id));
  if (!project || project.userId !== auth.user.userId) {
    return { error: fail('NOT_FOUND', 404) };
  }
  return { project, kv: auth.kv, user: auth.user };
}

// 从 KV 读取项目全部文件
export async function readSiteFiles(kv, projectId) {
  const keyList = await kvListAll(kv, keys.sitePrefix(projectId));
  const files = new Map();
  for (const key of keyList) {
    const path = pathFromSiteKey(key);
    const bytes = await kv.get(key, { type: 'arrayBuffer' });
    if (bytes) files.set(path, new Uint8Array(bytes));
  }
  return files;
}

// 更新项目记录中的文件清单（重算 fileCount / size；updatedAt 作为 PHP 物化缓存的版本戳）
export async function syncProjectFiles(kv, project) {
  const keyList = await kvListAll(kv, keys.sitePrefix(project.id));
  const files = [];
  let total = 0;
  for (const key of keyList) {
    const path = pathFromSiteKey(key);
    const bytes = await kv.get(key, { type: 'arrayBuffer' });
    const size = bytes ? bytes.byteLength : 0;
    files.push({ path, size });
    total += size;
  }
  project.files = files;
  project.fileCount = files.length;
  project.size = total;
  project.updatedAt = nowSeconds();
  await kvPut(kv, keys.project(project.id), project);
  return project;
}

// 删除项目：文件 + 元信息 + 记录 + 索引
export async function deleteProjectRecords(kv, userId, id) {
  const keyList = await kvListAll(kv, keys.sitePrefix(id));
  for (const key of keyList) await kvDel(kv, key);
  await kvDel(kv, keys.siteMeta(id));
  await kvDel(kv, keys.project(id));
  await kvDel(kv, keys.userProject(userId, id));
}

// 项目状态对外输出（含过期判定：所有线路 expiresAt 到期均记为过期）
export function projectStatusView(project) {
  let status = project.status;
  if (
    status === 'ready' &&
    project.expiresAt &&
    nowSeconds() > project.expiresAt
  ) {
    status = 'expired';
  }
  return {
    projectId: project.id,
    status,
    errorCode: project.errorCode ?? null,
    url: project.url ?? null,
    diagnostics: project.diagnostics ?? [],
    runtimeErrors: project.runtimeErrors ?? [],
  };
}

export function projectPublicUrl(origin, id) {
  return `${origin}/p/${id}`;
}

export { ERR };
