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

/**
 * 取客户端 IP。
 *
 * 取值优先级：`X-Real-IP` → `X-Forwarded-For` 的**最后一个**值 → 'local'。
 *
 * 为什么 XFF 取最后一个而不是第一个：前置网关通常是「追加」而非「覆盖」，
 * 第一个值是客户端自己填的，可以随便伪造——每次换一个就得到全新计数桶，
 * 限流形同虚设。最后一个值是最近一跳代理写入的，更难伪造。
 *
 * **已知风险（有意保留，未改成取第一跳）**：
 *  1. 如果链路上存在多跳代理且最后一跳没有写 XFF（例如某些 CDN 只加
 *     X-Real-IP），同一条链路的所有请求会共用同一个桶；更糟的情况是网关
 *     完全不透传 IP，所有用户都落到 'local'，等于**全站共用一个桶**——
 *     限流会把正常用户一起拦掉（表现为「反馈提交不了」而不是「被攻击」）。
 *     缓解：feedback 这类低价值接口的配额放宽到 10 次/分，宁可少拦也不误伤。
 *  2. 反过来，若攻击者能直连容器（绕过网关），他可以自填 XFF 最后一位来
 *     换桶。容器只监听平台网关暴露的端口，直连路径不存在，风险可接受。
 *  3. 若某天接入的网关确实会覆盖 XFF，则应改为取**第一跳**；判定依据是
 *     线上实测（见下）。
 *
 * 线上验证方法（确认「每用户独立桶」是否成立）：
 *   a. 用两个不同网络（手机流量 / 家宽）各提交一次反馈，再看容器日志里
 *      clientIp 是否不同；相同说明网关没透传真实 IP。
 *   b. 在同一网络下用 curl 带 `-H 'X-Forwarded-For: 1.2.3.4'` 提交，
 *      若被计入 1.2.3.4 的桶，说明最后一个值来自客户端而非网关，
 *      此时应改为取第一个值（或直接信 X-Real-IP）。
 *   c. 连续提交 11 次（超过 feedback 配额）应只在第 11 次拿到 429，
 *      提前 429 说明桶被共用。
 */
export function clientIp(request) {
  const realIp = request.headers.get('x-real-ip');
  if (realIp && realIp.trim()) return realIp.trim();
  const xff = request.headers.get('x-forwarded-for');
  if (xff) {
    const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return 'local';
}
