// GET /api/projects/:id/export — 导出项目为 ZIP（备份）
//
// 定位：用户对自己上传的内容有掌控权。项目数据平时只存在服务端，
// 一旦误删或想迁走就没有出口；这个接口把源码原样打回本地。
//
// 权限：VIP 及以上（与「后端项目」同档，属于付费权益）。
// 不导出 node_modules / .git 之类安装产物，只导出用户自己的源码。
import { getOwnedProject, readSiteFiles } from '../../../lib/project.js';
import { fail } from '../../../lib/responses.js';
import { buildZip } from '../../../lib/zipwrite.js';
import { canUseBackend } from '../../../lib/tiers.js';

/** 安装产物与版本控制目录不参与导出 */
function isExportable(path) {
  const segments = path.split('/');
  if (segments.some((s) => s === 'node_modules' || s === '.git' || s === '.pnpm-store')) return false;
  return true;
}

/** 文件名去掉路径分隔符与 Windows 非法字符，避免 Content-Disposition 被污染 */
function safeFileName(name) {
  const cleaned = String(name || 'project')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .trim()
    .slice(0, 60);
  return cleaned || 'project';
}

export async function onRequest(context) {
  const { request, params } = context;
  const result = await getOwnedProject(context, params?.id);
  if (result.error) return result.error;
  const { project, kv, user } = result;

  if (request.method !== 'GET') return fail('METHOD_NOT_ALLOWED', 405);
  if (!canUseBackend(user)) return fail('EXPORT_REQUIRES_VIP', 403);

  const files = await readSiteFiles(kv, project.id);
  if (files.size === 0) return fail('NO_ENTRY', 400);

  const entries = [];
  for (const [path, bytes] of files) {
    if (!isExportable(path)) continue;
    entries.push({ path, data: bytes });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));

  const zip = buildZip(entries);
  const fileName = `${safeFileName(project.name)}.zip`;
  // RFC 5987：中文文件名必须走 filename*，否则部分客户端会乱码或截断
  const encoded = encodeURIComponent(fileName);

  return new Response(zip, {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Length': String(zip.length),
      'Content-Disposition': `attachment; filename="project.zip"; filename*=UTF-8''${encoded}`,
      'Cache-Control': 'no-store',
    },
  });
}
