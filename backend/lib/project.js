// 项目辅助：归属校验 / 文件清单维护 / 项目删除
import { kvGet, kvPut, kvDel, kvListAll, keys, pathFromSiteKey, nowSeconds } from './kv.js';
import { requireAuth } from './session.js';
import { fail } from './responses.js';
import { ERR } from './state.js';
import { isValidRelPath } from './paths.js';
import { withLock } from './lock.js';
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
//
// **故意不加锁**：files.js 的 lockedProject() 已经持有 `project:<id>` 锁并在锁内
// 调用本函数，锁不可重入，这里再加锁会自锁死整个文件 API。
// 需要锁定语义的调用方（[id].js / refresh.js 的发布与刷新回写）请用下面的
// syncProjectFilesLocked。patch 用于把状态类字段（status / runtimePort 等）
// 与文件清单在同一次临界区里合并写回，避免两次写之间被并发修改穿插。
export async function syncProjectFiles(kv, project, patch = null) {
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
  if (patch) Object.assign(project, patch);
  project.updatedAt = nowSeconds();
  await kvPut(kv, keys.project(project.id), project);
  return project;
}

/* ============================== 项目记录写原语 ==============================
 *
 * 项目记录（keys.project(id)）的写入方遍布五处：管理端封禁/解封/升降级/删除、
 * 公开页游客 TTL 刷新、文件编辑器、发布/刷新回写、上传处理管线。它们全是
 * 「读记录 → 改字段 → 写回」模式，不加锁时两个并发请求各自拿旧快照回写，
 * 后写者会把先写者的变更整体覆盖掉：
 *   - 封号瞬间用户正好访问公开页 → 旧快照把 status: 'banned' 覆盖回正常；
 *   - 删号瞬间公开页刷新 TTL → 已删除的记录被复活成幽灵项目；
 *   - 解封异步恢复部署期间项目又被封 → 恢复任务把 banned 覆盖回 ready。
 * 统一约定：**所有项目记录写入都必须走下面四个原语之一**（files.js 自带
 * lockedProject 临界区，锁内直接调 syncProjectFiles / kvPut，属同一约定）。
 * ========================================================================== */

/**
 * 项目记录读改写（锁内重读最新快照后交给 mutate 修改并写回）。
 * @param {Function} mutate 接收最新记录就地修改；返回 false 表示本次不写回
 * @returns {object|null} 锁内读到的最新记录；记录不存在时返回 null
 */
export async function mutateProject(kv, projectId, mutate) {
  return withLock(`project:${projectId}`, async () => {
    const record = await kvGet(kv, keys.project(projectId));
    if (!record) return null;
    if (mutate(record) !== false) {
      await kvPut(kv, keys.project(projectId), record);
    }
    return record;
  });
}

/**
 * 项目记录创建/整体写回（上传管线用）。锁内复核：记录已存在且为封禁状态时
 * 不写入（返回 null），防止「封号瞬间上传处理完成」把项目写成 ready 绕过下架。
 * @param {Function} build 接收已存在的记录（可能为 null），返回要写入的完整记录
 */
export async function writeProjectRecord(kv, projectId, build) {
  return withLock(`project:${projectId}`, async () => {
    const existing = await kvGet(kv, keys.project(projectId));
    if (existing && existing.status === 'banned') return null;
    const record = build(existing);
    await kvPut(kv, keys.project(projectId), record);
    return record;
  });
}

/**
 * 锁定版文件清单同步：锁内重读最新记录 → 重算文件清单 → 合并 patch → 写回。
 * 与 mutateProject 同锁粒度，发布/刷新的异步回写用它替代「手动 kvGet latest
 * 再整记录写回」的旧模式（那类写回在项目被并发删除时会复活记录）。
 * @returns {object|null} 写回后的最新记录；记录已被并发删除时返回 null
 */
export async function syncProjectFilesLocked(kv, projectId, patch = null) {
  return withLock(`project:${projectId}`, async () => {
    const record = await kvGet(kv, keys.project(projectId));
    if (!record) return null;
    // 封禁守卫：发布/刷新是慢速异步任务，回写期间账号可能刚被封禁。
    // 不加这条守卫会把 banned 状态覆盖回 ready，等于绕过下架。
    // （调用方拿到 null 应按「项目已不可见」处理，如回收常驻进程。）
    if (record.status === 'banned') return null;
    await syncProjectFiles(kv, record, patch);
    return record;
  });
}

/**
 * 锁定版项目删除：文件 + 元信息 + 记录 + 索引一次删净。
 * 锁内复核记录仍在（可能已被并发删除），删除期间公开页 TTL 刷新等并发写
 * 会排在锁后面，读到的是删除后的空记录 → 不会复活。
 * @returns {boolean} 是否实际删除了记录
 */
export async function deleteProjectGuarded(kv, userId, projectId) {
  return withLock(`project:${projectId}`, async () => {
    const record = await kvGet(kv, keys.project(projectId));
    if (!record) return false;
    // 后端项目有常驻 Node 进程，必须先回收再删 KV；否则项目虽然 404，
    // 端口和内存仍被旧进程占着。
    await stopBackendRuntime(projectId);
    const keyList = await kvListAll(kv, keys.sitePrefix(projectId));
    for (const key of keyList) await kvDel(kv, key);
    await kvDel(kv, keys.siteMeta(projectId));
    await kvDel(kv, keys.project(projectId));
    await kvDel(kv, keys.userProject(userId, projectId));
    return true;
  });
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

// 删除项目：文件 + 元信息 + 记录 + 索引（委托锁定版，防并发写复活记录）
export async function deleteProjectRecords(kv, userId, id) {
  return deleteProjectGuarded(kv, userId, id);
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
