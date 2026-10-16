// GET /api/config — 公开服务信息（iOS 启动时读取限制）
import { ok } from '../lib/responses.js';
import { MAX_TOTAL_BYTES, CHUNK_BYTES, SESSION_TTL_SECONDS } from '../lib/state.js';

export async function onRequest() {
  return ok({
    service: 'page-make',
    providers: ['edgeone', 'cloudflare'],
    limits: {
      maxTotalBytes: MAX_TOTAL_BYTES,
      chunkSize: CHUNK_BYTES,
      sessionTtlSeconds: SESSION_TTL_SECONDS,
    },
  });
}
