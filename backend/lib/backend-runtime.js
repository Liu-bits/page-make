// =============================================================================
// 后端项目运行时（npm / pnpm）
//
// 职责：把 KV 里的源码落到持久卷 → 安装依赖 → 构建 → 常驻 Node 进程 → 反向代理。
//
// 只在容器环境可用（需要 node:child_process + 可写磁盘）。EdgeOne 之类边缘环境
// 会因为没有 Node 运行时直接返回不可用，不影响纯前端项目。
//
// 安全边界（这是「用户代码在本机执行」的能力，必须逐条守住）：
//   1. 只有 VIP 及以上能进到这里（调用方 quota/权限已拦，这里再兜一层）
//   2. 源码路径全部经 normalizeRelPath，禁止 .. / 绝对路径 / 控制字符
//   3. 子进程环境只给最小集合，不继承宿主的任何 token / 密钥
//   4. 安装与构建都有硬超时；进程堆上限受控
//   5. 同时常驻进程数有上限，超出拒绝新部署而不是把整机拖垮
// =============================================================================
import path from 'node:path';
import { spawn } from 'node:child_process';

import {
  BACKEND_INSTALL_TIMEOUT_MS,
  BACKEND_BUILD_TIMEOUT_MS,
  BACKEND_MAX_CONCURRENT,
  BACKEND_MAX_RESTARTS,
  BACKEND_MEMORY_MB,
  BACKEND_PORT_START,
} from './state.js';
import { normalizeRelPath, isValidRelPath } from './paths.js';
import { kvListAll, kvGet, keys, pathFromSiteKey } from './kv.js';
import { canUseBackend } from './tiers.js';

/** projectId → runtime 记录 */
const runtimes = new Map();
/** 已占用的内部端口 */
const usedPorts = new Set();
/** projectId → 部署队列尾；同一项目必须串行，避免两次发布各起一套进程 */
const deployQueues = new Map();

let nextPort = BACKEND_PORT_START;

const PROJECT_ID_RE = /^[a-f0-9]{32}$/;

function assertSafeProjectId(projectId) {
  if (typeof projectId !== 'string' || !PROJECT_ID_RE.test(projectId)) {
    throw Object.assign(new Error('INVALID_PROJECT_ID'), { code: 'BAD_REQUEST' });
  }
}

/**
 * 同一项目的部署串行执行。
 * 不同项目仍可并行；这里只消除「连续点两次发布 / 上传完成与手动发布重叠」
 * 导致两个进程、两个端口、后一个覆盖前一个记录的竞态。
 */
function serializeDeploy(projectId, task) {
  const previous = deployQueues.get(projectId) || Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  deployQueues.set(projectId, current);
  return current.finally(() => {
    if (deployQueues.get(projectId) === current) deployQueues.delete(projectId);
  });
}

async function allocatePort() {
  const net = await import('node:net');
  for (let i = 0; i < 200; i += 1) {
    const port = nextPort;
    nextPort += 1;
    if (nextPort > BACKEND_PORT_START + 500) nextPort = BACKEND_PORT_START;
    if (!usedPorts.has(port)) {
      // 进程内 usedPorts 只能防本项目重复分配；崩溃残留或外部进程仍可能占着端口。
      // 真正 bind 一次再释放，避免把旧进程误判成“新项目已启动”。
      const available = await new Promise((resolve) => {
        const probe = net.createServer();
        probe.once('error', () => resolve(false));
        probe.listen({ host: '127.0.0.1', port }, () => {
          probe.close(() => resolve(true));
        });
      });
      if (!available) continue;
      usedPorts.add(port);
      return port;
    }
  }
  throw Object.assign(new Error('NO_FREE_PORT'), { code: 'RUNTIME_BUSY' });
}

function releasePort(port) {
  if (typeof port === 'number') usedPorts.delete(port);
}

/** 真正占用运行时名额的状态；failed/stopped 记录不能继续挤占并发上限 */
function activeRuntimeCount() {
  return [...runtimes.values()].filter((record) => (
    record.status === 'starting'
    || record.status === 'running'
    || record.status === 'restarting'
  )).length;
}

/**
 * 结束整棵子进程树。
 *
 * npm/pnpm start 往往会先启动一个包装进程，再拉起真正的 Node 服务；
 * 只 kill 直接子进程会留下孙进程继续占用端口。Linux 用独立进程组发信号，
 * Windows 用 taskkill /T，确保安装、构建和常驻服务都不会泄漏。
 */
