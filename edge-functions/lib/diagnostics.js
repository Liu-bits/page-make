// 上传后静态检查：入口查找 + HTML 引用分析
// 检查项：缺失文件、大小写不一致、中文路径（写入 projects.diagnostics）

export function findEntry(files) {
  const names = [...files.keys()];
  // 优先根目录 index.html（大小写不敏感）
  const rootIndex = names.find((n) => n.toLowerCase() === 'index.html');
  if (rootIndex) return rootIndex;
  // 其次根目录任意 html
  const rootHtml = names.find((n) => !n.includes('/') && /\.html?$/i.test(n));
  if (rootHtml) return rootHtml;
  // 再任意 html
  return names.find((n) => /\.html?$/i.test(n)) || null;
}

const REF_RE = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;

function hasChinese(text) {
  return /[\u4e00-\u9fff]/.test(text);
}

function lineOf(html, index) {
  return html.slice(0, index).split('\n').length;
}

/**
 * 分析入口 HTML 的资源引用
 * @param {string} html
 * @param {Map<string, Uint8Array>} files
 * @returns {Array<{kind: string, detail: string, suggestion: string, line: number}>}
 */
export function analyzeHtml(html, files) {
  const diagnostics = [];
  const lowerToActual = new Map();
  for (const name of files.keys()) lowerToActual.set(name.toLowerCase(), name);

  REF_RE.lastIndex = 0;
  let match;
  while ((match = REF_RE.exec(html)) !== null) {
    const raw = match[1].trim();
    if (!raw) continue;
    if (/^(https?:)?\/\//i.test(raw)) continue; // 外链
    if (raw.startsWith('data:') || raw.startsWith('#') || raw.startsWith('mailto:') || raw.startsWith('tel:')) continue;

    const clean = raw.split(/[?#]/)[0];
    if (!clean) continue;
    const rel = clean.replace(/^\.\//, '').replace(/^\//, '');
    const line = lineOf(html, match.index);

    const lower = rel.toLowerCase();
    if (lowerToActual.has(lower)) {
      const actual = lowerToActual.get(lower);
      if (actual !== rel) {
        diagnostics.push({
          kind: 'caseMismatch',
          detail: `引用了 "${rel}"，实际文件名是 "${actual}"`,
          suggestion: '检查文件名大小写是否一致（服务器区分大小写）',
          line,
        });
      }
      continue;
    }

    if (hasChinese(rel)) {
      diagnostics.push({
        kind: 'chinesePath',
        detail: `引用了 "${rel}"，路径包含中文`,
        suggestion: '中文路径容易导致加载失败，建议改成英文文件名',
        line,
      });
    } else {
      diagnostics.push({
        kind: 'missingFile',
        detail: `找不到 ${rel}`,
        suggestion: '检查文件名是否写错、文件是否打包进压缩包',
        line,
      });
    }
  }
  return diagnostics;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 找不到 HTML 时自动生成的预览页
export function autoPreviewHtml(name) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(name)}</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; display: flex; align-items: center;
         justify-content: center; min-height: 100vh; margin: 0; color: #333; background: #fafafa; }
  .card { text-align: center; padding: 32px; }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 8px; }
  p { color: #888; font-size: 14px; margin: 0; }
</style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(name)}</h1>
    <p>压缩包里没有找到 HTML 文件，已自动生成此预览页。</p>
  </div>
</body>
</html>`;
}
