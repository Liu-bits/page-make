// DELETE /api/upload/:uploadId — 取消上传，清理临时分片
// iOS 取消上传时调用，防止中断/放弃的上传任务残留（KV/磁盘无限增长）
import { requireAuth } from '../../lib/session.js';
import { kvGet, kvDel, kvListAll, keys } from '../../lib/kv.js';
import { ok, fail } from '../../lib/responses.js';

const UPLOAD_ID_RE = /^[a-f0-9]{32}$/;

export async function onRequest(context) {
  const { request, params } = context;
  const auth = await requireAuth(context);
  if (auth.error) return auth.error;
  // ModelScope 网关拦截 DELETE 方法 → 同时支持 POST + { action: 'cancel' }
  let cancelIntent = request.method === 'DELETE';
  if (request.method === 'POST') {
    try {
      const body = await request.json();
      cancelIntent = body?.action === 'cancel';
    } catch {
      cancelIntent = false;
    }
  }
  if (!cancelIntent) return fail('METHOD_NOT_ALLOWED', 405);

  const uploadId = params?.uploadId;
  if (!UPLOAD_ID_RE.test(uploadId)) return fail('NOT_FOUND', 404);

  const upload = await kvGet(auth.kv, keys.upload(uploadId));
  if (!upload || upload.userId !== auth.user.userId) return fail('NOT_FOUND', 404);

  // 清理临时分片（tmp_<uploadId>_*，key 经 encodeKey 编码）与上传记录
  const tmpKeys = await kvListAll(auth.kv, keys.uploadChunkPrefix(uploadId));
  for (const key of tmpKeys) await kvDel(auth.kv, key);
  await kvDel(auth.kv, keys.upload(uploadId));
  return ok({ canceled: true });
}
