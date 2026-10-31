// POST /api/upload/init — 初始化分片上传
// body: { provider, files: [{ name, size }], name? }
import { requireAuth, isGuestLimited } from '../../lib/session.js';
import { getKV, kvPut, kvGet, kvDel, kvListAll, keys, nowSeconds, appendLog } from '../../lib/kv.js';
import { ok, fail } from '../../lib/responses.js';
import {
  PROVIDERS, CHUNK_BYTES, UPLOAD_TTL_SECONDS,
  PROJECT_KIND, normalizeKind, isBackendKind, ZIP_MAX_ENTRIES,
} from '../../lib/state.js';
import { quotaFor, canUseBackend, tierOf } from '../../lib/tiers.js';

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
  if (isGuestLimited(auth.user)) {
    const existing = await kvListAll(auth.kv, keys.userProject(auth.user.userId, ''));
    if (existing.length >= 1) return fail('GUEST_LIMIT', 403);
  }

  // 单线路部署：provider 可省略，默认 local（非法值仍拒绝）
  const provider = body?.provider || 'local';
  if (!PROVIDERS.has(provider)) return fail('INVALID_PROVIDER', 400);

  // 部署形态三选一：纯前端 / npm / pnpm。非法值直接拒绝（不能静默降级，
  // 否则用户以为建了后端项目，实际拿到的是静态站点）。
  const requestedKind = body?.kind;
  if (requestedKind !== undefined && !['static', PROJECT_KIND.NPM, PROJECT_KIND.PNPM].includes(requestedKind)) {
    return fail('INVALID_KIND', 400);
  }
  const kind = normalizeKind(requestedKind);
  // 后端形态是 VIP 起的特权：普通用户只能选纯前端
  if (isBackendKind(kind) && !canUseBackend(auth.user)) {
    return fail('BACKEND_REQUIRES_VIP', 403);
  }

  const files = Array.isArray(body?.files) ? body.files : [];
  if (!files.length) return fail('BAD_REQUEST', 400);
  if (files.length > ZIP_MAX_ENTRIES) return fail('TOO_LARGE', 413);
  const projectName =
    (typeof body?.name === 'string' && body.name.trim().slice(0, 60)) || '未命名项目';

  let total = 0;
  for (const file of files) {
    if (!file?.name || !Number.isSafeInteger(file.size) || file.size < 0) {
      return fail('BAD_REQUEST', 400);
    }
    total += file.size;
    if (!Number.isSafeInteger(total)) return fail('TOO_LARGE', 413);
  }
  // 配额按等级取：静态项目与后端源码包分别计算（见 lib/tiers.js 的 QUOTA）
  const limit = quotaFor(auth.user, isBackendKind(kind) ? 'backend' : 'static');
  if (total > limit) return fail('TOO_LARGE', 413);

  // 清理过期上传（轻量扫描，小规模下开销可忽略）
  await cleanupStaleUploads(auth.kv);

  const uploadId = crypto.randomUUID().replace(/-/g, '');
  const kv = auth.kv;
  await kvPut(kv, keys.upload(uploadId), {
    uploadId,
    userId: auth.user.userId,
    provider,
    kind,
    tier: tierOf(auth.user),
    projectName,
    files: files.map((f) => ({ name: String(f.name).split('/').pop(), size: f.size })),
    createdAt: nowSeconds(),
  });
  await appendLog(kv, { step: 'upload_init', result: 'ok' });
  return ok({ uploadId, chunkSize: CHUNK_BYTES });
}
