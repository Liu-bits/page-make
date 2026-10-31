// 管理员账号数据维护：项目/文件/会话/用户记录一次删除。
// 后台删除操作与历史邮箱密码账号清理共用，避免两套逻辑漂移。
import { kvGet, kvDel, kvListAll, keys } from './kv.js';
import { decodeKey } from './base64.js';
import { revokeUserSessions } from './session.js';
import { stop as stopBackendRuntime } from './backend-runtime.js';

export async function forEachUserProject(kv, userId, fn) {
  const prefix = keys.userProject(userId, '');
  for (const key of await kvListAll(kv, prefix)) {
    await fn(decodeKey(key.slice(prefix.length)), key);
  }
}

export async function deleteUserAccount(kv, userId) {
  const user = await kvGet(kv, keys.user(userId));
  if (!user) return false;

  const indexedProjects = new Set();
  await forEachUserProject(kv, userId, async (projectId, indexKey) => {
    indexedProjects.add(projectId);
    await stopBackendRuntime(projectId);
    for (const siteKey of await kvListAll(kv, keys.sitePrefix(projectId))) {
      await kvDel(kv, siteKey);
    }
    await kvDel(kv, keys.siteMeta(projectId));
    await kvDel(kv, keys.project(projectId));
    await kvDel(kv, indexKey);
  });

  // 历史数据可能缺少 uproject_ 索引（早期 bug 或人工写入）。只删索引会留下
  // project_/site_ 孤儿记录，甚至继续可访问公开链接。按 project_ 反查 userId 兜底。
  const projectKeys = new Set(await kvListAll(kv, 'project_'));
  // DiskKV 暴露内存索引；EdgeOne KV 没有 index，必须保持纯 kv.list 路径可运行。
  if (kv.index instanceof Set) {
    for (const key of kv.index) {
      if (key.startsWith('project_')) projectKeys.add(key);
    }
  }
  for (const key of projectKeys) {
    const project = await kvGet(kv, key);
    if (!project || project.userId !== userId) continue;
    if (!indexedProjects.has(project.id)) {
      await stopBackendRuntime(project.id);
      for (const siteKey of await kvListAll(kv, keys.sitePrefix(project.id))) {
        await kvDel(kv, siteKey);
      }
      await kvDel(kv, keys.siteMeta(project.id));
      await kvDel(kv, keys.userProject(userId, project.id));
    }
    await kvDel(kv, key);
  }

  await revokeUserSessions(kv, userId);
  await kvDel(kv, keys.user(userId));
  return true;
}

/**
 * 彻底清空历史邮箱密码账号。
 * 只匹配 email_ userId 或带 password 字段的记录；
 * Apple/Google 用户即便共享邮箱也绝不会被误删。
 */
export async function purgePasswordUsers(kv) {
  let deleted = 0;
  for (const key of await kvListAll(kv, 'user_')) {
    const user = await kvGet(kv, key);
    if (!user) continue;
    if (!user.userId?.startsWith('email_') && !user.password) continue;
    if (await deleteUserAccount(kv, user.userId)) deleted += 1;
  }
  return deleted;
}
