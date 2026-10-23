// POST /api/admin/action — 后台管理操作（需 X-Admin-Token）
// body: { action, ... }
//   ban               { userId, level(1-4), reason(必填), days(数字或 null=永久) }
//   unban             { userId }
//   deleteUser        { userId }                     删除账号（用户记录+全部项目+会话，强制下线）
//   deleteFeedback    { id }
//   deleteProject     { projectId }
//   setPassword       { newPassword }                管理员改自己的后台密码
//   createTestAccount { email, password }            创建测试账号（权益最高：绕过大小限制）
//   deleteTestAccount { userId }                     删除测试账号（= deleteUser，仅允许 isTest）
// 合规：封号必须带原因（用户端可见），解封后项目自动恢复上架；用户可通过 App 内反馈申诉
import { kvGet, kvPut, kvDel, kvListAll, keys, nowSeconds } from '../../lib/kv.js';
import { decodeKey } from '../../lib/base64.js';
import { ok, fail } from '../../lib/responses.js';
import { requireAdmin, changeAdminPassword } from '../../lib/admin.js';
import { BAN_LEVELS } from '../../lib/state.js';
import { hashPassword, userIdFromEmail, EMAIL_RE, checkPasswordStrength } from '../../lib/password.js';

/** 遍历某用户的全部项目（uproject 索引的 value 段是 hex 编码的项目 ID，需 decodeKey 还原） */
async function forEachUserProject(kv, userId, fn) {
  const prefix = keys.userProject(userId, '');
  const indexKeys = await kvListAll(kv, prefix);
  for (const key of indexKeys) {
    const projectId = decodeKey(key.slice(prefix.length));
    await fn(projectId, key);
  }
}

/** 封号：设置用户封禁状态 + 该用户全部项目下架（公开页显示「已下架」） */
async function banUser(kv, { userId, level, reason, days }) {
  const user = await kvGet(kv, keys.user(userId));
  if (!user) return fail('NOT_FOUND', 404);

  const lv = Number(level);
  if (!BAN_LEVELS[`L${lv}`]) return fail('BAD_REQUEST', 400);
  const cleanReason = typeof reason === 'string' ? reason.trim().slice(0, 200) : '';
  if (!cleanReason) return fail('BAD_REQUEST', 400);

  const banDays = days == null ? null : Number(days);
  const banUntil = banDays && banDays > 0 ? nowSeconds() + banDays * 86400 : null;

  user.status = 'banned';
  user.banLevel = lv;
  user.banReason = cleanReason;
  user.banUntil = banUntil;
  user.banCount = (user.banCount || 0) + 1;
  await kvPut(kv, keys.user(userId), user);

  // 项目全部下架（banned 状态公开页 403「已下架」）
  await forEachUserProject(kv, userId, async (projectId) => {
    const project = await kvGet(kv, keys.project(projectId));
    if (project && project.status !== 'banned') {
      project._preBanStatus = project.status;
      project.status = 'banned';
      await kvPut(kv, keys.project(projectId), project);
    }
  });
  return ok({ banned: true, userId, banUntil });
}

/** 解封：清除封禁状态 + 恢复项目为封禁前状态 */
async function unbanUser(kv, { userId }) {
  const user = await kvGet(kv, keys.user(userId));
  if (!user) return fail('NOT_FOUND', 404);

  user.status = 'active';
  user.banLevel = 0;
  user.banReason = null;
  user.banUntil = null;
  await kvPut(kv, keys.user(userId), user);

  await forEachUserProject(kv, userId, async (projectId) => {
    const project = await kvGet(kv, keys.project(projectId));
    if (project && project.status === 'banned') {
      project.status = project._preBanStatus === 'failed' ? 'failed' : 'ready';
      delete project._preBanStatus;
      await kvPut(kv, keys.project(projectId), project);
    }
  });
  return ok({ unbanned: true, userId });
}

