// =============================================================================
// 账号等级（tier）与配额 —— 全站唯一真相
//
// 等级从低到高：user < vip < svip < ultra
// 历史字段兼容：`isTest: true` 的老账号按 vip 处理（只读兼容，不迁移数据）。
//
// 为什么单独抽一个文件：配额会同时被上传、粘贴、项目模式、后端运行时、
// 导出、iOS 展示五处读取。散落在各 handler 里迟早出现「某处漏改」，
// 之前 VIP 判定不统一就是这样埋下 500 INTERNAL_ERROR 的。
// =============================================================================

/** 全部等级（升序） */
export const TIERS = ['user', 'vip', 'svip', 'ultra'];

/** 等级序号，用于「至少达到某级」的比较 */
const TIER_RANK = new Map(TIERS.map((tier, index) => [tier, index]));

/**
 * 归一化任意 user 记录为有效等级。
 * - role 非法/缺失 → user
 * - 历史 isTest 账号 → vip（老测试账号本来就是按 VIP 待遇跑的）
 */
export function tierOf(user) {
  const raw = user?.role;
  if (typeof raw === 'string' && TIER_RANK.has(raw)) return raw;
  if (user?.isTest) return 'vip';
  return 'user';
}

/** 当前等级是否 >= 目标等级 */
export function atLeast(user, tier) {
  const rank = TIER_RANK.get(tier);
  if (rank === undefined) return false;
  return (TIER_RANK.get(tierOf(user)) ?? 0) >= rank;
}

/** 是否 VIP 及以上（保留旧名，语义已扩展为「任意付费等级」） */
export function isVIPUser(user) {
  return atLeast(user, 'vip');
}

/**
 * 是否仍受游客试用规则限制。
 * 游客身份（guest_ 前缀）与等级是两个维度：guest_ 账号一旦升级到 vip 及以上，
 * 项目数 / 链接 10 分钟 / 项目模式三项限制全部解除。
 */
export function isGuestLimited(user) {
  return Boolean(user?.userId?.startsWith('guest_')) && tierOf(user) === 'user';
}

/**
 * 能否部署后端项目（npm / pnpm）。
 * 普通用户只能建纯前端站点，后端运行时是 VIP 起的特权。
 */
export function canUseBackend(user) {
  return atLeast(user, 'vip');
}

/**
 * 项目体积上限（字节）。
 *
 * 两套配额分开算，因为二者的物理成本完全不同：
 * - 静态项目：只是 KV 里的文件，5MB 足够；Ultra 放开到无限。
 * - 后端项目：源码要落到持久卷、还要装依赖跑进程，按等级收紧。
 *   注意后端项目的大小只算**源码包**，不含安装生成的 node_modules。
 */
export const QUOTA = {
  static: {
    user: 5 * 1024 * 1024,
    vip: 1 * 1024 * 1024,
    svip: 100 * 1024 * 1024,
    ultra: Number.POSITIVE_INFINITY,
  },
  backend: {
    user: 0, // 不可用
    vip: 1 * 1024 * 1024,
    svip: 100 * 1024 * 1024,
    ultra: Number.POSITIVE_INFINITY,
  },
};

/** 取某账号在指定维度上的配额（字节；Infinity 表示无上限） */
export function quotaFor(user, dimension = 'static') {
  const table = QUOTA[dimension] || QUOTA.static;
  return table[tierOf(user)] ?? table.user;
}

/** 单文件上限：与项目总上限同源，避免「总量够但单文件被拒」的怪现象 */
export function fileLimitFor(user, dimension = 'static') {
  return quotaFor(user, dimension);
}

/** 面向客户端的配额快照（iOS 用来做 UI 禁用态与提示文案） */
export function quotaView(user) {
  const tier = tierOf(user);
  const backend = canUseBackend(user);
  return {
    tier,
    canUseBackend: backend,
    canExport: atLeast(user, 'vip'),
    staticMaxBytes: quotaFor(user, 'static'),
    backendMaxBytes: backend ? quotaFor(user, 'backend') : 0,
  };
}

/** JSON 不能表示 Infinity：对外输出时转成 null（null = 无上限） */
export function quotaViewJson(user) {
  const view = quotaView(user);
  return {
    ...view,
    staticMaxBytes: Number.isFinite(view.staticMaxBytes) ? view.staticMaxBytes : null,
    backendMaxBytes: Number.isFinite(view.backendMaxBytes) ? view.backendMaxBytes : null,
  };
}