async function terminateProcessTree(child, signal = 'SIGTERM') {
  if (!child || typeof child.pid !== 'number') return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.on('error', resolve);
      killer.on('close', resolve);
    });
    return;
  }

  try {
    // spawn(..., { detached: true }) 让子进程成为独立进程组组长，
    // 负 PID 可以把 npm 拉起的 Node 服务一起结束。
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* 已退出 */ }
  }
}

/** 数据根目录：容器里由 DATA_DIR 指定；未设置时视为不支持运行时 */
function dataDir() {
  return process.env.DATA_DIR || null;
}

export function runtimeAvailable() {
  return Boolean(dataDir());
}

/** 某项目的源码根目录 */
export function appDir(projectId) {
  assertSafeProjectId(projectId);
  const root = dataDir();
  if (!root) throw Object.assign(new Error('RUNTIME_UNAVAILABLE'), { code: 'RUNTIME_UNAVAILABLE' });
  return path.join(root, 'apps', projectId);
}

/**
 * 把 KV 里的源码写到磁盘（覆盖式：先清空 src/，避免旧文件残留）。
 * @returns {Promise<{dir: string, files: number, bytes: number}>}
 */
export async function materialize(kv, projectId) {
  const nodeFs = await import('node:fs/promises');
  const root = appDir(projectId);
  const srcDir = path.join(root, 'src');

  await nodeFs.rm(srcDir, { recursive: true, force: true });
  await nodeFs.mkdir(srcDir, { recursive: true });

  const keyList = await kvListAll(kv, keys.sitePrefix(projectId));
  let files = 0;
  let bytes = 0;
  for (const key of keyList) {
    const raw = pathFromSiteKey(key);
    const rel = normalizeRelPath(raw);
    if (!rel || rel !== raw || !isValidRelPath(rel) || rel.includes(':')) {
      // 归一后路径变了说明原始路径可疑（../、绝对路径等），后端项目一律拒绝落盘
      throw Object.assign(new Error(`UNSAFE_PATH:${raw}`), { code: 'BAD_ZIP' });
    }
    const target = path.join(srcDir, ...rel.split('/'));
    // 双保险：解析后的绝对路径必须仍在 src 内
    if (!target.startsWith(srcDir + path.sep) && target !== srcDir) {
      throw Object.assign(new Error(`PATH_ESCAPE:${rel}`), { code: 'BAD_ZIP' });
    }
    const data = await kv.get(key, { type: 'arrayBuffer' });
    if (!data) continue;
    await nodeFs.mkdir(path.dirname(target), { recursive: true });
    await nodeFs.writeFile(target, Buffer.from(data));
    files += 1;
    bytes += data.byteLength;
  }
  return { dir: srcDir, files, bytes };
}

/** 读取 package.json（不存在返回 null） */
async function readPackageJson(srcDir) {
  const nodeFs = await import('node:fs/promises');
  try {
    const text = await nodeFs.readFile(path.join(srcDir, 'package.json'), 'utf8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 跑一条命令，带超时；返回 { code, stdout, stderr, timedOut } */
function run(command, args, options = {}) {
  const { cwd, timeoutMs = 120_000, env = {}, shell = false } = options;
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let forceDoneTimer = null;

    // 子进程环境只给最小集合：不继承宿主环境，避免把宿主的密钥/Token 泄给用户代码
    const childEnv = {
      PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      HOME: cwd,
      NODE_ENV: 'production',
      CI: '1',
      npm_config_fund: 'false',
      npm_config_audit: 'false',
      npm_config_update_notifier: 'false',
      ...env,
    };

    const child = spawn(command, args, {
      cwd,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell,
      detached: process.platform !== 'win32',
    });

    const cap = (chunk) => {
      const text = chunk.toString();
      if (stdout.length < 64 * 1024) stdout += text;
      if (stderr.length < 64 * 1024) stderr += text;
    };
    child.stdout?.on('data', cap);
    child.stderr?.on('data', cap);

    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child, 'SIGKILL').catch(() => {
        try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
      });
      // 极少数容器里 taskkill/kill 也可能卡住；不能让发布任务永久悬挂。
      forceDoneTimer = setTimeout(() => done(-1), 5000);
    }, timeoutMs);

    const done = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceDoneTimer) clearTimeout(forceDoneTimer);
      resolve({ code, stdout, stderr, timedOut });
    };
    child.on('error', (error) => {
      stderr += String(error?.message || error);
      done(-1);
    });
    child.on('close', (code) => done(typeof code === 'number' ? code : -1));
  });
}

