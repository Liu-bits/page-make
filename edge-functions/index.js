// 根路径：服务信息
import { ok } from './lib/responses.js';

export async function onRequest() {
  return ok({
    service: 'page-make',
    description: '静态网页托管服务（iOS + EdgeOne Pages Functions）',
    docs: 'https://github.com/Liu-bits/page-make',
  });
}
