// PHP 运行时：把项目文件物化到磁盘 → php-cgi 执行 → 解析 CGI 响应
// 说明：容器内由 Dockerfile 安装 php83-cgi（php-cgi 二进制）；未安装时优雅降级为提示页。
// 安全加固：disable_functions 禁进程执行族、open_basedir 限定项目目录、禁远程包含、关 display_errors。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { kvListAll, keys, pathFromSiteKey } from './kv.js';
import { rewriteLocalRefs } from './paths.js';

const PHP_TIMEOUT_MS = 10_000;      // 单次 PHP 执行超时
const PHP_MAX_OUTPUT = 2 * 1024 * 1024; // 输出上限 2MB
const RUNTIME_DIRNAME = 'php-runtime';

// php-cgi 二进制探测（容器内通常在 PATH；兜底常见绝对路径），结果缓存
let cachedPhpBinary;
function phpBinary() {
  if (cachedPhpBinary !== undefined) return cachedPhpBinary;
  const candidates = [
    'php-cgi',
    '/usr/bin/php-cgi',
    '/usr/local/bin/php-cgi',
    'php83-cgi',
    'php84-cgi',
  ];
  for (const bin of candidates) {
    try {
      const probe = spawnSync(bin, ['-v'], { timeout: 3000 });
      if (probe.status === 0 || (probe.stdout || '').toString().includes('PHP')) {
        cachedPhpBinary = bin;
        return cachedPhpBinary;
      }
    } catch {
      // ENOENT 等，继续尝试下一个
    }
  }
  cachedPhpBinary = null;
  return cachedPhpBinary;
}

export function phpAvailable() {
  return phpBinary() !== null;
}

/** 相对路径安全检查（物化与执行双重校验） */
function safeRel(rel) {
  if (typeof rel !== 'string' || !rel || rel.length > 200) return false;
  if (rel.includes('\\') || rel.startsWith('/') || rel.endsWith('/')) return false;
  if (/[\u0000-\u001f]/.test(rel)) return false;
  const parts = rel.split('/');
  return parts.every((p) => p && p !== '.' && p !== '..');
}

/**
 * 物化项目文件到磁盘：DATA_DIR/php-runtime/<projectId>/
 * 以 project.updatedAt 为版本戳，项目未变化时直接复用（避免每次请求都重建）
 */
async function materializeProject(kv, project, dataDir) {
  const root = path.join(dataDir, RUNTIME_DIRNAME, project.id);
  const stampFile = path.join(root, '.pagemake-stamp');
  const stamp = String(project.updatedAt ?? '0');

  if (fs.existsSync(stampFile)) {
    try {
      if (fs.readFileSync(stampFile, 'utf8').trim() === stamp) return root;
    } catch {
      // 读取失败则重建
    }
  }

  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  // 临时目录（open_basedir 内）：php 的 sys_temp_dir / upload_tmp_dir
  fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });

  const keyList = await kvListAll(kv, keys.sitePrefix(project.id));
  for (const key of keyList) {
    const rel = pathFromSiteKey(key);
    if (!safeRel(rel)) continue; // 跳过不安全路径（zip 内可能夹带）
    const bytes = await kv.get(key, { type: 'arrayBuffer' });
    if (!bytes) continue;
    const target = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(bytes));
  }

  fs.writeFileSync(stampFile, stamp, 'utf8');
  return root;
}

/** CGI 头解析：stdout → { status, headers, body } */
function parseCgiOutput(stdout) {
  const sep = stdout.indexOf('\r\n\r\n');
  const fallbackSep = stdout.indexOf('\n\n');
  const idx = sep >= 0 ? sep : fallbackSep;
  if (idx < 0) {
    // 无响应头：当作纯 body（text/html）
    return { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: stdout };
  }
  const sepLen = sep >= 0 ? 4 : 2;
  const headText = stdout.slice(0, idx);
  const body = stdout.slice(idx + sepLen);
  const headers = {};
  let status = 200;
  for (const line of headText.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (name === 'status') {
      const parsed = parseInt(value, 10);
      if (Number.isFinite(parsed)) status = parsed;
    } else if (value) {
      headers[name] = value;
    }
  }
  if (!headers['content-type']) headers['content-type'] = 'text/html; charset=utf-8';
  return { status, headers, body };
}

/**
 * 归一 PHP 输出里的本地资源引用（../style.css → style.css）
 *
 * PHP 页面被直接请求为 /p/<id>/x.php，若它输出 `../style.css`，
 * 浏览器会解析成 /p/style.css（跳出 /p/ 前缀）→ 404 断链。
 * 仅当响应明确是 text/html 时才改写：PHP 也可能返回 JSON/CSS/图片等，
 * 改写非 HTML 响应会直接破坏内容。body 非字符串（二进制）一律跳过。
 */
