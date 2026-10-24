// GET    /api/projects/:id/files?path=... — 读取文件内容（base64，编辑器用）
// POST   /api/projects/:id/files — 创建/覆盖文件（body: { path, content(base64) }）
// DELETE /api/projects/:id/files — 删除文件（body: { path }）
// 说明：项目模式支持 .html / .css / .js；路径可带子文件夹（虚拟文件夹，如 css/style.css）
import { getOwnedProject, syncProjectFiles } from '../../../lib/project.js';
import { isTestUser } from '../../../lib/session.js';
import { keys, kvDel } from '../../../lib/kv.js';
import { base64ToBytes, bytesToBase64 } from '../../../lib/base64.js';
import { ok, fail } from '../../../lib/responses.js';
import { STATUS, FILE_MAX_BYTES, MAX_TOTAL_BYTES } from '../../../lib/state.js';

// 支持的文件类型（.htm 视同 .html）
const FILE_EXT_RE = /\.(html?|css|js)$/i;

// 路径安全：禁止 ..、反斜杠、控制字符、首尾斜杠、超长
function validPath(path) {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    path.length <= 200 &&
    !path.includes('..') &&
    !path.includes('\\') &&
    !path.startsWith('/') &&
    !path.endsWith('/') &&
    !/[\u0000-\u001f]/.test(path)
  );
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
  if (!validPath(path) || !FILE_EXT_RE.test(path)) return fail('BAD_REQUEST', 400);

  if (request.method === 'POST' && body?.action === 'remove') {
    await kvDel(kv, keys.siteFile(project.id, path));
    if (project.entryPath === path) project.entryPath = null;
    await syncProjectFiles(kv, project);
    return ok({ project });
  }
  if (request.method === 'DELETE') {
    await kvDel(kv, keys.siteFile(project.id, path));
    if (project.entryPath === path) project.entryPath = null;
    await syncProjectFiles(kv, project);
    return ok({ project });
  }

  if (request.method === 'POST') {
    const content = body?.content;
    if (typeof content !== 'string') return fail('BAD_REQUEST', 400);
    const bytes = base64ToBytes(content);
    // 测试账号（后台创建）权益最高：绕过单文件/项目总大小上限
    if (!isTestUser(result.user) && bytes.length > FILE_MAX_BYTES) return fail('TOO_LARGE', 413);

    // 项目总大小上限（覆盖不增加占用；与上传管线 5MB 保持一致）
    const existed = project.files?.find((f) => f.path === path);
    const existingSize = existed ? existed.size : 0;
    if (!isTestUser(result.user)
      && (project.size || 0) - existingSize + bytes.length > MAX_TOTAL_BYTES) {
      return fail('TOO_LARGE', 413);
    }

    await kv.put(keys.siteFile(project.id, path), bytes);
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
