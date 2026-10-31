// GET /api/config — 公开服务信息（iOS 启动时读取限制 + JWKS 健康诊断）
import { ok } from '../lib/responses.js';
import { MAX_TOTAL_BYTES, CHUNK_BYTES, SESSION_TTL_SECONDS, BACKEND_MAX_CONCURRENT } from '../lib/state.js';
import { googleJwks } from '../lib/google-auth.js';
import { appleJwks } from '../lib/apple-auth.js';
import { runtimeAvailable, runtimeStatus } from '../lib/backend-runtime.js';
import { QUOTA } from '../lib/tiers.js';

export async function onRequest() {
  return ok({
    service: 'page-make',
    providers: ['local'],
    limits: {
      maxTotalBytes: MAX_TOTAL_BYTES,
      chunkSize: CHUNK_BYTES,
      sessionTtlSeconds: SESSION_TTL_SECONDS,
      // 分级配额（Infinity 转 null 表示无上限）
      quota: {
        static: Object.fromEntries(Object.entries(QUOTA.static).map(([k, v]) => [k, Number.isFinite(v) ? v : null])),
        backend: Object.fromEntries(Object.entries(QUOTA.backend).map(([k, v]) => [k, Number.isFinite(v) ? v : null])),
      },
    },
    // 后端项目运行时（npm / pnpm）是否可用 + 当前常驻进程
    runtime: {
      available: runtimeAvailable(),
      maxConcurrent: BACKEND_MAX_CONCURRENT,
      running: runtimeStatus().length,
    },
    // JWKS 状态：source = live（实时拉取）/ disk（磁盘缓存）/ seed（内置种子）
    // 境内部署 live 不可达时显示 seed——种子由 CI 每日刷新，不影响登录
    jwks: {
      google: googleJwks.status(),
      apple: appleJwks.status(),
    },
  });
}