function normalizePhpOutput(parsed) {
  const contentType = String(parsed.headers?.['content-type'] || '');
  if (!/text\/html/i.test(contentType)) return parsed;
  if (typeof parsed.body !== 'string') return parsed;
  // 输出上限 2MB，正则扫描开销可接受；HTML 里没有本地引用时 rewriteLocalRefs 原样返回
  return { ...parsed, body: rewriteLocalRefs(parsed.body) };
}

/** PHP 不可用时的提示页 */
function phpUnavailablePage() {
  return new Response(
    `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>PHP 不可用</title></head>` +
    `<body style="font-family:-apple-system,sans-serif;text-align:center;padding:48px;color:#334155">` +
    `<h1>PHP 运行时未安装</h1><p>容器缺少 php-cgi，无法执行 .php 文件（静态资源不受影响）。</p></body></html>`,
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

/**
 * 执行项目内的 PHP 文件
 * @param {object} args { kv, project, rel, request }
 * @returns {Response}
 */
export async function runPhp(args) {
  const { kv, project, rel, request } = args;

  if (!phpAvailable()) return phpUnavailablePage();
  if (!safeRel(rel) || !/\.php$/i.test(rel)) {
    return new Response('Forbidden', { status: 403, headers: { 'Content-Type': 'text/plain' } });
  }

  const dataDir = process.env.DATA_DIR || '/tmp/pagemake-data';
  let root;
  try {
    root = await materializeProject(kv, project, dataDir);
  } catch (error) {
    return new Response(`PHP materialize error: ${error.message}`, {
      status: 500,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  const url = new URL(request.url);
  const binary = phpBinary();
  const bodyBuffer = Buffer.from(await request.arrayBuffer());

  const env = {
    ...process.env,
    REDIRECT_STATUS: '200',
    GATEWAY_INTERFACE: 'CGI/1.1',
    SERVER_PROTOCOL: 'HTTP/1.1',
    REQUEST_METHOD: request.method,
    REQUEST_URI: url.pathname + url.search,
    SCRIPT_NAME: `/${rel}`,
    SCRIPT_FILENAME: path.join(root, ...rel.split('/')),
    DOCUMENT_ROOT: root,
    QUERY_STRING: url.search.replace(/^\?/, ''),
    CONTENT_LENGTH: String(bodyBuffer.length),
    REMOTE_ADDR: '127.0.0.1',
  };
  const contentType = request.headers.get('content-type');
  if (contentType) env.CONTENT_TYPE = contentType;
  for (const name of ['user-agent', 'cookie', 'accept', 'referer']) {
    const value = request.headers.get(name);
    if (value) env[`HTTP_${name.replace(/-/g, '_').toUpperCase()}`] = value;
  }

  return await new Promise((resolve) => {
    let settled = false;
    const done = (response) => {
      if (!settled) {
        settled = true;
        resolve(response);
      }
    };

    const child = spawn(binary, [
      '-q',
      '-d', 'display_errors=0',
      '-d', 'log_errors=0',
      '-d', 'allow_url_fopen=0',
      '-d', 'allow_url_include=0',
      '-d', `open_basedir=${root}`,
      '-d', `sys_temp_dir=${path.join(root, '.tmp')}`,
      '-d', `upload_tmp_dir=${path.join(root, '.tmp')}`,
      '-d', 'disable_functions=exec,shell_exec,system,passthru,proc_open,popen,proc_close,proc_get_status,proc_nice,proc_terminate,putenv,dl,link,symlink,chown,chgrp,chmod',
      env.SCRIPT_FILENAME,
    ], { env, cwd: root });

    let stdout = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, PHP_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      if (stdout.length < PHP_MAX_OUTPUT) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      // 静默记录到容器日志（server.mjs 已转发 stderr 前缀）
      process.stderr.write(`[php] ${project.id} ${rel}: ${chunk}`);
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      cachedPhpBinary = undefined; // 二进制可能失效，下次重新探测
      done(new Response(`PHP error: ${error.message}`, {
        status: 500,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      }));
    });

    child.on('close', () => {
      clearTimeout(timer);
      if (killed) {
        done(new Response('PHP execution timed out (10s)', {
          status: 504,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        }));
        return;
      }
      const { status, headers, body } = normalizePhpOutput(parseCgiOutput(stdout));
      const safeStatus = Number.isFinite(status) && status >= 200 && status < 600 ? status : 200;
      done(new Response(body, {
        status: safeStatus,
        headers: {
          ...headers,
          'Cache-Control': 'no-store',
        },
      }));
    });

    if (bodyBuffer.length > 0) child.stdin.write(bodyBuffer);
    child.stdin.end();
  });
}
