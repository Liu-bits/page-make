// GET  /api/projects/:id/snapshot — 快照信息（无快照返回 null）
// POST /api/projects/:id/snapshot — { action: 'create' | 'restore' | 'delete' }
// 每项目一份快照（备份当前版本），创建覆盖旧快照，恢复即回滚到备份点。
// 容量成本 = 全站文件副本，因此仅 VIP 及以上可用；文件数/总量按等级配额封顶。
// 全部操作在项目锁内进行：与文件编辑 / 发布 / 删除并发互斥（TOCTOU 纪律）。
import { getOwnedProject, readSiteFiles, syncProjectFiles } from '../../../lib/project.js';
import { ok, fail } from '../../../lib/responses.js';
import { kvGet, kvDel, kvListAll, kvPut, keys } from '../../../lib/kv.js';
import { withLock } from '../../../lib/lock.js';
import { atLeast, quotaFor } from '../../../lib/tiers.js';
import { findEntry } from '../../../lib/diagnostics.js';
import { isBackendKind, normalizeKind, STATUS } from '../../../lib/state.js';
import { decodeKey } from '../../../lib/base64.js';

const SNAPSHOT_MAX_FILES = 300;

export async function onRequest(context) {
  const { request } = context;
  const result = await getOwnedProject(context, context.params?.id);
  if (result.error) return result.error;
  const { project, kv, user } = result;
  const id = project.id;

  if (request.method === 'GET') {
    const meta = await kvGet(kv, keys.snapshotMeta(id));
    return ok({ snapshot: meta ?? null });
  }

  if (request.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 405);
  // 容量成本是全站文件副本，仅 VIP 及以上（游客 / 普通账号的配额本来就小）
  if (!atLeast(user, 'vip')) return fail('SNAPSHOT_REQUIRES_VIP', 403);

  let body;
  try {
    body = await request.json();
  } catch {
    return fail('BAD_REQUEST', 400);
  }

  if (body?.action === 'create') {
    const files = await readSiteFiles(kv, id);
    if (files.size === 0) return fail('NO_ENTRY', 400);
    if (files.size > SNAPSHOT_MAX_FILES) return fail('SNAPSHOT_TOO_MANY_FILES', 400);
    const dimension = isBackendKind(normalizeKind(project.kind)) ? 'backend' : 'static';
    const total = [...files.values()].reduce((sum, data) => sum + data.length, 0);
    if (total > quotaFor(user, dimension)) return fail('TOO_LARGE', 413);
    const entryPath = project.entryPath && files.has(project.entryPath) ? project.entryPath : null;

    return withLock(`project:${id}`, async () => {
      // 每项目只有一份快照：创建即覆盖旧快照（先清文件再写新的）
      for (const key of await kvListAll(kv, keys.snapshotFilePrefix(id))) await kvDel(kv, key);
      for (const [path, data] of files) {
        await kvPut(kv, keys.snapshotFile(id, path), data);
      }
      await kvPut(kv, keys.snapshotMeta(id), {
        projectId: id,
        entryPath,
        fileCount: files.size,
        size: total,
        createdAt: Math.floor(Date.now() / 1000),
      });
      return ok({ created: true, fileCount: files.size, size: total });
    });
  }

  if (body?.action === 'restore') {
    const meta = await kvGet(kv, keys.snapshotMeta(id));
    if (!meta) return fail('NOT_FOUND', 404);

    return withLock(`project:${id}`, async () => {
      const filePrefix = keys.snapshotFilePrefix(id);
      const snapKeys = await kvListAll(kv, filePrefix);
      if (!snapKeys.length) return fail('NOT_FOUND', 404);

      // 还原文件：key 尾段是 encodeKey(path)，需 decodeKey 还原
      const restored = new Map();
      for (const key of snapKeys) {
        const path = decodeKey(key.slice(filePrefix.length));
        const bytes = await kv.get(key, { type: 'arrayBuffer' });
        if (bytes) restored.set(path, new Uint8Array(bytes));
      }
      // 换血：删现网全部文件 → 从快照写回
      for (const key of await kvListAll(kv, keys.sitePrefix(id))) await kvDel(kv, key);
      for (const [path, bytes] of restored) {
        await kv.put(keys.siteFile(id, path), bytes);
      }
      // 入口在快照里丢失则重新选第一个 HTML
      const entry = meta.entryPath && restored.has(meta.entryPath)
        ? meta.entryPath
        : findEntry(restored);
      const record = await kvGet(kv, keys.project(id));
      if (!record) return ok({ restored: restored.size });
      await syncProjectFiles(kv, record, {
        entryPath: entry ?? null,
        status: STATUS.READY,
        errorCode: null,
      });
      return ok({ restored: restored.size, entryPath: entry ?? null });
    });
  }

  if (body?.action === 'delete') {
    return withLock(`project:${id}`, async () => {
      for (const key of await kvListAll(kv, keys.snapshotFilePrefix(id))) await kvDel(kv, key);
      await kvDel(kv, keys.snapshotMeta(id));
      return ok({ deleted: true });
    });
  }

  return fail('BAD_REQUEST', 400);
}
