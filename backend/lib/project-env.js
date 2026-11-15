// 后端项目自定义环境变量：校验 / 读写 / 注入。
//
// 为什么单独一个 key（env_<projectId>）而不是挂在项目记录上：
// 项目记录会被封禁、发布、游客续期、状态轮询频繁写回，env 只在设置时变一次，
// 挂上去等于给每次项目写放大一份；而且项目记录写入都在 `project:<id>` 锁内，
// 让 env 也去抢同一把锁没有必要。
//
// 安全边界：用户 env 会注入到用户自己的 Node 进程，绝不能反过来覆盖运行时
// 自己依赖的键（PATH / PORT / NODE_OPTIONS 等），否则用户可以把堆上限、监听
// 地址甚至模块解析路径改掉。保留键在 ENV_RESERVED 里显式拒绝。

import { kvGet, kvPut, kvDel, keys } from './kv.js';

export const ENV_MAX_KEYS = 24;
export const ENV_MAX_VALUE_BYTES = 2000;
export const ENV_MAX_TOTAL_BYTES = 16 * 1024;

/** 环境变量名：大写字母/数字/下划线，不能以数字开头 */
export const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;

/** 运行时自己要用、用户不能覆盖的键 */
export const ENV_RESERVED = new Set([
  'PATH', 'HOME', 'NODE_ENV', 'PORT', 'HOST', 'NODE_OPTIONS', 'CI',
  'PWD', 'SHELL', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL',
]);

/**
 * 校验并归一化用户提交的 env。
 * @param {unknown} raw
 * @returns {{env: Record<string,string>} | {error: string, message: string}}
 */
export function validateEnv(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'BAD_REQUEST', message: 'env 必须是对象' };
  }
  const entries = Object.entries(raw);
  if (entries.length > ENV_MAX_KEYS) {
    return { error: 'ENV_TOO_MANY', message: `最多 ${ENV_MAX_KEYS} 个环境变量` };
  }

  const env = {};
  let total = 0;
  for (const [rawKey, rawValue] of entries) {
    const key = String(rawKey ?? '').trim();
    if (!ENV_KEY_RE.test(key)) {
      return { error: 'ENV_BAD_KEY', message: `变量名不合法：${key || '(空)'}（只允许大写字母、数字、下划线，且不能以数字开头）` };
    }
    if (ENV_RESERVED.has(key)) {
      return { error: 'ENV_RESERVED_KEY', message: `${key} 由运行时保留，不能自定义` };
    }
    if (typeof rawValue !== 'string') {
      return { error: 'BAD_REQUEST', message: `${key} 的值必须是字符串` };
    }
    const value = rawValue;
    const bytes = new TextEncoder().encode(value).length;
    if (bytes > ENV_MAX_VALUE_BYTES) {
      return { error: 'ENV_VALUE_TOO_LARGE', message: `${key} 的值超过 ${ENV_MAX_VALUE_BYTES} 字节` };
    }
    total += bytes + key.length;
    if (total > ENV_MAX_TOTAL_BYTES) {
      return { error: 'ENV_TOO_LARGE', message: `环境变量总大小超过 ${ENV_MAX_TOTAL_BYTES} 字节` };
    }
    env[key] = value;
  }
  return { env };
}

/** 读取项目的 env（无则空对象）。仅注入用途，不校验保留键（历史数据容错）。 */
export async function readProjectEnv(kv, projectId) {
  const record = await kvGet(kv, keys.projectEnv(projectId));
  if (!record || typeof record !== 'object' || Array.isArray(record)) return {};
  const env = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== 'string') continue;
    if (ENV_RESERVED.has(key)) continue;
    env[key] = value;
  }
  return env;
}

/** 覆盖写入（空对象等价于清空） */
export async function writeProjectEnv(kv, projectId, env) {
  if (!env || Object.keys(env).length === 0) {
    await kvDel(kv, keys.projectEnv(projectId));
    return;
  }
  await kvPut(kv, keys.projectEnv(projectId), env);
}

export async function deleteProjectEnv(kv, projectId) {
  await kvDel(kv, keys.projectEnv(projectId));
}
