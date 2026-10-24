// 根路径：服务信息
import { ok } from './lib/responses.js';

export async function onRequest() {
  return ok({
    service: 'page-make',
    description: '静态网页创作与分享服务',
  });
}