/**
 * 包管理器可执行文件。
 * Windows 上 npm/pnpm 是 .cmd 包装脚本，`spawn('npm')` 会 ENOENT，
 * 必须走 shell 并给完整路径；容器（Linux）里直接调同名命令即可。
 */
function pmBinary(kind) {
  const name = kind === 'pnpm' ? 'pnpm' : 'npm';
  if (process.platform !== 'win32') return { command: name, shell: false };
  const exeDir = path.dirname(process.execPath);
  return { command: `"${path.join(exeDir, `${name}.cmd`)}"`, shell: true };
}

/**
 * 安装依赖。
 * 用 --omit=dev / --prod：生产容器里不装 devDependencies，省时间省磁盘。
 * 若项目没有 package.json，直接失败（后端项目必须有）。
 */
async function installDeps(kind, srcDir) {
  const bin = pmBinary(kind);
  // 构建脚本通常依赖 devDependencies（vite/typescript/webpack 等）。
  // 只装生产依赖会让 `npm run build` 在发布阶段必然缺工具，因此先装完整依赖；
  // 用户代码本来就会在同一受限子进程中执行，这里不额外承诺 npm 层面的隔离。
  const args = kind === 'pnpm' ? ['install'] : ['install', '--no-package-lock'];
  return run(bin.command, args, {
    cwd: srcDir,
    timeoutMs: BACKEND_INSTALL_TIMEOUT_MS,
    shell: bin.shell,
  });
}

/** 若 package.json 定义了 build 脚本则执行 */
async function runBuild(kind, srcDir, pkg) {
  if (!pkg?.scripts?.build) return { skipped: true };
  const bin = pmBinary(kind);
  const result = await run(bin.command, ['run', 'build'], {
    cwd: srcDir,
    timeoutMs: BACKEND_BUILD_TIMEOUT_MS,
    shell: bin.shell,
  });
  return { skipped: false, ...result };
}

