// POST /api/admin/action — 后台管理操作（需 X-Admin-Token）
// body: { action, ... }
//   ban               { userId, level(1-4), reason(必填), days(数字或 null=永久) }
//   unban             { userId }
//   deleteUser        { userId }                     删除账号（用户记录+全部项目+会话，强制下线）
//   deleteFeedback    { id }
//   deleteProject     { projectId }
//   setPassword       { newPassword }                管理员改自己的后台密码
//   upgradeVIP        { userId }                     将现有 Apple/Google/游客账号升级为 VIP
//   downgradeVIP      { userId }                     取消 VIP（保留账号与项目）
//   deleteVIPUser     { userId }                     删除 VIP 用户（= deleteUser，仅允许 VIP）
//   reviewVIPRequest  { userId, approve, note? }     审核游客 VIP 升级申请
//   purgePasswordUsers {}                             删除历史邮箱密码账号及其数据与会话
// 合规：封号必须带原因（用户端可见），解封后项目自动恢复上架；用户可通过 App 内反馈申诉
import { kvGet, kvPut, kvDel, kvListAll, keys, nowSeconds } from '../../lib/kv.js';
import { decodeKey } from '../../lib/base64.js';
import { ok, fail } from '../../lib/responses.js';
import { requireAdmin, changeAdminPassword } from '../../lib/admin.js';
import { revokeUserSessions, isVIPUser } from '../../lib/session.js';
import { BAN_LEVELS } from '../../lib/state.js';
import { deleteUserAccount, purgePasswordUsers } from '../../lib/admin-users.js';

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
async function deleteUserFromAdmin(kv, { userId, requireVIP = false }) {
  if (typeof userId !== 'string' || !userId) return fail('BAD_REQUEST', 400);
  const user = await kvGet(kv, keys.user(userId));
  if (!user) return fail('NOT_FOUND', 404);
  if (requireVIP && !isVIPUser(user)) return fail('NOT_VIP_USER', 400);

  await deleteUserAccount(kv, userId);
  return ok({ deleted: true, userId });
}

/**
 * 将现有账号升级为 VIP。
 * 不新建账号、不改 userId、不销毁会话，因此游客升级后仍用原游客方式进入，
 * 但所有游客限制在下一次请求即按升级后的角色解除。
 */
async function upgradeVIP(kv, { userId }) {
  if (typeof userId !== 'string' || !userId) return fail('BAD_REQUEST', 400);
  const user = await kvGet(kv, keys.user(userId));
  if (!user) return fail('NOT_FOUND', 404);
  if (isVIPUser(user)) return fail('ALREADY_VIP', 409);

  user.role = 'vip';
  user.vipSince = nowSeconds();
  delete user.isTest;
  await kvPut(kv, keys.user(userId), user);
  return ok({ upgraded: true, userId });
}

/** 取消 VIP：保留账号、项目与会话，只恢复普通账号权益。 */
async function downgradeVIP(kv, { userId }) {
  if (typeof userId !== 'string' || !userId) return fail('BAD_REQUEST', 400);
  const user = await kvGet(kv, keys.user(userId));
  if (!user) return fail('NOT_FOUND', 404);
  if (!isVIPUser(user)) return fail('NOT_VIP_USER', 400);

  user.role = 'user';
  delete user.isTest;
  delete user.vipSince;
  await kvPut(kv, keys.user(userId), user);
  return ok({ downgraded: true, userId });
}

/** 审核 VIP 升级申请：批准时调用同一套 upgradeVIP，保留账号、项目与会话。 */
async function reviewVIPRequest(kv, { userId, approve, note }) {
  if (typeof userId !== 'string' || !userId) return fail('BAD_REQUEST', 400);
  const record = await kvGet(kv, keys.vipRequest(userId));
  if (!record) return fail('NOT_FOUND', 404);
  if (record.status !== 'pending') return fail('VIP_REQUEST_ALREADY_REVIEWED', 409);

  const user = await kvGet(kv, keys.user(userId));
  if (!user) return fail('NOT_FOUND', 404);
  const cleanNote = typeof note === 'string' ? note.trim().slice(0, 200) : '';
  const now = nowSeconds();

  if (approve === true) {
    if (!isVIPUser(user)) {
      user.role = 'vip';
      user.vipSince = now;
      delete user.isTest;
      await kvPut(kv, keys.user(userId), user);
    }
    record.status = 'approved';
  } else {
    record.status = 'rejected';
  }
  record.reviewedAt = now;
  record.reviewNote = cleanNote;
  await kvPut(kv, keys.vipRequest(userId), record);
  return ok({
    reviewed: true,
    approved: approve === true,
    userId,
    role: isVIPUser(user) ? 'vip' : 'user',
    accountKind: user.userId?.startsWith('guest_')
      ? (isVIPUser(user) ? 'guest-vip' : 'guest')
      : (isVIPUser(user) ? 'vip' : 'user'),
  });
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
      return deleteUserFromAdmin(kv, body);
    case 'upgradeVIP':
      return upgradeVIP(kv, body);
    case 'downgradeVIP':
      return downgradeVIP(kv, body);
    case 'deleteVIPUser':
      return deleteUserFromAdmin(kv, { ...body, requireVIP: true });
    case 'reviewVIPRequest':
      return reviewVIPRequest(kv, body);
    case 'purgePasswordUsers':
      return ok({ deleted: await purgePasswordUsers(kv) });
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
