// POST /api/upload/chunk — 上传单个分片
// body: { uploadId, fileIndex, chunkIndex, data(base64) }
// 注：EdgeOne Functions 单请求 body 上限 1MB，单片 600KB（base64 后约 800KB）
import { requireAuth } from '../../lib/session.js';
import { kvGet, kvPut, keys } from '../../lib/kv.js';
import { base64ToBytes } from '../../lib/base64.js';
import { ok, fail } from '../../lib/responses.js';
import { CHUNK_BYTES } from '../../lib/state.js';

const UPLOAD_ID_RE = /^[a-f0-9]{32}$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

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
  const { uploadId, fileIndex, chunkIndex, data } = body || {};

  if (!UPLOAD_ID_RE.test(uploadId)) return fail('NOT_FOUND', 404);
  if (!Number.isInteger(fileIndex) || fileIndex < 0) return fail('BAD_REQUEST', 400);
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0) return fail('BAD_REQUEST', 400);
  if (typeof data !== 'string' || !BASE64_RE.test(data)) return fail('BAD_REQUEST', 400);

  const upload = await kvGet(auth.kv, keys.upload(uploadId));
  if (!upload || upload.userId !== auth.user.userId) return fail('NOT_FOUND', 404);
  if (fileIndex >= upload.files.length) return fail('BAD_REQUEST', 400);

  const fileSize = upload.files[fileIndex].size;
  const expectedChunks = Math.max(1, Math.ceil(fileSize / CHUNK_BYTES));
  if (chunkIndex >= expectedChunks) return fail('BAD_REQUEST', 400);

  const bytes = base64ToBytes(data);
  // 非最后一片必须满片
  if (chunkIndex < expectedChunks - 1 && bytes.length !== CHUNK_BYTES) {
    return fail('BAD_REQUEST', 400);
  }
  if (chunkIndex === expectedChunks - 1) {
    const remainder = fileSize - chunkIndex * CHUNK_BYTES;
    if (bytes.length !== remainder) return fail('BAD_REQUEST', 400);
  }

  await kvPut(auth.kv, keys.uploadChunk(uploadId, fileIndex, chunkIndex), bytes);
  return ok({ received: true });
}
