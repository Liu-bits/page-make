// GET    /api/projects/:id/files?path=... — 读取文件内容（base64，编辑器用）
// POST   /api/projects/:id/files — 创建/覆盖文件（body: { path, content(base64) }）
//        action: remove（删文件）/ createFolder / removeFolder / rename
// DELETE /api/projects/:id/files — 删除文件（body: { path }）
// 说明：项目模式支持 .html / .css / .js；文件夹可显式创建并持久化
import { getOwnedProject, syncProjectFiles, normalizeFolders } from '../../../lib/project.js';
import { keys, kvDel, kvGet, kvListAll, pathFromSiteKey, kvPut } from '../../../lib/kv.js';
import { withLock } from '../../../lib/lock.js';
import { base64ToBytes, bytesToBase64 } from '../../../lib/base64.js';
import { ok, fail } from '../../../lib/responses.js';
import { STATUS, isBackendKind, normalizeKind } from '../../../lib/state.js';
import { quotaFor } from '../../../lib/tiers.js';
import { isValidRelPath } from '../../../lib/paths.js';

// 支持的文件类型（.htm 视同 .html）
// 纯前端项目只允许 html/css/js；后端项目还要放 package.json、TS 源码、
// 构建配置和静态资源。两份白名单分开，避免放宽静态项目的边界。
const STATIC_EXT_RE = /\.(html?|css|js)$/i;
const BACKEND_EXT_RE = /\.(html?|css|js|mjs|cjs|json|ts|tsx|jsx|md|txt|yml|yaml|toml|xml|graphql|gql|sql|map|wasm|svg|png|jpe?g|gif|webp|ico|bmp|avif|woff2?|ttf|otf|eot|mp3|mp4|webm|pdf|csv|lockb?)$/i;

/** 按项目形态选择允许的扩展名（.php 永远拒绝） */
function extAllowed(path, kind) {
  if (/\.php$/i.test(path)) return false;
  const re = isBackendKind(normalizeKind(kind)) ? BACKEND_EXT_RE : STATIC_EXT_RE;
  return re.test(path);
}

// 路径安全：禁止 ..、反斜杠、控制字符、首尾斜杠、超长
function validPath(path) {
  return isValidRelPath(path) && !path.split('/').some((part) => !part || part === '.');
}

function validFolderPath(path) {
  return validPath(path);
}

function isFolderConflict(project, folder) {
  return (project.folders || []).includes(folder)
    || (project.files || []).some(
      (file) => file.path === folder || file.path.startsWith(`${folder}/`)
    );
}

// 不允许把文件当成目录使用：index.html/sub.css 这类路径会让文件树无法表达。
function hasFileAncestor(project, path) {
  const parts = path.split('/');
  let current = '';
  for (let index = 0; index < parts.length - 1; index += 1) {
    current = current ? `${current}/${parts[index]}` : parts[index];
    if ((project.files || []).some((file) => file.path === current)) return true;
  }
  return false;
}

function hasDestinationConflict(project, target, sourceFolder = null) {
  const sourcePrefix = sourceFolder ? `${sourceFolder}/` : null;
  return (project.folders || []).some((folder) => {
    if (sourceFolder && (folder === sourceFolder || folder.startsWith(sourcePrefix))) return false;
    return folder === target || folder.startsWith(`${target}/`);
  }) || (project.files || []).some((file) => {
    if (sourceFolder && (file.path === sourceFolder || file.path.startsWith(sourcePrefix))) return false;
    return file.path === target || file.path.startsWith(`${target}/`);
  });
}

function addParentFolders(project, path) {
  const parent = path.split('/').slice(0, -1).join('/');
  if (parent) project.folders = normalizeFolders([...(project.folders || []), parent], project.files?.map((file) => file.path) || []);
}

/**
 * 在项目锁内执行一次写操作，并把「最新记录」交给回调。
 *
 * 所有会调用 syncProjectFiles 的分支（写入 / 删除 / 新建文件夹 / 重命名）
 * 都会按 KV 实际内容重建 files 与 size。若不串行，两个并发请求各自拿着
 * 旧快照回写，后写的那个会把前一个的 folders / entryPath 更新覆盖掉
 * （表现为「刚建的文件夹消失」「刚设的入口变回 null」）。
 * 锁内必须重新 kvGet：getOwnedProject 读到的快照可能已经过期。
 */
function lockedProject(kv, projectId, task) {
  return withLock(`project:${projectId}`, async () => {
    const latest = await kvGet(kv, keys.project(projectId));
    if (!latest) return fail('NOT_FOUND', 404);
    return task(latest);
  });
}

