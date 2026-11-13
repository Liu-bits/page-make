// 生成 .agent/file/ 下的文件索引（SUMMARY.md / backend.md / ios.md / infra.md）
// 用途：AI 接手项目时先读索引，按需再打开具体文件，避免整文件读入消耗 token。
// 用法：node dev/build-file-index.mjs
//
// 索引内容 = 路径 + 行数 + 首行注释（职责）+ 导出符号/顶层类型（区块）
// 改完代码后必须重跑本脚本，保证索引与实际代码一致。
// 产物目录 .agent/file/ 被 gitignore（本地数据），本脚本本身随仓库跟踪。

import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT_DIR = path.join(ROOT, '.agent', 'file');
mkdirSync(OUT_DIR, { recursive: true });

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.agent', 'build', 'DerivedData',
  'PageMake.xcodeproj', 'Assets.xcassets', 'data',
]);

function walk(dir, exts, acc = []) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const name of names.sort()) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, exts, acc);
    else if (exts.some((e) => name.endsWith(e))) acc.push(full);
  }
  return acc;
}

const rel = (full) => path.relative(ROOT, full).replace(/\\/g, '/');

/** 取文件开头的说明性注释（跳过 shebang / import / 空行） */
function headComment(lines) {
  for (let i = 0; i < Math.min(lines.length, 8); i++) {
    const raw = lines[i].trim();
    if (!raw) continue;
    if (raw.startsWith('#!')) continue;
    if (raw.startsWith('//')) {
      const text = raw.replace(/^\/\/[/=#-]*\s*/, '').trim();
      if (!text) continue;
      // 跳过纯分隔线
      if (/^[-=*#\s]+$/.test(text)) continue;
      return text;
    }
    if (raw.startsWith('/*')) {
      const text = raw.replace(/^\/\*+\s*/, '').replace(/\*\/$/, '').trim();
      if (text) return text;
      continue;
    }
    if (raw.startsWith('import ') || raw.startsWith('export ')) break;
    return '';
  }
  return '';
}

/** JS/TS：导出符号 + 文件内的 ---- 区块标题 */
function scanJs(lines) {
  const symbols = [];
  const sections = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const raw = line.trim();

    // 区块标题：// ===== 标题 ===== / // ---- 标题 ---- / // ### 标题
    const section = raw.match(/^\/\/\s*[-=#*]{2,}\s*(.+?)\s*[-=#*]{0,}$/);
    if (section && !/^\/\/\s*[-=*#\s]+$/.test(raw)) {
      const title = section[1].replace(/[-=*#]+$/, '').trim();
      if (title && title.length <= 40) sections.push(title);
    }

    let name = null;
    let m;
    if ((m = raw.match(/^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/))) name = m[1];
    else if ((m = raw.match(/^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/))) name = m[1];
    else if ((m = raw.match(/^export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/))) name = m[1];
    else if ((m = raw.match(/^export\s*\{([^}]+)\}/))) {
      const names = m[1].split(',').map((s) => s.split(/\s+as\s+/).pop().trim()).filter(Boolean);
      name = names.join(', ');
    }
    if (name) {
      // 找紧邻上方的说明注释
      let doc = '';
      for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
        const prev = lines[j].trim();
        if (prev.startsWith('//')) {
          const t = prev.replace(/^\/\/+\s*/, '').trim();
          if (t && !/^[-=*#\s]+$/.test(t)) {
            doc = t;
            break;
          }
        } else if (prev) break;
      }
      symbols.push(doc ? `${name} — ${doc}` : name);
    }
  }
  return { symbols, sections };
}

/** Swift：顶层类型 + 顶层函数 + 区块标题 */
function scanSwift(lines) {
  const symbols = [];
  const sections = [];
  let firstDoc = '';
  let depth = 0;
  for (const line of lines) {
    const raw = line.trim();
    const section = raw.match(/^\/\/\s*[-=#*]{2,}\s*(.+?)\s*[-=#*]{0,}$/);
    if (section && !/^\/\/\s*[-=*#\s]+$/.test(raw)) {
      const title = section[1].replace(/[-=*#]+$/, '').trim();
      if (title && title.length <= 40) sections.push(title);
    }
    // 文档注释：`/// 说明` 作为职责回退
    if (!firstDoc && raw.startsWith('///')) {
      const t = raw.replace(/^\/\/\/+\s*/, '').trim();
      if (t && !/^[-=*#\s]+$/.test(t)) firstDoc = t;
    }
    if (depth === 0) {
      const m = raw.match(
        /^(?:@\w+(?:\([^)]*\))?\s+)*(?:public\s+|internal\s+|private\s+|fileprivate\s+)?(struct|final class|class|enum|protocol|extension|actor)\s+([A-Za-z_][\w]*)/,
      );
      if (m) symbols.push(`${m[1]} ${m[2]}`);
    }
    // 粗略花括号深度（字符串/注释内的花括号会造成偏差，索引用途可接受）
    depth += (line.match(/\{/g) || []).length;
    depth -= (line.match(/\}/g) || []).length;
    if (depth < 0) depth = 0;
  }
  return { symbols, sections, firstDoc };
}

function describe(full) {
  const text = readFileSync(full, 'utf8');
  const lines = text.split(/\r?\n/);
  const isSwift = full.endsWith('.swift');
  const scanned = isSwift ? scanSwift(lines) : scanJs(lines);
  const { symbols, sections } = scanned;
  return {
    path: rel(full),
    lineCount: lines.length,
    purpose: headComment(lines) || scanned.firstDoc || '',
    symbols,
    sections: [...new Set(sections)],
  };
}

function render(title, intro, entries) {
  const out = [`# ${title}`, '', intro, ''];
  out.push(`> 由 \`dev/build-file-index.mjs\` 自动生成，共 ${entries.length} 个文件。`);
  out.push('> 改完代码请重跑：`node dev/build-file-index.mjs`', '');
  for (const e of entries) {
    out.push(`## ${e.path} · ${e.lineCount} 行`);
    out.push('');
    out.push(`**职责**：${e.purpose || '（文件内无首行注释）'}`);
    if (e.sections.length) out.push(`**区块**：${e.sections.join(' / ')}`);
    if (e.symbols.length) {
      out.push('**导出/类型**：');
      for (const s of e.symbols) out.push(`- ${s}`);
    } else {
      out.push('**导出/类型**：—');
    }
    out.push('');
  }
  return out.join('\n');
}

const groups = [
  {
    file: 'backend.md',
    title: '后端文件索引（backend/）',
    intro: '路由表在 `docker/server.mjs` 的 `ROUTES` 数组；`backend/` 下每个文件是一个 handler（`export async function onRequest`）。',
    entries: walk(path.join(ROOT, 'backend'), ['.js']).map(describe),
  },
  {
    file: 'ios.md',
    title: 'iOS 文件索引（ios/）',
    intro: 'SwiftUI 工程由 `ios/project.yml` 描述（XcodeGen 生成）。本地无 Xcode，改动只能靠 CI 验证。',
    entries: walk(path.join(ROOT, 'ios'), ['.swift']).map(describe),
  },
  {
    file: 'infra.md',
    title: '基础设施文件索引（docker / dev / scripts / CI / 根目录）',
    intro: '容器入口、测试套件、静态检查脚本、CI 工作流与根目录文档。',
    entries: [
      ...walk(path.join(ROOT, 'docker'), ['.mjs']),
      ...walk(path.join(ROOT, 'dev'), ['.mjs']),
      ...walk(path.join(ROOT, 'scripts'), ['.mjs', '.sh']),
      ...walk(path.join(ROOT, '.github'), ['.yaml', '.yml']),
      ...['Dockerfile', 'AGENTS.md', 'README.md', 'Have-not.md', '.gitignore', '.dockerignore', '.env.example']
        .map((f) => path.join(ROOT, f))
        .filter((f) => {
          try {
            return statSync(f).isFile();
          } catch {
            return false;
          }
        }),
    ].map(describe),
  },
];

const summary = ['# 文件总览（一行一文件）', '',
  '> 最省 token 的入口：先看本表定位文件，需要细节再看 `backend.md` / `ios.md` / `infra.md`。',
  '> 由 `dev/build-file-index.mjs` 自动生成；改完代码请重跑。', ''];

for (const g of groups) {
  writeFileSync(path.join(OUT_DIR, g.file), render(g.title, g.intro, g.entries), 'utf8');
  console.log(`${g.file}: ${g.entries.length} 个文件`);

  summary.push(`## ${g.title}`, '', '| 文件 | 行 | 职责 |', '| --- | ---: | --- |');
  for (const e of g.entries) {
    const purpose = (e.purpose || '—').replace(/\|/g, '\\|').slice(0, 60);
    summary.push(`| \`${e.path}\` | ${e.lineCount} | ${purpose} |`);
  }
  summary.push('');
}

writeFileSync(path.join(OUT_DIR, 'SUMMARY.md'), summary.join('\n'), 'utf8');
console.log('SUMMARY.md: 已生成');
