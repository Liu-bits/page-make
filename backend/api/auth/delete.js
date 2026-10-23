// POST /api/auth/delete — 删除账号（App Store 审核要求 5.1.1(v)：App 内必须支持账号删除）
// 行为：删除该用户全部项目（文件/元信息/索引）+ 用户记录；会话因 user 不存在自动失效
import { requireAuth } from '../../lib/session.js';
import { kvListAll, kvDel, keys, appendLog } from '../../lib/kv.js';
import { decodeKey } from '../../lib/base64.js';
import { ok, fail } from '../../lib/responses.js';
import { deleteProjectRecords } from '../../lib/project.js';

export async function onRequest(context) {
  const { request } = context;
  const auth = await requireAuth(context);
  if (auth.error) return auth.error;
  if (request.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 405);

  // 语义确认：客户端必须显式传 confirm=true（防误触/防 CSRF 简单屏障）
  let body = {};
  try {
    body = await request.json();
  } catch {
    // 无 body 视为未确认
  }
  if (body?.confirm !== true) return fail('BAD_REQUEST', 400);

  const { kv, user } = auth;
  const userId = user.userId;

  // 1. 删除全部项目（文件 + 元信息 + 记录 + 索引）
  const indexKeys = await kvListAll(kv, keys.userProject(userId, ''));
  for (const key of indexKeys) {
    // 索引 key 后缀是 hex 编码的项目 ID，必须先解码再删（与 projects.js / stats.js 一致，
    // 否则按错误 ID 删除会静默失败，导致 site_/project_ 残留且公开链接仍可访问）
    const id = decodeKey(key.slice(keys.userProject(userId, '').length));
    await deleteProjectRecords(kv, userId, id);
  }

  // 2. 删除用户记录（此后所有会话在 requireAuth 校验 user 时自动 401）
  await kvDel(kv, keys.user(userId));

  await appendLog(kv, { step: 'account_delete', result: 'ok', userId });
  return ok({ deleted: true });
}