export async function onRequest(context) {
  const { request, params } = context;
  const result = await getOwnedProject(context, params?.id);
  if (result.error) return result.error;
  const { project, kv } = result;

  // ---- 读取文件内容（编辑器载入） ----
  if (request.method === 'GET') {
    const path = new URL(request.url).searchParams.get('path') || '';
    // 历史 .php 文件不再暴露，即使磁盘上仍保留也不允许通过编辑器读取。
    if (!validPath(path) || !extAllowed(path, project.kind)) {
      return fail('BAD_REQUEST', 400);
    }
    const bytes = await kv.get(keys.siteFile(project.id, path), { type: 'arrayBuffer' });
    if (!bytes) return fail('NOT_FOUND', 404);
    return ok({ path, content: bytesToBase64(new Uint8Array(bytes)) });
  }

  // ---- POST / DELETE ----
  let body;
  try {
    body = await request.json();
  } catch {
    return fail('BAD_REQUEST', 400);
  }
  const path = body?.path;

  if (request.method === 'POST' && body?.action === 'remove') {
    if (!validPath(path) || !extAllowed(path, project.kind)) return fail('BAD_REQUEST', 400);
    return lockedProject(kv, project.id, async (latest) => {
      await kvDel(kv, keys.siteFile(latest.id, path));
      if (latest.entryPath === path) latest.entryPath = null;
      await syncProjectFiles(kv, latest);
      return ok({ project: latest });
    });
  }

  if (request.method === 'POST' && body?.action === 'createFolder') {
    const folder = body?.path;
    if (!validFolderPath(folder)) return fail('BAD_REQUEST', 400);
    return lockedProject(kv, project.id, async (latest) => {
      if (isFolderConflict(latest, folder) || hasFileAncestor(latest, folder)) {
        return fail('CONFLICT', 409);
      }
      latest.folders = normalizeFolders(
        [...(latest.folders || []), folder],
        latest.files?.map((file) => file.path) || []
      );
      await syncProjectFiles(kv, latest);
      return ok({ project: latest });
    });
  }

  if (request.method === 'POST' && body?.action === 'removeFolder') {
    const folder = body?.path;
    if (!validFolderPath(folder)) return fail('BAD_REQUEST', 400);
    const prefix = `${folder}/`;
    return lockedProject(kv, project.id, async (latest) => {
      const fileKeys = await kvListAll(kv, keys.sitePrefix(latest.id));
      for (const key of fileKeys) {
        const filePath = pathFromSiteKey(key);
        if (filePath === folder || filePath.startsWith(prefix)) await kvDel(kv, key);
      }
      latest.folders = normalizeFolders(
        (latest.folders || []).filter((item) => item !== folder && !item.startsWith(prefix)),
        (latest.files || []).map((file) => file.path).filter((item) => item !== folder && !item.startsWith(prefix))
      );
      if (latest.entryPath === folder || latest.entryPath?.startsWith(prefix)) {
        latest.entryPath = null;
      }
      await syncProjectFiles(kv, latest);
      return ok({ project: latest });
    });
  }

  if (request.method === 'POST' && body?.action === 'rename') {
    const from = body?.from;
    const to = body?.to;
    if (!validPath(from) || !validPath(to) || from === to) return fail('BAD_REQUEST', 400);
    return lockedProject(kv, project.id, async (latest) => {
      const isFolder = (latest.folders || []).includes(from)
        || (latest.files || []).some((file) => file.path.startsWith(`${from}/`));
      if (isFolder) {
        if (to.startsWith(`${from}/`)) return fail('BAD_REQUEST', 400);
        if (hasFileAncestor(latest, to) || hasDestinationConflict(latest, to, from)) {
          return fail('CONFLICT', 409);
        }
        const prefix = `${from}/`;
        const fileKeys = await kvListAll(kv, keys.sitePrefix(latest.id));
        const moves = [];
        for (const key of fileKeys) {
          const filePath = pathFromSiteKey(key);
          if (!filePath.startsWith(prefix)) continue;
          const target = `${to}/${filePath.slice(prefix.length)}`;
          if (!validPath(target)) return fail('BAD_REQUEST', 400);
          const bytes = await kv.get(key, { type: 'arrayBuffer' });
          if (bytes) moves.push({ key, target, bytes: new Uint8Array(bytes) });
        }
        for (const move of moves) {
          await kvPut(kv, keys.siteFile(latest.id, move.target), move.bytes);
          await kvDel(kv, move.key);
        }
        // 所有被移动文件的最终路径。syncProjectFiles 会按 KV 实际内容重建 files，
        // 但 folders 必须在这里按同一份路径表迁移，不能用旧路径再补回来。
        const movedPaths = moves.map((move) => ({
          from: pathFromSiteKey(move.key),
          to: move.target,
        }));
        const migratedFolders = (latest.folders || []).map((item) => {
          if (item === from) return to;
          if (item.startsWith(prefix)) return `${to}/${item.slice(prefix.length)}`;
          return item;
        });
        latest.folders = normalizeFolders(
          migratedFolders,
          movedPaths.map((item) => item.to)
        );
        if (latest.entryPath?.startsWith(prefix)) {
          latest.entryPath = `${to}/${latest.entryPath.slice(prefix.length)}`;
        }
        // 文件清单以 KV 实际内容为准；这里不根据旧 files 路径手工拼新清单。
        await syncProjectFiles(kv, latest);
        return ok({ project: latest });
      }

      if (!extAllowed(from, latest.kind) || !extAllowed(to, latest.kind)) return fail('BAD_REQUEST', 400);
      if (hasFileAncestor(latest, to)
        || (latest.folders || []).includes(to)
        || hasDestinationConflict(latest, to)) {
        return fail('CONFLICT', 409);
      }
      const sourceKey = keys.siteFile(latest.id, from);
      const bytes = await kv.get(sourceKey, { type: 'arrayBuffer' });
      if (!bytes) return fail('NOT_FOUND', 404);
      const targetKey = keys.siteFile(latest.id, to);
      if (await kv.get(targetKey, { type: 'arrayBuffer' })) return fail('CONFLICT', 409);
      await kvPut(kv, targetKey, new Uint8Array(bytes));
      await kvDel(kv, sourceKey);
      if (latest.entryPath === from) latest.entryPath = to;
      await syncProjectFiles(kv, latest);
      return ok({ project: latest });
    });
  }
  if (request.method === 'DELETE') {
    if (!validPath(path) || !extAllowed(path, project.kind)) return fail('BAD_REQUEST', 400);
    return lockedProject(kv, project.id, async (latest) => {
      await kvDel(kv, keys.siteFile(latest.id, path));
      if (latest.entryPath === path) latest.entryPath = null;
      await syncProjectFiles(kv, latest);
      return ok({ project: latest });
    });
  }

  if (request.method === 'POST') {
    if (!validPath(path) || !extAllowed(path, project.kind)) return fail('BAD_REQUEST', 400);
    const content = body?.content;
    if (typeof content !== 'string') return fail('BAD_REQUEST', 400);
    const bytes = base64ToBytes(content);

    // 「读记录 → 校验配额 → 写回」必须串行：并发请求会各自读到旧的 project.size，
    // 都通过校验后一起写，总量就能突破配额（TOCTOU）。锁内重新读一次记录，
    // 保证校验基于最新快照。
    return withLock(`project:${project.id}`, async () => {
      const latest = await kvGet(kv, keys.project(project.id));
      if (!latest) return fail('NOT_FOUND', 404);
      if (hasFileAncestor(latest, path) || (latest.folders || []).includes(path)) {
        return fail('CONFLICT', 409);
      }
      // 配额按项目形态与账号等级取（lib/tiers.js 的 QUOTA 是唯一真相）。
      // 后端项目按 backend 维度算源码包大小，纯前端按 static 维度算。
      const dimension = isBackendKind(normalizeKind(latest.kind)) ? 'backend' : 'static';
      const limit = quotaFor(result.user, dimension);
      if (bytes.length > limit) return fail('TOO_LARGE', 413);

      // 项目总大小上限（覆盖不增加占用）
      const existed = latest.files?.find((f) => f.path === path);
      const existingSize = existed ? existed.size : 0;
      if ((latest.size || 0) - existingSize + bytes.length > limit) {
        return fail('TOO_LARGE', 413);
      }

      await kv.put(keys.siteFile(latest.id, path), bytes);
      addParentFolders(latest, path);
      // 若入口缺失且新增了 html，设为入口
      if (!latest.entryPath && /\.html?$/i.test(path)) {
        latest.entryPath = path;
      }
      latest.status = STATUS.READY;
      await syncProjectFiles(kv, latest);
      return ok({ project: latest });
    });
  }

  return fail('METHOD_NOT_ALLOWED', 405);
}
