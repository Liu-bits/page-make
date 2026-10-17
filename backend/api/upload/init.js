// POST /api/upload/init — 初始化分片上传
// body: { provider, files: [{ name, size }] }
import { requireAuth } from '../../lib/session.js';
import { getKV, kvPut, kvGet, kvDel, kvListAll, keys, nowSeconds, appendLog } from '../../lib/kv.js';
import { ok, fail } from '../../lib/responses.js';
import { PROVIDERS, MAX_TOTAL_BYTES, CHUNK_BYTES, UPLOAD_TTL_SECONDS } from '../../lib/state.js';

// 顺带清理过期上传任务（用户取消/中断后的残留，防止 KV/磁盘无限增长）
async function cleanupStaleUploads(kv) {
  try {
    const uploadKeys = await kvListAll(kv, 'upload_');
    for (const key of uploadKeys) {
      const upload = await kvGet(kv, key);
      if (!upload || nowSeconds() - (upload.createdAt || 0) <= UPLOAD_TTL_SECONDS) continue;
      const tmpKeys = await kvListAll(kv, keys.uploadChunkPrefix(upload.uploadId));
      for (const tmpKey of tmpKeys) await kvDel(kv, tmpKey);
      await kvDel(kv, key);
    }
  } catch {
    // 清理失败不影响主流程
  }
}

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

  // 游客（免登录兜底）最多创建 1 个网页
  if (auth.user.userId.startsWith('guest_')) {
    const existing = await kvListAll(auth.kv, keys.userProject(auth.user.userId, ''));
    if (existing.length >= 1) return fail('GUEST_LIMIT', 403);
  }

  // 单线路部署：provider 可省略，默认 local（非法值仍拒绝）
  const provider = body?.provider || 'local';
  if (!PROVIDERS.has(provider)) return fail('INVALID_PROVIDER', 400);

  const files = Array.isArray(body?.files) ? body.files : [];
  if (!files.length) return fail('BAD_REQUEST', 400);

  let total = 0;
  for (const file of files) {
    if (!file?.name || typeof file.size !== 'number' || file.size < 0) {
      return fail('BAD_REQUEST', 400);
    }
    total += file.size;
  }
  if (total > MAX_TOTAL_BYTES) return fail('TOO_LARGE', 413);

  // 清理过期上传（轻量扫描，小规模下开销可忽略）
  await cleanupStaleUploads(auth.kv);

  const uploadId = crypto.randomUUID().replace(/-/g, '');
  const kv = auth.kv;
  await kvPut(kv, keys.upload(uploadId), {
    uploadId,
    userId: auth.user.userId,
    provider,
    files: files.map((f) => ({ name: String(f.name).split('/').pop(), size: f.size })),
    createdAt: nowSeconds(),
  });
  await appendLog(kv, { step: 'upload_init', result: 'ok' });
  return ok({ uploadId, chunkSize: CHUNK_BYTES });
}
