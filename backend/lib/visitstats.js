// 站点访问计数：内存聚合 + 定期落 KV。
//
// 为什么不每次公开页访问都写 KV：/p/<id> 是匿名高频入口，逐次写会把 KV 操作
// 无限放大；且统计若挂在项目记录（keys.project）上，会与业务锁（project:<id>）
// 争抢临界区。所以统计独立成 key（stat_<projectId>），内存聚合、单写者落盘。
//
// 数据形状（stat_<projectId> 记录）：
//   { total, days: { 'YYYY-MM-DD': n }, updatedAt }
// days 只保留最近 KEEP_DAYS 天明细（落盘时剪枝）；不记 IP / UA，纯聚合计数。
//
// 一致性边界：
// - 读侧（read）合并「KV 已落盘 + 内存未落盘增量」，App 看到的数字实时；
// - flush 期间新产生的 hit 进入下一轮聚合，不丢也不重复；
// - 项目删除时 deleteProjectGuarded 同步删掉 stat_ key，不留孤儿统计。

import { kvGet, kvPut, keys, nowSeconds } from './kv.js';
import { withLock } from './lock.js';

const KEEP_DAYS = 7;

/** projectId → { total, days: Map<'YYYY-MM-DD', number> }（未落盘的增量） */
const pending = new Map();

/** 本地日期键（容器时区）；统计粒度是「天」，跨时区偏差可接受 */
function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  const pad = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 记一次访问（公开入口页命中时调用；只在内存 +1，O(1) 不碰 KV） */
export function hit(projectId) {
  if (!projectId) return;
  const entry = pending.get(projectId) || { total: 0, days: new Map() };
  entry.total += 1;
  const day = dayKey();
  entry.days.set(day, (entry.days.get(day) || 0) + 1);
  pending.set(projectId, entry);
}

/** 剪掉超出保留窗口的日期明细 */
function pruneDays(days) {
  const cutoff = dayKey(Date.now() - KEEP_DAYS * 24 * 3600 * 1000);
  for (const key of Object.keys(days)) {
    if (key < cutoff) delete days[key];
  }
}

/**
 * 把内存增量合并进 KV 并清空内存（server.mjs 定时调用）。
 * @returns {Promise<{flushed:number}>} 实际落盘的项目数
 */
export async function flush(kv) {
  if (!pending.size) return { flushed: 0 };
  const entries = [...pending.entries()];
  pending.clear();
  let flushed = 0;
  for (const [projectId, delta] of entries) {
    try {
      await withLock(`stat:${projectId}`, async () => {
        const record = (await kvGet(kv, keys.visitStats(projectId)))
          || { total: 0, days: {} };
        record.total += delta.total;
        for (const [day, count] of delta.days) {
          record.days[day] = (record.days[day] || 0) + count;
        }
        pruneDays(record.days);
        record.updatedAt = nowSeconds();
        await kvPut(kv, keys.visitStats(projectId), record);
        flushed += 1;
      });
    } catch {
      // 单项目落盘失败不影响其他项目；本轮增量已摘出，下次访问会重新累积
    }
  }
  return { flushed };
}

/**
 * 读合并视图（KV 已落盘 + 内存未落盘增量），App 侧展示用。
 * @returns {Promise<{total:number, today:number, days:Object<string, number>}>}
 */
export async function read(kv, projectId) {
  const record = (await kvGet(kv, keys.visitStats(projectId)))
    || { total: 0, days: {} };
  const days = { ...record.days };
  let total = record.total;
  const delta = pending.get(projectId);
  if (delta) {
    total += delta.total;
    for (const [day, count] of delta.days) {
      days[day] = (days[day] || 0) + count;
    }
  }
  const today = days[dayKey()] || 0;
  return { total, today, days };
}
