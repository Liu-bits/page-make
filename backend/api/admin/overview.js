// GET /api/admin/overview — 后台总览（需 X-Admin-Token）
// 返回：账户统计 + 用户列表（含封禁状态）+ 项目统计 + 反馈列表
// 合规说明：仅显示 userId / 邮箱 / 项目元信息，不展示项目内容与密码
import { kvListAll } from '../../lib/kv.js';
import { ok, fail } from '../../lib/responses.js';
import { requireAdmin } from '../../lib/admin.js';

function publicUser(u) {
  return {
    userId: u.userId,
    email: u.email ?? null,
    isGuest: Boolean(u.userId?.startsWith('guest_')),
    isTest: Boolean(u.isTest),
    status: u.status ?? 'active',
    banLevel: u.banLevel ?? 0,
    banReason: u.banReason ?? null,
    banUntil: u.banUntil ?? null,
    createdAt: u.createdAt ?? null,
    projectCount: u._projectCount ?? 0,
  };
}

export async function onRequest(context) {
  const { request } = context;
  if (request.method !== 'GET') return fail('METHOD_NOT_ALLOWED', 405);
  const auth = await requireAdmin(context);
  if (auth.error) return auth.error;
  const { kv } = auth;

  // ---- 用户（user_ 前缀）----
  const users = [];
  const userKeys = await kvListAll(kv, 'user_');
  const projectCountByUser = new Map();

  // ---- 项目（project_ 前缀）----
  const projectKeys = await kvListAll(kv, 'project_');
  const projects = [];
  for (const key of projectKeys) {
    const p = await kv.get(key, { type: 'json' });
    if (!p) continue;
    projects.push({
      id: p.id,
      userId: p.userId,
      name: p.name ?? null,
      status: p.status,
      sourceType: p.sourceType ?? null,
      fileCount: p.fileCount ?? 0,
      size: p.size ?? 0,
      createdAt: p.createdAt ?? null,
      expiresAt: p.expiresAt ?? null,
    });
    if (p.userId) {
      projectCountByUser.set(p.userId, (projectCountByUser.get(p.userId) || 0) + 1);
    }
  }
  projects.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  for (const key of userKeys) {
    const u = await kv.get(key, { type: 'json' });
    if (!u) continue;
    u._projectCount = projectCountByUser.get(u.userId) || 0;
    users.push(publicUser(u));
  }
  users.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  // ---- 反馈（feedback_ 前缀）----
  const feedback = [];
  for (const key of await kvListAll(kv, 'feedback_')) {
    const f = await kv.get(key, { type: 'json' });
    if (f) feedback.push(f);
  }
  feedback.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  return ok({
    stats: {
      userCount: users.length,
      guestCount: users.filter((u) => u.isGuest).length,
      testCount: users.filter((u) => u.isTest).length,
      projectCount: projects.length,
      feedbackCount: feedback.length,
    },
    users: users.slice(0, 500),
    projects: projects.slice(0, 500),
    feedback: feedback.slice(0, 200),
  });
}
