// POST /api/upload/finish — 完成上传，触发后台处理
// 立即返回 { projectId, status: 'processing' }，iOS 每 2 秒轮询 /api/projects/:id/status
import { requireAuth } from '../lib/session.js';
import { kvGet, keys } from '../lib/kv.js';
import { processUpload } from '../lib/process.js';
import { ok, fail } from '../lib/responses.js';
import { STATUS } from '../lib/state.js';

const UPLOAD_ID_RE = /^[a-f0-9]{32}$/;

export async function onRequest(context) {
  const { request } = context;
  const auth = await requireAuth(context);
  if (auth.error) return auth.error;
  if (request.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 405);

  let body;
  try {
    body = await request.json();
  } catch {
    return fail('BAD_REQUEST', 400);
  }
  const uploadId = body?.uploadId;
  if (!UPLOAD_ID_RE.test(uploadId)) return fail('NOT_FOUND', 404);

  const upload = await kvGet(auth.kv, keys.upload(uploadId));
  if (!upload || upload.userId !== auth.user.userId) return fail('NOT_FOUND', 404);

  const projectId = crypto.randomUUID().replace(/-/g, '');
  const origin = new URL(request.url).origin;

  const task = processUpload({ kv: auth.kv, upload, projectId, origin, env: context.env })
    .catch(() => {
      // 失败状态已由 processUpload 写入 projects，这里不再向上抛
    });

  if (typeof context.waitUntil === 'function') {
    context.waitUntil(task);
  } else {
    await task;
  }

  return ok({ projectId, status: STATUS.PROCESSING });
}