/** 删除账号：用户记录 + 全部项目（含文件）+ 会话（强制下线） */
async function deleteUserAccount(kv, { userId, requireTest = false }) {
  if (typeof userId !== 'string' || !userId) return fail('BAD_REQUEST', 400);
  const user = await kvGet(kv, keys.user(userId));
  if (!user) return fail('NOT_FOUND', 404);
  if (requireTest && !user.isTest) return fail('NOT_TEST_ACCOUNT', 400);

  await forEachUserProject(kv, userId, async (projectId, indexKey) => {
    for (const siteKey of await kvListAll(kv, keys.sitePrefix(projectId))) await kvDel(kv, siteKey);
    await kvDel(kv, keys.siteMeta(projectId));
    await kvDel(kv, keys.project(projectId));
    await kvDel(kv, indexKey);
  });

  // 会话全部清除（下次请求即 401，实现强制下线）
  for (const key of await kvListAll(kv, 'session_')) {
    const session = await kvGet(kv, key);
    if (session?.userId === userId) await kvDel(kv, key);
  }
  await kvDel(kv, keys.user(userId));
  return ok({ deleted: true, userId });
}

/** 创建测试账号（邮箱+密码，登录走邮箱密码；权益最高：绕过大小/数量限制） */
async function createTestAccount(kv, { email, password }) {
  const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!EMAIL_RE.test(cleanEmail)) return fail('BAD_REQUEST', 400);
  const strength = checkPasswordStrength(password);
  if (!strength.ok) return fail(strength.reason, 400);
  const userId = await userIdFromEmail(cleanEmail);
  if (await kvGet(kv, keys.user(userId))) return fail('USER_EXISTS', 409);

  await kvPut(kv, keys.user(userId), {
    userId,
    email: cleanEmail,
    password: await hashPassword(password),
    isTest: true,
    status: 'active',
    banLevel: 0,
    banUntil: null,
    banReason: null,
    banCount: 0,
    createdAt: nowSeconds(),
  });
  return ok({ created: true, userId, email: cleanEmail });
}

/** 删除项目（管理员强制下架清理） */
async function deleteProjectAdmin(kv, { projectId }) {
  const project = await kvGet(kv, keys.project(projectId));
  if (!project) return fail('NOT_FOUND', 404);
  const userId = project.userId;
  for (const key of await kvListAll(kv, keys.sitePrefix(projectId))) await kvDel(kv, key);
  await kvDel(kv, keys.siteMeta(projectId));
  await kvDel(kv, keys.project(projectId));
  await kvDel(kv, keys.userProject(userId, projectId));
  return ok({ deleted: true, projectId });
}

export async function onRequest(context) {
  const { request } = context;
  if (request.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 405);
  const auth = await requireAdmin(context);
  if (auth.error) return auth.error;
  const { kv } = auth;

  let body;
  try {
    body = await request.json();
  } catch {
    return fail('BAD_REQUEST', 400);
  }

  switch (body?.action) {
    case 'ban':
      return banUser(kv, body);
    case 'unban':
      return unbanUser(kv, body);
    case 'deleteUser':
      return deleteUserAccount(kv, body);
    case 'createTestAccount':
      return createTestAccount(kv, body);
    case 'deleteTestAccount':
      return deleteUserAccount(kv, { ...body, requireTest: true });
    case 'deleteFeedback': {
      if (typeof body.id !== 'string' || !body.id) return fail('BAD_REQUEST', 400);
      await kvDel(kv, keys.feedback(body.id));
      return ok({ deleted: true });
    }
    case 'deleteProject':
      return deleteProjectAdmin(kv, body);
    case 'setPassword': {
      try {
        await changeAdminPassword(kv, body.newPassword);
        return ok({ changed: true });
      } catch (error) {
        // 强度校验失败（WEAK_PASSWORD / _COMMON / _PATTERN / _SIMPLE）原样回传错误码
        if (error.message.startsWith('WEAK_PASSWORD')) return fail(error.message, 400);
        return fail('STORAGE_ERROR', 500);
      }
    }
    default:
      return fail('BAD_REQUEST', 400);
  }
}
