// POST /p/<projectId>/__unlock — 站点访问密码解锁
//
// 项目开了访问密码后，/p/<id> 与子资源都会被门禁拦住并跳到密码输入页；
// 这里接收表单提交，校验通过则发签名 cookie（HttpOnly、Path=/p/<id>、7 天），
// 然后把浏览器带回去看内容。
//
// 注意：
// - 这是公开接口（访问者没有账号），所以不复用用户会话，只认项目密码；
// - 错误不直接给 401 JSON，而是 302 回门禁页并带 ?e=1（浏览器表单场景需要可见反馈）；
// - 密码错误必须做与登录一致的防爆破处理：按 IP 限流，5 次/分钟。

import { kvGet, keys } from '../../lib/kv.js';
import { verifyPassword } from '../../lib/password.js';
import { rateLimited, clientIp } from '../../lib/ratelimit.js';
import { isUnlocked, unlockCookieHeader } from '../../lib/access-gate.js';

const ID_RE = /^[a-f0-9]{32}$/;

export async function onRequest(context) {
  const { request, params } = context;
  const id = params?.projectId;
  if (!ID_RE.test(id)) return new Response('Not Found', { status: 404 });

  const kv = context.env?.PAGEMAKE;
  if (!kv) return new Response('Not Found', { status: 404 });

  const project = await kvGet(kv, keys.project(id));
  // 项目不存在 / 没开密码：没有可解锁的东西，直接回首页（不给枚举信息）
  if (!project || !project.passwordHash) {
    return new Response(null, { status: 302, headers: { Location: `/p/${id}` } });
  }

  // 已经解锁过：直接放行回去，不用再校验一次密码
  if (await isUnlocked(kv, id, request, project.passwordHash)) {
    return new Response(null, { status: 302, headers: { Location: `/p/${id}` } });
  }

  // 防爆破：访问者没有账号，只能按 IP 限速。
  // 若网关不透传 IP（clientIp 返回 'local'），全站会共用一个桶——那会把限流键
  // 降级成「每个项目一桶」（而不是全站一桶），并叠加每项目 30 次/分的项目级上限。
  // 加上 PBKDF2 60 万轮的单次校验成本，暴力破解没有实际空间。
  const ip = clientIp(request);
  const perIpKey = ip === 'local' ? `unlock:${id}` : `unlock:${ip}`;
  if (rateLimited(perIpKey, 5, 60_000) || rateLimited(`unlock:proj:${id}`, 30, 60_000)) {
    return new Response('Too Many Requests', { status: 429 });
  }

  let password = '';
  const contentType = (request.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('application/x-www-form-urlencoded')) {
    const form = new URLSearchParams(await request.text());
    password = form.get('password') || '';
  } else if (contentType.includes('application/json')) {
    try {
      const body = await request.json();
      password = typeof body?.password === 'string' ? body.password : '';
    } catch {
      password = '';
    }
  }

  const ok = password.length > 0 && password.length <= 128
    && await verifyPassword(password, project.passwordHash);

  if (!ok) {
    // 302 回门禁页并带 ?e=1 显示「密码不正确」
    return new Response(null, {
      status: 302,
      headers: { Location: `/p/${id}?e=1` },
    });
  }

  const cookie = await unlockCookieHeader(kv, id, project.passwordHash);
  return new Response(null, {
    status: 302,
    headers: {
      Location: `/p/${id}`,
      'Set-Cookie': cookie,
      'Cache-Control': 'no-store',
    },
  });
}
