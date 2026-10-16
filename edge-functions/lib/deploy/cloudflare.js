// Cloudflare Pages Direct Upload 适配器（备选线路）
// 文档：https://developers.cloudflare.com/pages/platform/direct-upload/
// 环境变量（EdgeOne 控制台配置，绝不进仓库）：
//   CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_PAGES_PROJECT
import { bytesToBase64 } from '../base64.js';

const CF_API = 'https://api.cloudflare.com/client/v4';

async function sha256Base64(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return bytesToBase64(new Uint8Array(digest));
}

/**
 * 直接上传文件到 Cloudflare Pages
 * @returns {Promise<{url: string, expiresAt: null}>}
 */
export async function deployToCloudflare({ apiToken, accountId, projectName, files }) {
  // 1. 获取上传 JWT
  const uploadTokenResponse = await fetch(
    `${CF_API}/accounts/${accountId}/pages/projects/${projectName}/uploads`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
    }
  );
  const uploadTokenJson = await uploadTokenResponse.json();
  if (!uploadTokenJson.success || !uploadTokenJson.result?.jwt) {
    throw Object.assign(new Error('CLOUDFLARE_UPLOAD_TOKEN_FAILED'), { code: 'STORAGE_ERROR' });
  }
  const jwt = uploadTokenJson.result.jwt;

  // 2. 直接上传文件（body 为 路径 → base64 的映射）
  const payload = {};
  for (const [path, bytes] of files) {
    const normalized = path.startsWith('/') ? path : `/${path}`;
    payload[normalized] = bytesToBase64(bytes);
  }
  const putResponse = await fetch(
    `${CF_API}/accounts/${accountId}/pages/projects/${projectName}/uploads`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }
  );
  const putJson = await putResponse.json();
  if (!putJson.success) {
    throw Object.assign(new Error('CLOUDFLARE_FILE_UPLOAD_FAILED'), { code: 'STORAGE_ERROR' });
  }

  // 3. 创建部署（manifest 值为 base64(sha256(文件内容))）
  const manifest = {};
  for (const [path, bytes] of files) {
    const normalized = path.startsWith('/') ? path : `/${path}`;
    manifest[normalized] = await sha256Base64(bytes);
  }
  const deployResponse = await fetch(
    `${CF_API}/accounts/${accountId}/pages/projects/${projectName}/deployments`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deployment_trigger: { type: 'upload', metadata: { branch: 'main' } },
        files: manifest,
      }),
    }
  );
  const deployJson = await deployResponse.json();
  if (!deployJson.success || !deployJson.result?.url) {
    throw Object.assign(new Error('CLOUDFLARE_DEPLOY_FAILED'), { code: 'STORAGE_ERROR' });
  }

  return { url: deployJson.result.url, expiresAt: null };
}
