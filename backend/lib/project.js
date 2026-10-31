// 项目辅助：归属校验 / 文件清单维护 / 项目删除
import { kvGet, kvPut, kvDel, kvListAll, keys, pathFromSiteKey, nowSeconds } from './kv.js';
import { requireAuth } from './session.js';
import { fail } from './responses.js';
import { ERR } from './state.js';
import { isValidRelPath } from './paths.js';
import { stop as stopBackendRuntime } from './backend-runtime.js';

const PHP_FILE_RE = /\.php$/i;

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
    // PHP 已移除：历史项目中的 .php 文件不再参与发布、刷新或文件清单。
    if (PHP_FILE_RE.test(path)) continue;
    const bytes = await kv.get(key, { type: 'arrayBuffer' });
    if (bytes) files.set(path, new Uint8Array(bytes));
  }
  return files;
}

// 更新项目记录中的文件清单（重算 fileCount / size / updatedAt）
export async function syncProjectFiles(kv, project) {
  const keyList = await kvListAll(kv, keys.sitePrefix(project.id));
  const files = [];
  let total = 0;
  for (const key of keyList) {
    const path = pathFromSiteKey(key);
    // 保留磁盘上的历史文件不主动删除，但不再向客户端暴露。
    if (PHP_FILE_RE.test(path)) continue;
    const bytes = await kv.get(key, { type: 'arrayBuffer' });
    const size = bytes ? bytes.byteLength : 0;
    files.push({ path, size });
    total += size;
  }
  project.files = files;
  project.fileCount = files.length;
  project.size = total;
  // 文件夹既可能来自文件路径推导，也可能由用户显式创建（空文件夹）。
  // 持久化后刷新/重新打开项目仍能看到空目录，行为更接近桌面资源管理器。
  project.folders = normalizeFolders(project.folders, files.map((file) => file.path));
  // 历史 PHP 入口在重新发布/刷新时必须失效，避免继续生成 404 链接。
  if (project.entryPath && PHP_FILE_RE.test(project.entryPath)) project.entryPath = null;
  project.updatedAt = nowSeconds();
  await kvPut(kv, keys.project(project.id), project);
  return project;
}

/**
 * 归一文件夹清单：
 * - 去掉非法、重复项
 * - 自动补齐文件的父目录（如 css/theme/style.css → css、css/theme）
 * - 排序保证接口输出稳定
 */
export function normalizeFolders(explicitFolders, filePaths = []) {
  const result = new Set();
  const add = (path) => {
    if (!isValidRelPath(path)) return;
    const parts = path.split('/');
    let current = '';
    for (const part of parts) {
      if (!part || part === '.' || part === '..') return;
      current = current ? `${current}/${part}` : part;
      result.add(current);
    }
  };
  if (Array.isArray(explicitFolders)) {
    for (const folder of explicitFolders) {
      if (typeof folder === 'string') add(folder);
    }
  }
  for (const filePath of filePaths) {
    if (typeof filePath !== 'string' || !filePath.includes('/')) continue;
    add(filePath.split('/').slice(0, -1).join('/'));
  }
  return [...result].sort((a, b) => a.localeCompare(b));
}

// 删除项目：文件 + 元信息 + 记录 + 索引
export async function deleteProjectRecords(kv, userId, id) {
  // 后端项目有常驻 Node 进程，必须先回收再删 KV；否则项目虽然 404，
  // 端口和内存仍被旧进程占着。
  await stopBackendRuntime(id);
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
