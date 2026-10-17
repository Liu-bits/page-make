// POST /api/admin/action — 后台管理操作（需 X-Admin-Token）
// body: { action, ... }
//   ban            { userId, level(1-4), reason(必填), days(数字或 null=永久) }
//   unban          { userId }
//   deleteFeedback { id }
//   deleteProject  { projectId }
//   setPassword    { newPassword }   管理员改自己的后台密码
// 合规：封号必须带原因（用户端可见），解封后项目自动恢复上架；用户可通过 App 内反馈申诉
import { kvGet, kvPut, kvDel, kvListAll, keys, nowSeconds } from '../../lib/kv.js';
import { ok, fail } from '../../lib/responses.js';
import { requireAdmin, changeAdminPassword } from '../../lib/admin.js';
import { BAN_LEVELS } from '../../lib/state.js';

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
  const indexKeys = await kvListAll(kv, keys.userProject(userId, ''));
  for (const key of indexKeys) {
    const pid = key.slice(keys.userProject(userId, '').length);
    const project = await kvGet(kv, keys.project(pid));
    if (project && project.status !== 'banned') {
      project._preBanStatus = project.status;
      project.status = 'banned';
      await kvPut(kv, keys.project(pid), project);
    }
  }
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

  const indexKeys = await kvListAll(kv, keys.userProject(userId, ''));
  for (const key of indexKeys) {
    const pid = key.slice(keys.userProject(userId, '').length);
    const project = await kvGet(kv, keys.project(pid));
    if (project && project.status === 'banned') {
      project.status = project._preBanStatus === 'failed' ? 'failed' : 'ready';
      delete project._preBanStatus;
      await kvPut(kv, keys.project(pid), project);
    }
  }
  return ok({ unbanned: true, userId });
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
        if (error.message === 'WEAK_PASSWORD') return fail('WEAK_PASSWORD', 400);
        return fail('STORAGE_ERROR', 500);
      }
    }
    default:
      return fail('BAD_REQUEST', 400);
  }
}
