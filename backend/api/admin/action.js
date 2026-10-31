// POST /api/admin/action — 后台管理操作（需 X-Admin-Token）
// body: { action, ... }
//   ban               { userId, level(1-4), reason(必填), days(数字或 null=永久) }
//   unban             { userId }
//   deleteUser        { userId }                     删除账号（用户记录+全部项目+会话，强制下线）
//   deleteFeedback    { id }
//   deleteProject     { projectId }
//   setPassword       { newPassword }                管理员改自己的后台密码
//   upgradeVIP        { userId }                     将现有 Apple/Google/游客账号升级为 VIP
//                                                （同时清除该账号游客期项目的 10 分钟链接过期时间）
//   setTier           { userId, tier }               设置等级：user / vip / svip / ultra
//                                                （升级清链接过期，降级按游客身份重新计时）
//   downgradeVIP      { userId }                     取消 VIP（保留账号与项目；游客身份链接重新计时）
//   deleteVIPUser     { userId }                     删除 VIP 用户（= deleteUser，仅允许 VIP）
//   reviewVIPRequest  { userId, approve, note? }     审核游客 VIP 升级申请
//   purgePasswordUsers {}                             删除历史邮箱密码账号及其数据与会话
// 合规：封号必须带原因（用户端可见），解封后项目自动恢复上架；用户可通过 App 内反馈申诉
import { kvGet, kvPut, kvDel, kvListAll, keys, nowSeconds } from '../../lib/kv.js';
import { decodeKey } from '../../lib/base64.js';
import { ok, fail } from '../../lib/responses.js';
import { requireAdmin, changeAdminPassword } from '../../lib/admin.js';
import { revokeUserSessions, isVIPUser } from '../../lib/session.js';
import { TIERS, tierOf } from '../../lib/tiers.js';
import {
  BAN_LEVELS,
  GUEST_LINK_TTL_SECONDS,
  STATUS,
  isBackendKind,
  normalizeKind,
} from '../../lib/state.js';
import { deleteUserAccount, purgePasswordUsers } from '../../lib/admin-users.js';
import {
  deployBackendApp,
  stop as stopBackendRuntime,
} from '../../lib/backend-runtime.js';

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
    if (!project) return;
    if (project.status !== 'banned') {
      project._preBanStatus = project.status;
      project.status = 'banned';
      await kvPut(kv, keys.project(projectId), project);
    }
    // 下架不仅是隐藏页面：npm/pnpm 常驻进程也必须停止，否则封禁账号
    // 仍能继续消耗 CPU、内存和内部端口。历史已下架记录也要补做回收。
    if (isBackendKind(normalizeKind(project.kind))) {
      await stopBackendRuntime(projectId);
    }
  });
  return ok({ banned: true, userId, banUntil });
}

