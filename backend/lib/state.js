// 状态机常量 / 业务限制（与 iOS 端、文档保持一致）
export const STATUS = {
  UPLOADING: 'uploading',
  PROCESSING: 'processing',
  READY: 'ready',
  FAILED: 'failed',
  EXPIRED: 'expired',
};

// 错误码（与 iOS 端 PlainLanguage 映射一致）
export const ERR = {
  NO_ENTRY: 'NO_ENTRY',
  TOO_LARGE: 'TOO_LARGE',
  BAD_ZIP: 'BAD_ZIP',
  STORAGE_ERROR: 'STORAGE_ERROR',
  DB_ERROR: 'DB_ERROR',
  INVALID_PROVIDER: 'INVALID_PROVIDER',
  EXPIRED: 'EXPIRED',
};

// local = 自托管容器（当前唯一线路）；edgeone/cloudflare 保留兼容旧客户端
export const PROVIDERS = new Set(['local', 'edgeone', 'cloudflare']);

/**
 * 部署形态（部署选项三选一）。
 * - static：纯前端，直接由 /p/<id> 下发文件（原有能力，所有等级可用）
 * - npm / pnpm：后端项目，容器内安装依赖并常驻 Node 进程，/p/<id> 反向代理
 * 历史项目没有 kind 字段，一律按 static 处理。
 */
export const PROJECT_KIND = {
  STATIC: 'static',
  NPM: 'npm',
  PNPM: 'pnpm',
};

export const PROJECT_KINDS = new Set([PROJECT_KIND.STATIC, PROJECT_KIND.NPM, PROJECT_KIND.PNPM]);

/** 是否后端形态（需要安装依赖 + 常驻进程） */
export function isBackendKind(kind) {
  return kind === PROJECT_KIND.NPM || kind === PROJECT_KIND.PNPM;
}

/** 归一化部署形态：非法/缺失一律按 static（历史项目兼容） */
export function normalizeKind(raw) {
  return PROJECT_KINDS.has(raw) ? raw : PROJECT_KIND.STATIC;
}

// 登录态有效期 7 天（到期前 1 天 iOS 静默刷新）
export const SESSION_TTL_SECONDS = 7 * 24 * 3600;
export const REFRESH_BEFORE_SECONDS = 24 * 3600;

// 分片上传：单片 600KB（base64 后约 800KB）；容器模式无 body 限制，协议保留兼容（iOS 端已实现）
export const MAX_TOTAL_BYTES = 5 * 1024 * 1024;
export const CHUNK_BYTES = 600 * 1024;
export const UPLOAD_TTL_SECONDS = 30 * 60;

// 粘贴代码创建：HTML + CSS + JS 总字节上限
export const PASTE_MAX_BYTES = 300 * 1024;

// 项目模式历史常量：旧客户端提示用；实际文件写入统一按 tiers.js 的账号配额。
export const FILE_MAX_BYTES = 900 * 1024;

// ZIP 解压防护：压缩包本身 ≤ 5MB，但解压后可能膨胀数百倍（zip 炸弹）
// 这里对「解压总量」与「条目数」单独设限，超限即拒绝，避免打满容器磁盘导致全站不可用
export const ZIP_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
export const ZIP_MAX_ENTRIES = 500;

// 后端项目（npm/pnpm）运行时限制
// 依赖安装很吃 CPU 与磁盘，ModelScope 免费空间资源有限，必须硬性设限：
export const BACKEND_INSTALL_TIMEOUT_MS = 240 * 1000; // 依赖安装上限 4 分钟
export const BACKEND_BUILD_TIMEOUT_MS = 180 * 1000;   // 构建脚本上限 3 分钟
export const BACKEND_MAX_CONCURRENT = 3;              // 同时常驻的后端进程数
export const BACKEND_MAX_RESTARTS = 3;                // 崩溃自动重启上限
export const BACKEND_MEMORY_MB = 256;                 // 单进程堆上限
export const BACKEND_PORT_START = 4100;               // 内部分配端口起始
// 游客链接有效期：10 分钟自动失效（游客=快速试用；登录后创建的链接长期有效）
export const GUEST_LINK_TTL_SECONDS = 10 * 60;

// 封号分级（第一版：用户举报 + 人工审核）
export const BAN_LEVELS = {
  L1: { days: 1, label: '初次轻微违规' },
  L2: { days: 7, label: '重复轻微或侵权' },
  L3: { days: 30, label: '诈骗、钓鱼' },
  L4: { days: null, label: '色情、暴恐、恶意软件（永久）' },
};

// 违规项目文件保留 7 天留证
export const TAKEDOWN_RETENTION_SECONDS = 7 * 24 * 3600;
