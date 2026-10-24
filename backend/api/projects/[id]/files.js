// GET    /api/projects/:id/files?path=... — 读取文件内容（base64，编辑器用）
// POST   /api/projects/:id/files — 创建/覆盖文件（body: { path, content(base64) }）
//        action: remove（删文件）/ createFolder / removeFolder / rename
// DELETE /api/projects/:id/files — 删除文件（body: { path }）
// 说明：项目模式支持 .html / .css / .js；文件夹可显式创建并持久化
import { getOwnedProject, syncProjectFiles, normalizeFolders } from '../../../lib/project.js';
import { isVIPUser } from '../../../lib/session.js';
import { keys, kvDel, kvListAll, pathFromSiteKey, kvPut } from '../../../lib/kv.js';
import { base64ToBytes, bytesToBase64 } from '../../../lib/base64.js';
import { ok, fail } from '../../../lib/responses.js';
import { STATUS, FILE_MAX_BYTES, MAX_TOTAL_BYTES } from '../../../lib/state.js';
import { isValidRelPath } from '../../../lib/paths.js';

// 支持的文件类型（.htm 视同 .html）
const FILE_EXT_RE = /\.(html?|css|js)$/i;

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

export async function onRequest(context) {
  const { request, params } = context;
  const result = await getOwnedProject(context, params?.id);
  if (result.error) return result.error;
  const { project, kv } = result;

  // ---- 读取文件内容（编辑器载入） ----
  if (request.method === 'GET') {
    const path = new URL(request.url).searchParams.get('path') || '';
    // 历史 .php 文件不再暴露，即使磁盘上仍保留也不允许通过编辑器读取。
    if (!validPath(path) || !FILE_EXT_RE.test(path) || /\.php$/i.test(path)) {
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
    if (!validPath(path) || !FILE_EXT_RE.test(path)) return fail('BAD_REQUEST', 400);
    await kvDel(kv, keys.siteFile(project.id, path));
    if (project.entryPath === path) project.entryPath = null;
    await syncProjectFiles(kv, project);
    return ok({ project });
  }

  if (request.method === 'POST' && body?.action === 'createFolder') {
    const folder = body?.path;
    if (!validFolderPath(folder)) return fail('BAD_REQUEST', 400);
    if (isFolderConflict(project, folder) || hasFileAncestor(project, folder)) {
      return fail('CONFLICT', 409);
    }
    project.folders = normalizeFolders(
      [...(project.folders || []), folder],
      project.files?.map((file) => file.path) || []
    );
    await syncProjectFiles(kv, project);
    return ok({ project });
  }

  if (request.method === 'POST' && body?.action === 'removeFolder') {
    const folder = body?.path;
    if (!validFolderPath(folder)) return fail('BAD_REQUEST', 400);
    const prefix = `${folder}/`;
    const fileKeys = await kvListAll(kv, keys.sitePrefix(project.id));
    for (const key of fileKeys) {
      const filePath = pathFromSiteKey(key);
      if (filePath === folder || filePath.startsWith(prefix)) await kvDel(kv, key);
    }
    project.folders = normalizeFolders(
      (project.folders || []).filter((item) => item !== folder && !item.startsWith(prefix)),
      (project.files || []).map((file) => file.path).filter((item) => item !== folder && !item.startsWith(prefix))
    );
    if (project.entryPath === folder || project.entryPath?.startsWith(prefix)) {
      project.entryPath = null;
    }
    await syncProjectFiles(kv, project);
    return ok({ project });
  }

  if (request.method === 'POST' && body?.action === 'rename') {
    const from = body?.from;
    const to = body?.to;
    if (!validPath(from) || !validPath(to) || from === to) return fail('BAD_REQUEST', 400);
    const isFolder = (project.folders || []).includes(from)
      || (project.files || []).some((file) => file.path.startsWith(`${from}/`));
    if (isFolder) {
      if (to.startsWith(`${from}/`)) return fail('BAD_REQUEST', 400);
      if (hasFileAncestor(project, to) || hasDestinationConflict(project, to, from)) {
        return fail('CONFLICT', 409);
      }
      const prefix = `${from}/`;
      const fileKeys = await kvListAll(kv, keys.sitePrefix(project.id));
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
        await kvPut(kv, keys.siteFile(project.id, move.target), move.bytes);
        await kvDel(kv, move.key);
      }
      // 所有被移动文件的最终路径。syncProjectFiles 会按 KV 实际内容重建 files，
      // 但 folders 必须在这里按同一份路径表迁移，不能用旧路径再补回来。
      const movedPaths = moves.map((move) => ({
        from: pathFromSiteKey(move.key),
        to: move.target,
      }));
      const migratedFolders = (project.folders || []).map((item) => {
        if (item === from) return to;
        if (item.startsWith(prefix)) return `${to}/${item.slice(prefix.length)}`;
        return item;
      });
      project.folders = normalizeFolders(
        migratedFolders,
        movedPaths.map((item) => item.to)
      );
      if (project.entryPath?.startsWith(prefix)) {
        project.entryPath = `${to}/${project.entryPath.slice(prefix.length)}`;
      }
      // 文件清单以 KV 实际内容为准；这里不根据旧 files 路径手工拼新清单。
      await syncProjectFiles(kv, project);
      return ok({ project });
    }

    if (!FILE_EXT_RE.test(from) || !FILE_EXT_RE.test(to)) return fail('BAD_REQUEST', 400);
    if (hasFileAncestor(project, to)
      || (project.folders || []).includes(to)
      || hasDestinationConflict(project, to)) {
      return fail('CONFLICT', 409);
    }
    const sourceKey = keys.siteFile(project.id, from);
    const bytes = await kv.get(sourceKey, { type: 'arrayBuffer' });
    if (!bytes) return fail('NOT_FOUND', 404);
    const targetKey = keys.siteFile(project.id, to);
    if (await kv.get(targetKey, { type: 'arrayBuffer' })) return fail('CONFLICT', 409);
    await kvPut(kv, targetKey, new Uint8Array(bytes));
    await kvDel(kv, sourceKey);
    if (project.entryPath === from) project.entryPath = to;
    await syncProjectFiles(kv, project);
    return ok({ project });
  }
  if (request.method === 'DELETE') {
    if (!validPath(path) || !FILE_EXT_RE.test(path)) return fail('BAD_REQUEST', 400);
    await kvDel(kv, keys.siteFile(project.id, path));
    if (project.entryPath === path) project.entryPath = null;
    await syncProjectFiles(kv, project);
    return ok({ project });
  }

  if (request.method === 'POST') {
    if (!validPath(path) || !FILE_EXT_RE.test(path)) return fail('BAD_REQUEST', 400);
    if (hasFileAncestor(project, path) || (project.folders || []).includes(path)) {
      return fail('CONFLICT', 409);
    }
    const content = body?.content;
    if (typeof content !== 'string') return fail('BAD_REQUEST', 400);
    const bytes = base64ToBytes(content);
    // VIP 用户（后台创建）可绕过单文件/项目总大小上限
    if (!isVIPUser(result.user) && bytes.length > FILE_MAX_BYTES) return fail('TOO_LARGE', 413);

    // 项目总大小上限（覆盖不增加占用；与上传管线 5MB 保持一致）
    const existed = project.files?.find((f) => f.path === path);
    const existingSize = existed ? existed.size : 0;
    if (!isVIPUser(result.user)
      && (project.size || 0) - existingSize + bytes.length > MAX_TOTAL_BYTES) {
      return fail('TOO_LARGE', 413);
    }

    await kv.put(keys.siteFile(project.id, path), bytes);
    addParentFolders(project, path);
    // 若入口缺失且新增了 html，设为入口
    if (!project.entryPath && /\.html?$/i.test(path)) {
      project.entryPath = path;
    }
    project.status = STATUS.READY;
    await syncProjectFiles(kv, project);
    return ok({ project });
  }

  return fail('METHOD_NOT_ALLOWED', 405);
}
