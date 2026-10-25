// =============================================================================
// 静态检查：所有 backend 模块「被调用但未 import / 未定义」的标识符
// 背景：AGENTS 第 8 节记的 apply_patch 静默失败坑，会让 import 行没进去而
//      调用点已经在用 → 本地 node -e import 模块不会报错（ESM 绑定是惰性的，
//      import 成功只代表语法和路径解析通过），只有真正调用到该函数时才
//      ReferenceError → 容器 catch 全部 500 INTERNAL_ERROR，App 侧只看到
//      一个 INTERNAL_ERROR 码，完全定位不到根因。
//      2026-10-25 实例：backend/api/auth/google.js 用了 isVIPUser 但漏 import
//      → Google 登录 100% 500，而 OAuth 网页/邮件全都正常。
// 运行：node dev/check-handler-imports.mjs
// =============================================================================
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('backend');

const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) { walk(p); continue; }
    if (p.endsWith('.js')) files.push(p);
  }
})(ROOT);

// 全局/内建对象与关键字：调用形态 `xxx(` 但不需要 import
const GLOBALS = new Set([
  // 关键字与控制流（(^|[^\w$.]) 过滤后仍可能漏进来的形式）
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'await', 'new',
  'of', 'in', 'do', 'else', 'try', 'finally', 'throw', 'void', 'delete', 'instanceof',
  'case', 'break', 'continue', 'default', 'const', 'let', 'var', 'class', 'extends',
  'super', 'this', 'import', 'export', 'from', 'as', 'async', 'yield', 'static', 'get',
  'set', 'constructor',
  // 内建全局
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Math', 'JSON', 'Date', 'RegExp',
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'Map', 'Set', 'WeakMap', 'WeakSet',
  'Promise', 'Symbol', 'BigInt', 'Proxy', 'Reflect', 'TextEncoder', 'TextDecoder',
  'URL', 'URLSearchParams', 'URLPattern', 'AbortSignal', 'AbortController', 'fetch',
  'Response', 'Request', 'Headers', 'Blob', 'File', 'FormData', 'ReadableStream',
  'DecompressionStream', 'CompressionStream', 'structuredClone', 'console', 'crypto',
  'btoa', 'atob', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent',
  'decodeURIComponent', 'encodeURI', 'decodeURI', 'setTimeout', 'clearTimeout',
  'setInterval', 'clearInterval', 'queueMicrotask', 'Buffer', 'process', 'globalThis',
  'undefined', 'null', 'true', 'false', 'NaN', 'Infinity', 'Uint8Array', 'Uint8ClampedArray',
  'Int8Array', 'Uint16Array', 'Int16Array', 'Uint32Array', 'Int32Array', 'Float32Array',
  'Float64Array', 'ArrayBuffer', 'DataView', 'BigInt64Array', 'BigUint64Array',
  'require', 'module', 'exports', '__dirname', '__filename', 'arguments',
]);

function collectImports(src) {
  const imported = new Set();
  const importRe = /import\s+(?:([\w$]+)\s*,\s*)?(?:\{([^}]*)\}|\*\s+as\s+([\w$]+)|([\w$]+))?\s*from/g;
  let m;
  while ((m = importRe.exec(src))) {
    if (m[1]) imported.add(m[1]);
    if (m[4]) imported.add(m[4]);
    if (m[2]) {
      for (const piece of m[2].split(',')) {
        const part = piece.trim();
        if (!part) continue;
        const asMatch = /^([\w$]+)\s+as\s+([\w$]+)$/.exec(part);
        imported.add(asMatch ? asMatch[2] : part);
      }
    }
  }
  return imported;
}

// 去掉注释与字符串字面量：文案里的英文单词不该被当成函数调用
function stripLiterals(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1 ')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``');
}

// 收集本文件内的「本地绑定」：声明 + 解构 + 函数参数
// 参数必须收：`await fn(x)` 里的 fn 常是外层回调参数（如 admin-users.js 的
// scanUsers(async (key) => { await fn(...) })），漏收会误报。
function collectLocalNames(src) {
  const local = new Set();
  const declRe = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g;
  let m;
  while ((m = declRe.exec(src))) local.add(m[1]);
  const destructureRe = /\b(?:const|let|var)\s*\{([^}]*)\}/g;
  while ((m = destructureRe.exec(src))) {
    for (const piece of m[1].split(',')) {
      const part = piece.split(':').pop().trim().replace(/^\.\.\./, '');
      if (/^[A-Za-z_$][\w$]*$/.test(part)) local.add(part);
    }
  }
  // 函数/方法/箭头函数的参数名（含默认值与解构）
  const paramRe = /(?:function\s*\*?\s*[\w$]*\s*|function\s*\*?\s*[\w$]*\s*|=>\s*)\(([^)]*)\)|\(\s*([^)]*)\s*\)\s*(?:=>|\{)/g;
  while ((m = paramRe.exec(src))) {
    for (const raw of (m[1] || m[2] || '').split(',')) {
      const part = raw.split('=')[0].trim().replace(/^\.\.\./, '');
      const name = part.includes(':') ? part.split(':').pop().trim() : part;
      const inner = /\{([^}]*)\}/.exec(name);
      if (inner) {
        for (const piece of inner[1].split(',')) {
          const p2 = piece.split(':').pop().trim().replace(/^\.\.\./, '');
          if (/^[A-Za-z_$][\w$]*$/.test(p2)) local.add(p2);
        }
      } else if (/^[A-Za-z_$][\w$]*$/.test(name)) {
        local.add(name);
      }
    }
  }
  // 对象字面量方法定义 `status() { ... }` 不是调用
  const methodRe = /(?:^|[,{\s])([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm;
  while ((m = methodRe.exec(src))) local.add(m[1]);
  const fnRe = /function\s+([A-Za-z_$][\w$]*)/g;
  while ((m = fnRe.exec(src))) local.add(m[1]);
  const classRe = /class\s+([A-Za-z_$][\w$]*)/g;
  while ((m = classRe.exec(src))) local.add(m[1]);
  return local;
}

const problems = [];
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const imported = collectImports(src);
  const code = stripLiterals(src);
  const local = collectLocalNames(src);
  const used = new Set();
  const callRe = /(^|[^\w$.])([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = callRe.exec(code))) used.add(m[2]);
  for (const id of used) {
    if (GLOBALS.has(id)) continue;
    if (imported.has(id)) continue;
    if (local.has(id)) continue;
    problems.push(`${path.relative(ROOT, file)}: 调用了未 import / 未定义的 ${id}()`);
  }
}

if (problems.length) {
  console.error('发现未导入/未定义的函数调用：');
  for (const p of problems) console.error(`  ${p}`);
  console.error('\n这类错误模块 import 时不报错，只在运行时 ReferenceError → 500 INTERNAL_ERROR。');
  process.exit(1);
}

console.log(`backend 静态 import 检查通过（${files.length} 个模块，无未导入调用）`);
