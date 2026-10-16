// POST /api/upload/init — 初始化分片上传
// body: { provider, files: [{ name, size }] }
import { requireAuth } from '../../lib/session.js';
import { getKV, kvPut, keys, nowSeconds, appendLog } from '../../lib/kv.js';
import { ok, fail } from '../../lib/responses.js';
import { PROVIDERS, MAX_TOTAL_BYTES, CHUNK_BYTES } from '../../lib/state.js';

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

  // 每次创建必须选线路：缺失或非法 → 400 INVALID_PROVIDER
  const provider = body?.provider;
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
