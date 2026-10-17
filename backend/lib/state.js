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

export const PROVIDERS = new Set(['edgeone', 'cloudflare']);

// 登录态有效期 7 天（到期前 1 天 iOS 静默刷新）
export const SESSION_TTL_SECONDS = 7 * 24 * 3600;
export const REFRESH_BEFORE_SECONDS = 24 * 3600;

// 分片上传：单片 600KB（base64 后约 800KB）；容器模式无 body 限制，协议保留兼容（iOS 端已实现）
export const MAX_TOTAL_BYTES = 5 * 1024 * 1024;
export const CHUNK_BYTES = 600 * 1024;
export const UPLOAD_TTL_SECONDS = 30 * 60;

// 粘贴代码创建：HTML + CSS + JS 总字节上限
export const PASTE_MAX_BYTES = 300 * 1024;

// 封号分级（第一版：用户举报 + 人工审核）
export const BAN_LEVELS = {
  L1: { days: 1, label: '初次轻微违规' },
  L2: { days: 7, label: '重复轻微或侵权' },
  L3: { days: 30, label: '诈骗、钓鱼' },
  L4: { days: null, label: '色情、暴恐、恶意软件（永久）' },
};

// 违规项目文件保留 7 天留证
export const TAKEDOWN_RETENTION_SECONDS = 7 * 24 * 3600;
