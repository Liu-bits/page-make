// GET /api/projects/:id — 项目详情
// POST /api/projects/:id — action: delete（删除）/ rename（重命名）/ publish（生成公开链接）
// DELETE /api/projects/:id — 删除项目（兼容；ModelScope 网关拦截 DELETE，客户端走 POST）
import { getOwnedProject, deleteProjectRecords, syncProjectFiles, readSiteFiles, projectPublicUrl } from '../../lib/project.js';
import { ok, fail } from '../../lib/responses.js';
import { appendLog } from '../../lib/kv.js';
import { STATUS } from '../../lib/state.js';
import { analyzeHtml } from '../../lib/diagnostics.js';

export async function onRequest(context) {
  const { request, params } = context;
  const result = await getOwnedProject(context, params?.id);
  if (result.error) return result.error;
  const { project, kv, user } = result;

  if (request.method === 'GET') {
    return ok({ project });
  }

  // POST + action 支持（网关拦截 DELETE）
  let action = request.method === 'DELETE' ? 'delete' : null;
  let body = null;
  if (request.method === 'POST') {
    try {
      body = await request.json();
      action = body?.action || null;
    } catch {
      action = null;
    }
  }

  if (action === 'delete') {
    await deleteProjectRecords(kv, user.userId, project.id);
    await appendLog(kv, { projectId: project.id, step: 'delete_project', result: 'ok' });
    return ok({ deleted: true });
  }

  if (action === 'rename') {
    const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 60) : '';
    if (!name) return fail('BAD_REQUEST', 400);
    project.name = name;
    await syncProjectFiles(kv, project);
    await appendLog(kv, { projectId: project.id, step: 'rename_project', result: 'ok' });
    return ok({ project });
  }

  // 项目模式：统一生成公开链接（至少需要一个 HTML 文件作为入口）
  if (action === 'publish') {
    const files = await readSiteFiles(kv, project.id);
    if (files.size === 0) return fail('NO_ENTRY', 400);

    // 入口选择：沿用已设入口 → index.html → 字典序第一个 .html
    let entry =
      project.entryPath && files.has(project.entryPath) ? project.entryPath : null;
    if (!entry) {
      if (files.has('index.html')) {
        entry = 'index.html';
      } else {
        const htmlPaths = [...files.keys()].filter((p) => /\.html?$/i.test(p)).sort();
        entry = htmlPaths[0] || null;
      }
    }
    if (!entry) return fail('NO_ENTRY', 400);

    // 静态诊断（与上传/粘贴流程一致）
    const html = new TextDecoder().decode(files.get(entry));
    project.diagnostics = analyzeHtml(html, files);
    project.entryPath = entry;
    project.status = STATUS.READY;
    project.url = projectPublicUrl(new URL(request.url).origin, project.id);
    await syncProjectFiles(kv, project);
    await appendLog(kv, { projectId: project.id, step: 'publish', result: 'ok' });
    return ok({ project });
  }

  return fail('METHOD_NOT_ALLOWED', 405);
}
