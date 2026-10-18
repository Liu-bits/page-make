// JWKS 加载器：实时拉取（带超时）→ 磁盘缓存 → 内置种子，三级回退
// 背景：自托管容器在境内网络可能无法访问 googleapis.com / appleid.apple.com；
//       Node fetch 无默认超时，连接被墙会挂起 75 秒+（App 侧 60 秒即超时），
//       因此必须：① 拉取带超时 ② 失败快速回退到内置种子（随镜像分发，CI 部署时刷新）。
// EdgeOne Pages 等无 fs 环境：跳过磁盘缓存与种子，仅实时拉取（动态 import 失败即降级）。
import path from 'node:path';

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_TTL_MS = 60 * 60 * 1000;

// 动态获取 Node 能力（EdgeOne/Workerd 下 import node:fs 会抛错 → 返回 null 走降级）
let nodeFs = null;
let nodeUrl = null;
let nodeChecked = false;
async function ensureNode() {
  if (nodeChecked) return nodeFs;
  nodeChecked = true;
  try {
    nodeFs = await import('node:fs/promises');
    nodeUrl = await import('node:url');
  } catch {
    nodeFs = null;
    nodeUrl = null;
  }
  return nodeFs;
}

async function readJsonFile(filePath) {
  if (!(await ensureNode())) return null;
  try {
    const text = await nodeFs.readFile(filePath, 'utf8');
    const data = JSON.parse(text);
    return Array.isArray(data?.keys) && data.keys.length ? data : null;
  } catch {
    return null;
  }
}

async function writeJsonFile(filePath, data) {
  if (!(await ensureNode())) return;
  try {
    await nodeFs.mkdir(path.dirname(filePath), { recursive: true });
    await nodeFs.writeFile(filePath, JSON.stringify(data));
  } catch {
    // 持久卷不可写时静默（不影响主流程）
  }
}

function seedPathOf(seedUrl) {
  // seedUrl 为 new URL(...)（import.meta.url 相对定位）；无 Node 环境返回 null
  if (!seedUrl || !nodeUrl) return null;
  try {
    return nodeUrl.fileURLToPath(seedUrl);
  } catch {
    return null;
  }
}

/**
 * 创建 JWKS 加载器
 * @param {object} options
 * @param {string} options.name        'google' | 'apple'（诊断标识）
 * @param {string} options.url         JWKS 地址
 * @param {URL}   [options.seedUrl]    内置种子文件（new URL 形式，无 fs 环境自动忽略）
 * @param {string} [options.cacheDir]  磁盘缓存目录（默认 DATA_DIR/jwks；无 fs 环境忽略）
 * @param {number} [options.ttlMs]     内存缓存时长（默认 1 小时）
 * @param {number} [options.timeoutMs] 实时拉取超时（默认 5 秒）
 * @returns {{ getKeys: () => Promise<{keys: any[], source: string, fetchedAt: number}>, status: () => object }}
 */
export function createJwksLoader(options) {
  const {
    name,
    url,
    seedUrl,
    ttlMs = DEFAULT_TTL_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    cacheDir = process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'jwks') : null,
  } = options;

  let memory = { keys: [], fetchedAt: 0, source: null, lastError: null };
  let seedPromise = null;

  async function fetchLive() {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data?.keys) || data.keys.length === 0) throw new Error('JWKS 为空');
    return data;
  }

  function loadSeed() {
    if (!seedPromise) {
      seedPromise = (async () => {
        await ensureNode();
        const p = seedPathOf(seedUrl);
        return p ? readJsonFile(p) : null;
      })();
    }
    return seedPromise;
  }

  async function getKeys() {
    const now = Date.now();
    // 内存缓存（TTL 内直接复用）
    if (memory.keys.length && now - memory.fetchedAt < ttlMs) {
      return { keys: memory.keys, source: memory.source, fetchedAt: memory.fetchedAt };
    }

    // 1. 实时拉取（带超时；境内网络失败时快速放弃，不等 75 秒）
    try {
      const data = await fetchLive();
      memory = { keys: data.keys, fetchedAt: now, source: 'live', lastError: null };
      if (cacheDir) void writeJsonFile(path.join(cacheDir, `${name}-jwks.json`), data);
      return { keys: memory.keys, source: 'live', fetchedAt: memory.fetchedAt };
    } catch (error) {
      memory.lastError = String(error?.message || error);
    }

    // 2. 磁盘缓存（持久卷，跨容器重启；比种子新）
    if (cacheDir) {
      const disk = await readJsonFile(path.join(cacheDir, `${name}-jwks.json`));
      if (disk) {
        memory = { keys: disk.keys, fetchedAt: now, source: 'disk', lastError: memory.lastError };
        return { keys: disk.keys, source: 'disk', fetchedAt: now };
      }
    }

    // 3. 内置种子（随镜像分发，CI 部署时刷新，保证境内可用）
    const seed = await loadSeed();
    if (seed) {
      memory = { keys: seed.keys, fetchedAt: now, source: 'seed', lastError: memory.lastError };
      return { keys: seed.keys, source: 'seed', fetchedAt: now };
    }

    throw Object.assign(new Error(`${name.toUpperCase()}_JWKS_UNAVAILABLE`), { code: 'AUTH_ERROR' });
  }

  return {
    getKeys,
    status() {
      return {
        name,
        source: memory.source,
        keyCount: memory.keys.length,
        fetchedAt: memory.fetchedAt || null,
        lastError: memory.lastError,
      };
    },
  };
}
