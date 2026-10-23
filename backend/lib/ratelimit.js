// 进程内滑动窗口限流（按 IP）
// 用途：防止未登录接口（反馈/举报、管理员登录）被脚本刷量打满 KV 或暴力试探
// 说明：内存计数，容器重启即清零——对免费空间的防刷已足够，且零外部依赖
const buckets = new Map();

/**
 * 记录一次请求并判断是否超限
 * @param {string} key   限流键（通常是 IP）
 * @param {number} limit 窗口内允许的次数
 * @param {number} windowMs 窗口大小（毫秒）
 * @returns {boolean} true = 已超限，应拒绝
 */
export function rateLimited(key, limit, windowMs) {
  const now = Date.now();
  const windowStart = now - windowMs;
  const hits = (buckets.get(key) || []).filter((t) => t > windowStart);
  hits.push(now);
  buckets.set(key, hits);
  if (hits.length > limit) return true;

  // 顺手清理过期键，避免 Map 无限增长
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) {
      if (v.every((t) => t <= windowStart)) buckets.delete(k);
    }
  }
  return false;
}

/** 取客户端 IP（多层代理取第一个值） */
export function clientIp(request) {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip')
    || 'local';
}
