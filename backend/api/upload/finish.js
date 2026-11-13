// POST /api/upload/finish — 完成上传，触发后台处理
// 立即返回 { projectId, status: 'processing' }，iOS 每 2 秒轮询 /api/projects/:id/status
import { requireAuth } from '../../lib/session.js';
import { kvGet, kvPut, keys, nowSeconds } from '../../lib/kv.js';
import { processUpload } from '../../lib/process.js';
import { withLock } from '../../lib/lock.js';
import { ok, fail } from '../../lib/responses.js';
import { STATUS, CHUNK_BYTES } from '../../lib/state.js';

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

  // 「读 upload → 判 consumed → 分片预检 → 标记 consumed」必须是一段临界区。
  // 不加锁时两个并发 finish 都会读到 status=uploading 的旧快照、都通过预检、
  // 各自 kvPut 一次 consumed 并各自生成一个项目（配额绕过 + 重复部署）。
  // KV 无原子 CAS，只能靠进程内锁串行（本后端是单进程 Node 服务）。
  return withLock(`upload:${uploadId}`, async () => {
    const upload = await kvGet(auth.kv, keys.upload(uploadId));
    if (!upload || upload.userId !== auth.user.userId) return fail('NOT_FOUND', 404);

    // 一个上传任务只能消费一次。否则同一份分片可以反复 finish，每次生成一个新
    // 项目（配额绕过），失败时 upload 记录还会被刻意保留（process.js），
    // 可以无限刷失败项目记录、并让后台对缺失分片反复重试。
    if (upload.status === 'consumed') {
      return fail('CONFLICT', 409, {
        projectId: upload.projectId || null,
        message: 'UPLOAD_ALREADY_CONSUMED',
      });
    }

    // 分片齐全性预检：缺片直接拒绝，不要丢给后台管线（那里对每个缺失分片
    // 要重试 12 次、每次约 1 分钟，等于白烧 CPU/IO）。
    const files = Array.isArray(upload.files) ? upload.files : [];
    for (let fi = 0; fi < files.length; fi++) {
      const size = Number(files[fi]?.size) || 0;
      const chunkCount = Math.max(1, Math.ceil(size / CHUNK_BYTES));
      const last = await auth.kv.get(keys.uploadChunk(uploadId, fi, chunkCount - 1), { type: 'arrayBuffer' });
      if (!last) return fail('BAD_REQUEST', 400, { message: 'CHUNKS_INCOMPLETE' });
    }

    const projectId = crypto.randomUUID().replace(/-/g, '');
    const origin = new URL(request.url).origin;

    // 先标记消费，再启动管线：失败路径保留分片（便于排查/重传），
    // 但记录已消费，不能再被 finish 一次。
    upload.status = 'consumed';
    upload.consumedAt = nowSeconds();
    upload.projectId = projectId;
    await kvPut(auth.kv, keys.upload(uploadId), upload);

    // 先落一条 processing 记录：状态轮询立即可用（边缘版与容器版都受益）
    await kvPut(auth.kv, keys.project(projectId), {
      id: projectId,
      userId: auth.user.userId,
      provider: upload.provider,
      status: STATUS.PROCESSING,
      createdAt: nowSeconds(),
      diagnostics: [],
      runtimeErrors: [],
      files: [],
    });

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
  });
}