/** 等端口可连（最多 timeoutMs） */
async function waitForPort(port, timeoutMs = 60_000, record = null) {
  const net = await import('node:net');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (record?.startFailed || record?.status === 'failed') return false;
    const ok = await new Promise((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on('error', () => {
        socket.destroy();
        resolve(false);
      });
      socket.setTimeout(1500, () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** 决定启动方式：优先 npm/pnpm start，其次 package.json main，最后常见入口文件 */
async function resolveStartCommand(kind, srcDir, pkg) {
  const nodeFs = await import('node:fs/promises');
  if (pkg?.scripts?.start) {
    const bin = pmBinary(kind);
    return { command: bin.command, args: ['start'], shell: bin.shell };
  }
  if (typeof pkg?.main === 'string' && pkg.main) {
    if (!isValidRelPath(pkg.main) || pkg.main.includes(':')) return null;
    return { command: process.execPath, args: [pkg.main], shell: false };
  }
  for (const candidate of ['server.js', 'index.js', 'app.js', 'main.js']) {
    try {
      await nodeFs.access(path.join(srcDir, candidate));
      return { command: process.execPath, args: [candidate], shell: false };
    } catch { /* 继续找 */ }
  }
  return null;
}

/** 启动常驻进程 */
async function spawnServer(record, command, args, shell = false) {
  const child = spawn(command, args, {
    cwd: record.srcDir,
    env: {
      PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      HOME: record.srcDir,
      NODE_ENV: 'production',
      PORT: String(record.port),
      HOST: '127.0.0.1',
      // 堆上限：防止单个用户项目吃光整机内存
      NODE_OPTIONS: `--max-old-space-size=${BACKEND_MEMORY_MB}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell,
      // 非 Windows 上建立独立进程组，stop 时才能连同 npm/pnpm 拉起的
      // 孙进程一起结束；Windows 由 taskkill /T 负责。
      detached: process.platform !== 'win32',
  });

  record.child = child;
  record.logs = '';
  const collect = (chunk) => {
    if (record.logs.length < 16 * 1024) record.logs += chunk.toString();
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);

  // spawn 失败（例如命令不存在）会发 error 事件；不监听会让 Node 进程
  // 直接抛出未处理事件。这里把它收敛成可轮询的 failed 状态。
  child.on('error', (error) => {
    record.startFailed = true;
    record.child = null;
    record.status = record.stopping ? 'stopped' : 'failed';
    record.errorCode = 'RUNTIME_UNAVAILABLE';
    record.lastError = String(error?.message || error);
  });

  child.on('exit', (code, signal) => {
    record.child = null;
    record.lastExit = { code, signal, at: Date.now() };
    if (record.startFailed) {
      record.status = 'failed';
      return;
    }
    if (record.stopping) {
      record.status = 'stopped';
      return;
    }
    // 崩溃自动重启，超过上限标记 failed，避免无限重启风暴
    if (record.restarts < BACKEND_MAX_RESTARTS) {
      record.restarts += 1;
      record.status = 'restarting';
      setTimeout(() => {
        if (record.stopping) return;
        spawnServer(record, record.command, record.args, record.shell).catch(() => {
          record.status = 'failed';
        });
      }, 1000 * record.restarts);
    } else {
      record.status = 'failed';
      record.errorCode = 'RUNTIME_CRASHED';
      releasePort(record.port);
    }
  });
}

/** 停掉某项目进程并释放端口 */
export async function stop(projectId) {
  const record = runtimes.get(projectId);
  if (!record) return false;
  record.stopping = true;
  if (record.child) {
    await terminateProcessTree(record.child, 'SIGTERM');
    // 给服务 800ms 优雅退出；仍在跑就强制结束整棵树。
    await new Promise((r) => setTimeout(r, 800));
    if (record.child) await terminateProcessTree(record.child, 'SIGKILL');
    // 再等一小段时间让 exit 事件落状态，避免调用方马上复用端口。
    await new Promise((r) => setTimeout(r, 150));
  }
  releasePort(record.port);
  runtimes.delete(projectId);
  return true;
}

/** 进程退出前回收全部常驻项目，避免本地调试/优雅停机留下孙进程。 */
export async function stopAll() {
  const ids = [...runtimes.keys()];
  for (const projectId of ids) {
    await stop(projectId);
  }
  return ids.length;
}

/** 当前所有后端项目运行状态（诊断用） */
export function runtimeStatus() {
  return [...runtimes.entries()].map(([projectId, r]) => ({
    projectId,
    status: r.status,
    port: r.port,
    restarts: r.restarts,
    errorCode: r.errorCode ?? null,
  }));
}

/**
 * 完整部署一个后端项目：落盘 → 安装 → 构建 → 启动 → 等端口。
 * 失败时抛错（带 code），调用方负责写 failed 状态。
 * @returns {Promise<{port:number, kind:string, files:number, bytes:number}>}
 */
export function deployBackendApp(args) {
  assertSafeProjectId(args?.projectId);
  return serializeDeploy(args.projectId, () => deployBackendAppNow(args));
}

async function deployBackendAppNow({ kv, projectId, kind }) {
  if (!runtimeAvailable()) {
    throw Object.assign(new Error('RUNTIME_UNAVAILABLE'), { code: 'RUNTIME_UNAVAILABLE' });
  }
  if (activeRuntimeCount() >= BACKEND_MAX_CONCURRENT && !runtimes.has(projectId)) {
    throw Object.assign(new Error('RUNTIME_BUSY'), { code: 'RUNTIME_BUSY' });
  }

  // 重新部署先停旧进程
  await stop(projectId);

  const { dir: srcDir, files, bytes } = await materialize(kv, projectId);
  const pkg = await readPackageJson(srcDir);
  if (!pkg) {
    throw Object.assign(new Error('MISSING_PACKAGE_JSON'), { code: 'MISSING_PACKAGE_JSON' });
  }

  const installed = await installDeps(kind, srcDir);
  if (installed.code !== 0) {
    throw Object.assign(new Error(installed.timedOut ? 'INSTALL_TIMEOUT' : 'INSTALL_FAILED'), {
      code: installed.timedOut ? 'INSTALL_TIMEOUT' : 'INSTALL_FAILED',
      detail: installed.stderr.slice(-2000),
    });
  }

  const built = await runBuild(kind, srcDir, pkg);
  if (!built.skipped && built.code !== 0) {
    throw Object.assign(new Error(built.timedOut ? 'BUILD_TIMEOUT' : 'BUILD_FAILED'), {
      code: built.timedOut ? 'BUILD_TIMEOUT' : 'BUILD_FAILED',
      detail: String(built.stderr || '').slice(-2000),
    });
  }

  const startCommand = await resolveStartCommand(kind, srcDir, pkg);
  if (!startCommand) {
    throw Object.assign(new Error('NO_START_SCRIPT'), { code: 'NO_START_SCRIPT' });
  }

  const port = await allocatePort();
  const record = {
    projectId,
    kind,
    srcDir,
    port,
    child: null,
    status: 'starting',
    restarts: 0,
    logs: '',
    stopping: false,
    command: startCommand.command,
    args: startCommand.args,
    shell: startCommand.shell === true,
    startedAt: Date.now(),
  };
  runtimes.set(projectId, record);

  await spawnServer(record, startCommand.command, startCommand.args, record.shell);
  const ready = await waitForPort(port, 60_000, record);
  if (!ready) {
    await stop(projectId);
    throw Object.assign(new Error('START_TIMEOUT'), {
      code: 'START_TIMEOUT',
      detail: record.logs.slice(-2000),
    });
  }
  record.status = 'running';
  return { port, kind, files, bytes };
}

/** 容器启动时把已发布的后端项目重新拉起（持久卷里的源码还在） */
export async function restoreAll(kv) {
  const projectKeys = await kvListAll(kv, 'project_');
  let restored = 0;
  for (const key of projectKeys) {
    const project = await kvGet(kv, key);
    if (!project) continue;
    const kind = project.kind;
    if (kind !== 'npm' && kind !== 'pnpm') continue;
    if (project.status !== 'ready') continue;
    // 降级后的账号不能靠容器重启重新获得后端运行权益。
    const owner = await kvGet(kv, keys.user(project.userId));
    if (!owner || !canUseBackend(owner)) continue;
    try {
      await deployBackendApp({ kv, projectId: project.id, kind });
      restored += 1;
    } catch (error) {
      // 并发上限只表示暂时排不上，不应把项目永久标成 failed。
      if (error?.code !== 'RUNTIME_BUSY') {
        project.status = 'failed';
        project.errorCode = error?.code || 'RUNTIME_UNAVAILABLE';
      } else {
        project.errorCode = 'RUNTIME_BUSY';
      }
      const { kvPut } = await import('./kv.js');
      await kvPut(kv, key, project);
    }
  }
  return restored;
}

/** 某项目进程是否在跑 */
export function isRunning(projectId) {
  const record = runtimes.get(projectId);
  return Boolean(record && record.status === 'running' && record.child);
}

export function portOf(projectId) {
  return runtimes.get(projectId)?.port ?? null;
}

/**
 * 反向代理一次 HTTP 请求到项目进程。
 * 返回 Web Response（调用方直接 return）。
 */
export async function proxy(projectId, request) {
  const record = runtimes.get(projectId);
  if (!record || record.status !== 'running') {
    return null;
  }
  const http = await import('node:http');
  const url = new URL(request.url);
  const publicPrefix = `/p/${projectId}`;
  // 用户代码通常写 app.get('/api/...')，不能要求每个框架都认识 /p/<id> 前缀。
  // 对外保留项目链接不变，转发前剥掉前缀；同时把原前缀放进标准代理头，
  // 需要生成绝对链接的框架仍能正确还原公开地址。
  let upstreamPath = url.pathname;
  if (upstreamPath === publicPrefix) {
    upstreamPath = '/';
  } else if (upstreamPath.startsWith(`${publicPrefix}/`)) {
    upstreamPath = upstreamPath.slice(publicPrefix.length);
  }
  const headers = {};
  for (const [name, value] of request.headers.entries()) {
    // Host 必须改成上游，否则部分框架会拒绝或生成错误链接
    if (name.toLowerCase() === 'host') continue;
    headers[name] = value;
  }
  headers.host = `127.0.0.1:${record.port}`;
  headers['x-forwarded-prefix'] = publicPrefix;

  let body = null;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const buffer = await request.arrayBuffer();
    body = Buffer.from(buffer);
    headers['content-length'] = String(body.length);
  }

  return new Promise((resolve) => {
    const upstream = http.request(
      {
        host: '127.0.0.1',
        port: record.port,
        method: request.method,
        path: `${upstreamPath}${url.search}`,
        headers,
        timeout: 30_000,
      },
      (res) => {
        const chunks = [];
        let total = 0;
        const MAX = 20 * 1024 * 1024;
        res.on('data', (chunk) => {
          total += chunk.length;
          if (total > MAX) {
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const responseHeaders = {};
          for (const [name, value] of Object.entries(res.headers)) {
            if (value === undefined) continue;
            // 逐跳头不能透传
            if (['connection', 'keep-alive', 'transfer-encoding', 'upgrade'].includes(name.toLowerCase())) continue;
            responseHeaders[name] = Array.isArray(value) ? value.join(', ') : value;
          }
          resolve(new Response(Buffer.concat(chunks), {
            status: res.statusCode || 200,
            headers: responseHeaders,
          }));
        });
        res.on('error', () => resolve(null));
      }
    );
    upstream.on('error', () => resolve(null));
    upstream.on('timeout', () => {
      upstream.destroy();
      resolve(null);
    });
    if (body) upstream.write(body);
    upstream.end();
  });
}
