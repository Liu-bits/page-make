// 过期数据回收
//
// 背景：会话（session_ / usession_ / admin_session_）和操作日志（log_）的 TTL
// 只写在记录字段里，此前没有任何执行者——过期记录永远留在持久卷上，
// KV 单调增长，kvListAll 的全表扫描（撤销会话、清理上传任务）越来越慢。
//
// 这里提供一次性清理，由 server.mjs 在启动后延迟执行 + 定时重复执行。

import { kvListAll, kvGet, kvDel, nowSeconds } from './kv.js';

/** 操作日志保留 30 天（留证够用，又不至于无限增长） */
export const LOG_RETENTION_SECONDS = 30 * 24 * 3600;

async function sweepPrefix(kv, prefix, isStale) {
  let removed = 0;
  const keys = await kvListAll(kv, prefix);
  for (const key of keys) {
    let record = null;
    try {
      record = await kvGet(kv, key);
    } catch {
      // 读失败（半截 JSON 等）也当作坏数据清掉
    }
    if (isStale(record)) {
      await kvDel(kv, key);
      removed += 1;
    }
  }
  return removed;
}

/**
 * 清理过期会话与超期日志。
 * @param {object} kv
 * @param {{logRetentionSeconds?: number}} options
 * @returns {Promise<{sessions:number, adminSessions:number, logs:number}>}
 */
export async function cleanupExpired(kv, options = {}) {
  const now = nowSeconds();
  const logTtl = Number(options.logRetentionSeconds) > 0
    ? Number(options.logRetentionSeconds)
    : LOG_RETENTION_SECONDS;

  const expiredSession = (record) => !record || !record.expiresAt || record.expiresAt < now;

  const sessions = await sweepPrefix(kv, 'session_', expiredSession)
    + await sweepPrefix(kv, 'usession_', expiredSession);
  const adminSessions = await sweepPrefix(kv, 'admin_session_', expiredSession);
  const logs = await sweepPrefix(kv, 'log_', (record) => (
    !record || !record.createdAt || now - record.createdAt > logTtl
  ));

  return { sessions, adminSessions, logs };
}
