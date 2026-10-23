// 项目内文件路径安全与规范化
// 背景：文件路径来自三处不可信输入——用户粘贴的 HTML 引用、上传 ZIP 内的条目名、
//       API 直接传的 path。此前未统一处理，导致两类问题：
//       ① CSS/JS 断链：HTML 写 `../style.css` 时该字符串被原样存成文件名，
//          而浏览器请求 `/p/<id>/../style.css` 会被 URL 规范化成 `/p/style.css` → 404；
//       ② 路径穿越：ZIP 内 `sub/../../evil.css` 原样进入 KV key 与 PHP 物化路径。
// 统一在这里规范化 + 校验，各调用方只认「规范后的安全相对路径」。

/** 反斜杠统一为正斜杠（Windows 打包的 zip 常见） */
export function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

/**
 * 规范化相对路径：折叠 `.`/`..`、去掉首尾斜杠、剥掉查询串与锚点
 * 越界段（多余的 ..）被折叠而非保留：
 *   `sub/../../a.css` → `a.css`；`../style.css` → `style.css`
 * 与浏览器对 `/p/<id>/../x` 的 URL 规范化结果保持一致，避免存访不一致导致断链
 * @returns {string} 规范化后的相对路径（可能为空串）
 */
export function normalizeRelPath(input) {
  let p = toPosix(input).trim();
  if (!p) return '';
  p = p.split(/[?#]/)[0];
  const parts = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (parts.length) parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.join('/');
}

/**
 * 校验是否为安全的项目内相对路径（API 入参用，需显式拒绝而非折叠）
 * 拒绝：空、超长、含 .. 或反斜杠、绝对路径、控制字符、以 / 结尾
 */
export function isValidRelPath(p) {
  return (
    typeof p === 'string' &&
    p.length > 0 &&
    p.length <= 200 &&
    !p.includes('..') &&
    !p.includes('\\') &&
    !p.startsWith('/') &&
    !p.endsWith('/') &&
    !/[\u0000-\u001f]/.test(p)
  );
}
