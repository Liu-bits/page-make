// KV 访问层
// 绑定方式：EdgeOne Pages 控制台 → 存储 → KV 存储 → 创建命名空间 → 绑定到项目，
//           变量名固定为 PAGEMAKE（本项目所有数据一个命名空间，靠 key 前缀隔离）
// KV key 规则：仅数字、字母、下划线；值 ≤ 25MB；最终一致性（边缘缓存最长 60s）
import { encodeKey, decodeKey } from './base64.js';

const KV_BINDING = 'PAGEMAKE';

export function getKV(env) {
  const kv = env?.[KV_BINDING];
  if (!kv) {
    throw new Error(`KV 未绑定：请在控制台创建命名空间并绑定变量名 ${KV_BINDING}`);
  }
  return kv;
}

export function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

// key 命名空间（全部经 encodeKey 保证字符合法且可逆）
export const keys = {
  user: (userId) => `user_${encodeKey(userId)}`,
  session: (token) => `session_${encodeKey(token)}`,
  project: (id) => `project_${encodeKey(id)}`,
  userProject: (userId, id) => `uproject_${encodeKey(userId)}_${encodeKey(id)}`,
  upload: (id) => `upload_${encodeKey(id)}`,
  uploadChunk: (uploadId, fileIndex, chunkIndex) => `tmp_${encodeKey(uploadId)}_${fileIndex}_${chunkIndex}`,
  siteFile: (projectId, path) => `site_${encodeKey(projectId)}_${encodeKey(path)}`,
  sitePrefix: (projectId) => `site_${encodeKey(projectId)}_`,
  siteMeta: (projectId) => `meta_${encodeKey(projectId)}`,
  log: (id) => `log_${encodeKey(id)}`,
  feedback: (id) => `feedback_${encodeKey(id)}`,
  ban: (id) => `ban_${encodeKey(id)}`,
  config: (name) => `config_${encodeKey(name)}`,
};

// 从 site_ 前缀 key 还原文件路径（key = site_<hex(id)>_<hex(path)>）
export function pathFromSiteKey(key) {
  const marker = key.indexOf('_', 'site_'.length);
  return decodeKey(key.slice(marker + 1));
}

export async function kvGet(kv, key, type = 'json') {
  const value = await kv.get(key, { type });
  return value ?? null;
}

export async function kvPut(kv, key, value) {
  await kv.put(key, value);
}

export async function kvDel(kv, key) {
  await kv.delete(key);
}

export async function kvListAll(kv, prefix) {
  const results = [];
  let cursor;
  do {
    const page = await kv.list({ prefix, limit: 256, cursor });
    for (const entry of page.keys || []) results.push(entry.key);
    cursor = page.complete ? undefined : page.cursor;
  } while (cursor);
  return results;
}

// 读取临时分片（KV 最终一致性：失败重试）
export async function readChunkWithRetry(kv, key, attempts = 12) {
  for (let i = 0; i < attempts; i++) {
    const value = await kv.get(key, { type: 'arrayBuffer' });
    if (value) return new Uint8Array(value);
    await sleep(100 * (i + 1));
  }
  throw Object.assign(new Error(`分片读取失败：${key}`), { code: 'STORAGE_ERROR' });
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// logs 表追加
export async function appendLog(kv, entry) {
  const id = crypto.randomUUID().replace(/-/g, '');
  const record = {
    id,
    projectId: entry.projectId ?? null,
    step: entry.step,
    result: entry.result,
    errorCode: entry.errorCode ?? null,
    duration: entry.duration ?? 0,
    createdAt: nowSeconds(),
  };
  try {
    await kvPut(kv, keys.log(id), record);
  } catch {
    // 日志写入失败不影响主流程
  }
  return record;
}