/** 解封：清除封禁状态 + 恢复项目为封禁前状态 */
async function unbanUser(kv, { userId }, context) {
  const user = await kvGet(kv, keys.user(userId));
  if (!user) return fail('NOT_FOUND', 404);

  user.status = 'active';
  user.banLevel = 0;
  user.banReason = null;
  user.banUntil = null;
  await kvPut(kv, keys.user(userId), user);

  const restoreTasks = [];
  await forEachUserProject(kv, userId, async (projectId) => {
    const project = await kvGet(kv, keys.project(projectId));
    if (project && project.status === 'banned') {
      project.status = project._preBanStatus === 'failed' ? 'failed' : 'ready';
      delete project._preBanStatus;
      project.errorCode = null;
      if (project.status === STATUS.READY && isBackendKind(normalizeKind(project.kind))) {
        // 解封请求不能同步等 4 分钟依赖安装；先标记 processing，
        // 再交给 waitUntil 恢复常驻进程，客户端可继续轮询项目状态。
        project.status = STATUS.PROCESSING;
        await kvPut(kv, keys.project(projectId), project);
        restoreTasks.push((async () => {
          try {
            const runtime = await deployBackendApp({
              kv,
              projectId,
              kind: normalizeKind(project.kind),
            });
            const latest = await kvGet(kv, keys.project(projectId));
            if (!latest) {
              await stopBackendRuntime(projectId);
              return;
            }
            latest.status = STATUS.READY;
            latest.errorCode = null;
            latest.runtimePort = runtime.port;
            latest.runtimeKind = runtime.kind;
            await kvPut(kv, keys.project(projectId), latest);
          } catch (error) {
            const latest = await kvGet(kv, keys.project(projectId));
            if (!latest) return;
            latest.status = STATUS.FAILED;
            latest.errorCode = error?.code || 'RUNTIME_UNAVAILABLE';
            await kvPut(kv, keys.project(projectId), latest);
          }
        })());
        return;
      }
      await kvPut(kv, keys.project(projectId), project);
    }
  });
  const restoreTask = Promise.all(restoreTasks);
  if (restoreTasks.length && typeof context?.waitUntil === 'function') {
    context.waitUntil(restoreTask);
  } else if (restoreTasks.length) {
    await restoreTask;
  }
  return ok({ unbanned: true, userId, backendRestoring: restoreTasks.length });
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
 *
 * 同时清除该账号已有项目的 10 分钟链接过期时间：游客期创建的项目在记录里
 * 留了 expiresAt，若不同步清理，升级成功后公开页仍会按旧时间戳返回 410 过期，
 * 用户会看到「已升级但链接还是打不开」。返回清理的项目数，便于后台展示。
 */
async function upgradeVIP(kv, { userId }) {
  if (typeof userId !== 'string' || !userId) return fail('BAD_REQUEST', 400);
  const user = await kvGet(kv, keys.user(userId));
  if (!user) return fail('NOT_FOUND', 404);
  if (isVIPUser(user)) return fail('ALREADY_VIP', 409);
  return applyTier(kv, user, 'vip');
}

/**
 * 设置账号等级（user / vip / svip / ultra）。
 *
 * 升级方向统一清掉游客期的 10 分钟链接过期；降到 user 时若仍是游客身份
 * 则重新计时（与 downgradeVIP 同一套语义，避免两条路径行为不一致）。
 */
async function setTier(kv, { userId, tier }) {
  if (typeof userId !== 'string' || !userId) return fail('BAD_REQUEST', 400);
  if (!TIERS.includes(tier)) return fail('INVALID_TIER', 400);
  const user = await kvGet(kv, keys.user(userId));
  if (!user) return fail('NOT_FOUND', 404);
  if (tierOf(user) === tier) return fail('TIER_UNCHANGED', 409);
  return applyTier(kv, user, tier);
}

/** 落库并同步项目链接期限；upgradeVIP / setTier / downgradeVIP 共用 */
async function applyTier(kv, user, tier) {
  const userId = user.userId;
  const previous = tierOf(user);

  user.role = tier;
  if (tier === 'user') {
    delete user.vipSince;
  } else {
    user.vipSince = user.vipSince ?? nowSeconds();
  }
  delete user.isTest;
  await kvPut(kv, keys.user(userId), user);

  let linksRenewed = 0;
  let linksLimited = 0;
  if (tier === 'user') {
    // 只有游客身份才需要重新计时；Apple / Google 普通账号链接本就长期有效
    if (user.userId?.startsWith('guest_')) {
      linksLimited = await reapplyGuestLinkExpiry(kv, userId);
    }
    // 后端运行权益随等级收回：停掉常驻进程，避免降级后仍继续消耗资源。
    await forEachUserProject(kv, userId, async (projectId) => {
      const project = await kvGet(kv, keys.project(projectId));
      if (project && isBackendKind(normalizeKind(project.kind))) {
        await stopBackendRuntime(projectId);
      }
    });
  } else {
    linksRenewed = await clearGuestLinkExpiry(kv, userId);
  }

  return ok({
    tier,
    previousTier: previous,
    userId,
    linksRenewed,
    linksLimited,
  });
}

/** 清除某账号全部项目的游客链接过期时间（升级 VIP 时调用） */
async function clearGuestLinkExpiry(kv, userId) {
  let cleared = 0;
  await forEachUserProject(kv, userId, async (projectId) => {
    const project = await kvGet(kv, keys.project(projectId));
    if (project && project.expiresAt) {
      project.expiresAt = null;
      await kvPut(kv, keys.project(projectId), project);
      cleared += 1;
    }
  });
  return cleared;
}

/**
 * 取消 VIP：保留账号、项目与会话，只恢复普通账号权益。
 *
 * 游客身份降级后必须把该账号所有项目的链接重新加上 10 分钟过期时间，
 * 否则原本长期有效的公开链接会无限期可访问，等于绕过了试用期限制。
 * Apple / Google 普通账号（非 guest_ 前缀）链接本就不设过期，不受影响。
 */
async function downgradeVIP(kv, { userId }) {
  if (typeof userId !== 'string' || !userId) return fail('BAD_REQUEST', 400);
  const user = await kvGet(kv, keys.user(userId));
  if (!user) return fail('NOT_FOUND', 404);
  if (!isVIPUser(user)) return fail('NOT_VIP_USER', 400);
  return applyTier(kv, user, 'user');
}

/** 给游客身份的项目重新加上 10 分钟链接过期时间（取消 VIP 时调用） */
async function reapplyGuestLinkExpiry(kv, userId) {
  const expiresAt = nowSeconds() + GUEST_LINK_TTL_SECONDS;
  let limited = 0;
  await forEachUserProject(kv, userId, async (projectId) => {
    const project = await kvGet(kv, keys.project(projectId));
    if (!project) return;
    // 已经设置过且未到期的保持原时间，避免把用户的剩余时间一刀切掉
    if (project.expiresAt && project.expiresAt > nowSeconds()) return;
    project.expiresAt = expiresAt;
    await kvPut(kv, keys.project(projectId), project);
    limited += 1;
  });
  return limited;
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
    // 与 upgradeVIP 同一套授权逻辑（原地写角色，不换账号、不销毁会话），
    // 同时清掉游客期项目的 10 分钟过期时间，否则升级后旧链接仍会 410。
    let linksRenewed = 0;
    if (!isVIPUser(user)) {
      user.role = 'vip';
      user.vipSince = now;
      delete user.isTest;
      await kvPut(kv, keys.user(userId), user);
      linksRenewed = await clearGuestLinkExpiry(kv, userId);
    }
    record.status = 'approved';
    record.linksRenewed = linksRenewed;
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
    linksRenewed: record.linksRenewed ?? 0,
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
  await stopBackendRuntime(projectId);
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
      return unbanUser(kv, body, context);
    case 'deleteUser':
      return deleteUserFromAdmin(kv, body);
    case 'upgradeVIP':
      return upgradeVIP(kv, body);
    case 'setTier':
      return setTier(kv, body);
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
