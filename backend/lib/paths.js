// 项目内文件路径安全与规范化
// 背景：文件路径来自三处不可信输入——用户粘贴的 HTML 引用、上传 ZIP 内的条目名、
//       API 直接传的 path。此前未统一处理，导致两类问题：
//       ① CSS/JS 断链：HTML 写 `../style.css` 时该字符串被原样存成文件名，
//          而浏览器请求 `/p/<id>/../style.css` 会被 URL 规范化成 `/p/style.css` → 404；
//       ② 路径穿越：ZIP 内 `sub/../../evil.css` 原样进入 KV key。
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

// 非本地引用（外链 / data URI / 协议相对）：不应被当成本地文件路径
const NON_LOCAL_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

// 标签 / 属性匹配：attr 前加 (?<![-\w]) 防止 data-href、xlink:href 误命中
const tagReFor = (tag) => new RegExp(`<${tag}\\b[^>]*>`, 'gi');
const attrReFor = (attr) => new RegExp(`(?<![-\\w])${attr}\\s*=\\s*["']([^"']*)["']`, 'i');
const attrReFullFor = (attr) => new RegExp(`((?<![-\\w])${attr}\\s*=\\s*)(["'])([^"']*)\\2`, 'i');
// 扩展名后可跟查询串/锚点（style.css?v=1）
const extReFor = (ext) => new RegExp(`\\.${ext}(?:[?#]|$)`, 'i');

/**
 * 判定属性值是否为「项目内本地资源引用」，是则返回归一后的相对路径
 * 外链 / data: / #锚点 / mailto: / tel: 一律返回 null（用户的远程引用不碰）
 * @returns {string|null}
 */
export function localAssetRef(value, ext) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (NON_LOCAL_RE.test(raw) || raw.startsWith('//')) return null;
  if (!extReFor(ext).test(raw.split(/[?#]/)[0])) return null;
  return normalizeRelPath(raw) || null;
}

/**
 * 从 HTML 中找出 CSS/JS 的引用文件名（跟随用户写的 <link href> / <script src>）
 * @returns {string|null} 归一后的相对路径，找不到返回 null
 */
export function findLocalAsset(html, tag, attr, ext) {
  const tagRe = tagReFor(tag);
  const attrRe = attrReFor(attr);
  let tagMatch;
  while ((tagMatch = tagRe.exec(html)) !== null) {
    const attrMatch = tagMatch[0].match(attrRe);
    if (!attrMatch) continue;
    const normalized = localAssetRef(attrMatch[1], ext);
    if (normalized) return normalized;
  }
  return null;
}

/**
 * 把 HTML 里的本地资源引用字符串改写成与存储路径一致的形式
 *
 * 背景：用户常写 `../style.css`、`./css/a.css`、`/style.css`。
 * 存储侧已归一，但若 HTML 字符串原样下发，浏览器在入口页 `/p/<id>`
 * （无尾斜杠，是该站点唯一入口 URL）下会把 `../style.css` 解析成
 * `https://host/style.css`——直接跳出 `/p/` 前缀落到站点外 → 404 断链。
 * 存访必须同时改写，只改存储名只是半截修复（曾因此留下真实断链）。
 * 逐标签就地替换，不做全文字符串替换，避免误改正文里同名的普通文本。
 *
 * 覆盖范围（都属「本地资源引用」，同一根因）：
 *   link[href]    样式表 / icon / manifest
 *   script[src]   脚本
 *   img[src]      图片
 *   source[src]   picture/video/audio 的 <source>
 *   iframe[src]   内嵌页
 *   audio/video/track[src]、video[poster]
 *   img[srcset]   响应式图片（逗号分隔多个候选）
 *   a[href]       站内跳转（.html 等；外链与锚点不动）
 *   form[action]  表单提交
 * 早期只归一 link/script，导致 img/iframe/source 等仍 404、内页链接
 * 跳到站点外——与 CSS/JS 断链同一症状但漏了半边，这里补齐。
 */
export function rewriteLocalRefs(html) {
  const rewrite = (source, tag, attr, ext) => source.replace(
    tagReFor(tag),
    (tagText) => tagText.replace(attrReFullFor(attr), (whole, prefix, quote, value) => {
      const normalized = localAssetRef(value, ext);
      // 已是规范形式（或非本地引用）就不动，减少无意义的 HTML 改动
      if (!normalized || normalized === value.trim()) return whole;
      return `${prefix}${quote}${normalized}${quote}`;
    })
  );

  // 不限定扩展名的引用（图片/媒体/内嵌页/跳转/提交都可能带任意后缀或无后缀）
  const rewriteAnyExt = (source, tag, attr) => source.replace(
    tagReFor(tag),
    (tagText) => tagText.replace(attrReFullFor(attr), (whole, prefix, quote, value) => {
      const normalized = anyLocalRef(value);
      if (!normalized || normalized === value.trim()) return whole;
      return `${prefix}${quote}${normalized}${quote}`;
    })
  );

  let out = rewrite(rewrite(html, 'link', 'href', 'css'), 'script', 'src', 'js');
  for (const [tag, attr] of [
    ['img', 'src'], ['source', 'src'], ['iframe', 'src'], ['audio', 'src'],
    ['video', 'src'], ['video', 'poster'], ['track', 'src'], ['embed', 'src'],
    ['object', 'data'], ['a', 'href'], ['area', 'href'], ['form', 'action'],
    // link 除样式表外还有 icon / manifest / preload 等，同样要归一
    ['link', 'href'],
  ]) {
    out = rewriteAnyExt(out, tag, attr);
  }
  // srcset 是「URL + 描述符」的逗号分隔列表，不能当单一路径折叠，
  // 否则第一个候选归一后整串被 normalizeRelPath 吃掉后半段
  out = out.replace(tagReFor('img'), (t) => t.replace(attrReFullFor('srcset'), (w, p, q, v) => {
    const parts = v.split(',').map((cand) => {
      const m = cand.match(/^(\s*)(\S+)(\s.*)?$/);
      if (!m) return cand;
      const normalized = anyLocalRef(m[2]);
      return `${m[1]}${normalized || m[2]}${m[3] || ''}`;
    });
    const joined = parts.join(',');
    return joined === v ? w : `${p}${q}${joined}${q}`;
  }));
  out = out.replace(tagReFor('source'), (t) => t.replace(attrReFullFor('srcset'), (w, p, q, v) => {
    const parts = v.split(',').map((cand) => {
      const m = cand.match(/^(\s*)(\S+)(\s.*)?$/);
      if (!m) return cand;
      const normalized = anyLocalRef(m[2]);
      return `${m[1]}${normalized || m[2]}${m[3] || ''}`;
    });
    const joined = parts.join(',');
    return joined === v ? w : `${p}${q}${joined}${q}`;
  }));
  // 内联 style 属性里的 url()（与 CSS 文件内部同一处理）
  out = out.replace(/(<[a-z][^>]*\sstyle\s*=\s*)(["'])([^"']*)\2/gi,
    (whole, prefix, quote, value) => {
      // HTML 实体引号（&quot;）会让属性值里出现嵌套文本，外层截取只能拿到
      // content:&quot;url(../x)&quot; 这一段。这里先按属性名判断，
      // 文本类属性（content/quotes/counter-*）整体跳过，避免改写展示文字。
      if (/^\s*(?:content|quotes|counter-[a-z-]+)\s*:/i.test(value)) return whole;
      const rewritten = rewriteCssRefs(value);
      return rewritten === value ? whole : `${prefix}${quote}${rewritten}${quote}`;
    });
  return out;
}

/**
 * 不限定扩展名的本地引用判定（img/iframe/a/form 等）
 * 与 cssLocalRef 同规则：只判「是不是本地引用」，不看扩展名
 */
function anyLocalRef(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (NON_LOCAL_RE.test(raw) || raw.startsWith('//')) return null;
  return normalizeRelPath(raw) || null;
}

// CSS url() 引用：url(x) / url("x") / url('x') 三种写法都要覆盖
const CSS_URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi;

// CSS @import 的字符串形式：@import "a.css"; / @import 'a.css' screen;
// 与 url() 是两个独立语法，此前只处理了 url()，字符串形式整段漏过
// 允许 @import 与路径之间夹注释（CSS 规范允许，压缩器也常这么输出）
const CSS_IMPORT_RE = /@import(?:[ \t\r\n\f]|\/\*[\s\S]*?\*\/)+(?:"([^"]*)"|'([^']*)')/gi;

/**
 * 把 CSS 里的本地 url() 引用改写成与存储路径一致的形式
 *
 * 与 rewriteLocalRefs 同一根因，但作用对象是 CSS 而非 HTML：用户在样式表里写
 * `url(../img/bg.png)`、`url("/img/x.png")` 时，CSS 又是被 <link> 以
 * `/p/<id>/style.css` 这个「无尾斜杠入口」引入的，浏览器对相对引用的解析基准
 * 是 CSS 自身 URL 而非入口页，结果仍会跳出 /p/ 前缀 → 404 断链。
 * 症状和 HTML 断链一样（背景图/字体不显示），但根因在 CSS 内部，HTML 侧修复
 * 完全覆盖不到，必须单独归一。
 *
 * 外链 / data: URI / #锚点 一律不动；只改本地引用，且只改需要改的。
 *
 * 注意不能用 localAssetRef(value, '')：空扩展名会生成 `\.(?:[?#]|$)`，
 * 反而要求引用必须带小数点。CSS 的 url() 里图片/字体/任意资源都可能出现，
 * 这里只判断「是不是本地引用」，不限定扩展名。
 */
export function rewriteCssRefs(css) {
  const source = String(css ?? '');
  const mask = cssCodeMask(source);
  const isCode = (offset, length) => {
    for (let i = offset; i < offset + length; i++) {
      if (!mask[i]) return false;
    }
    return true;
  };
  return source.replace(CSS_URL_RE, (whole, dq, sq, bare, offset) => {
    if (!isCode(offset, whole.length)) return whole;
    if (isTextProperty(source, offset)) return whole;
    const value = dq ?? sq ?? bare ?? '';
    const quote = dq !== undefined ? '"' : (sq !== undefined ? "'" : '');
    const normalized = cssLocalRef(value);
    if (!normalized || normalized === value.trim()) return whole;
    return `url(${quote}${normalized}${quote})`;
  }).replace(CSS_IMPORT_RE, (whole, dq, sq, offset) => {
    // @import 与路径之间可能有注释；注释本身不可改，但关键字与路径字符串可改。
    // 只校验首尾（关键字 + 路径），避免把合法写法误判为注释而跳过。
    if (!isCode(offset, '@import'.length)) return whole;
    const pathStart = offset + whole.length - (dq ?? sq ?? '').length - 2;
    if (!isCode(pathStart, (dq ?? sq ?? '').length + 2)) return whole;
    const value = dq ?? sq ?? '';
    const quote = dq !== undefined ? '"' : "'";
    const normalized = cssLocalRef(value);
    if (!normalized || normalized === value.trim()) return whole;
    // 只替换路径字符串，保留 @import 后的原始空白/注释（如 @import/*x*/"a.css"）
    const pathLiteral = `${quote}${value}${quote}`;
    return whole.slice(0, whole.length - pathLiteral.length) + `${quote}${normalized}${quote}`;
  });
}

/**
 * 判断某个位置是否处于 content / quotes / counter-* 属性的值中
 * 这些属性的值是文本，里面的 url(...) 只是文字内容，不能当资源引用改写。
 * 支持普通 CSS 与 HTML 内联 style 的 &quot; 实体形式。
 */
function isTextProperty(source, offset) {
  // 从当前声明的起始（; 或 {）到 offset 之间取属性名。
  // 允许值与 url() 之间夹引号、HTML 实体等文本，不要求紧邻。
  let i = offset - 1;
  while (i >= 0 && source[i] !== ';' && source[i] !== '{') i--;
  const decl = source.slice(i + 1, offset);
  const m = decl.match(/^\s*([a-z-]+)\s*:/i);
  if (!m) return false;
  const prop = m[1].toLowerCase();
  return prop === 'content' || prop === 'quotes' || prop.startsWith('counter-');
}

/**
 * 标记 CSS 中每个字符能否参与引用改写
 *
 * 不能直接对整个 CSS 跑 url()/@import 正则：注释里写的示例
 * `/* url(../old.png) *\/` 会被误改。但字符串不能整体跳过，因为
 * `url("../a.png")` 和 `@import "../a.css"` 的路径本身就在字符串里。
 * 因此逐字符扫描：注释整段标 false；字符串只在紧跟 url( 或 @import
 * 时标 true，其它普通字符串标 false，避免 content 示例被误改。
 */
function cssCodeMask(source) {
  const mask = new Array(source.length).fill(true);
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      mask.fill(false, i, stop);
      i = stop;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i + 2);
      const stop = end === -1 ? source.length : end;
      mask.fill(false, i, stop);
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === '\\') {
          j += 2;
          continue;
        }
        if (source[j] === ch) {
          j++;
          break;
        }
        j++;
      }
      const before = source.slice(Math.max(0, i - 256), i);
      // 只有 url( 与 @import 后面的字符串是引用语法，其它字符串（content 等）跳过
      const isRefString = /url\([ \t\r\n\f]*$/i.test(before)
        || /@import(?:[ \t\r\n\f]|\/\*[\s\S]*?\*\/)+$/i.test(before);
      if (!isRefString) {
        const prop = before.match(/(?:^|[;{])\s*([a-z-]+)\s*:\s*$/i)?.[1]?.toLowerCase();
        // 引号本身保留为可改，避免整段 url("...") 因端点被屏蔽而漏判；
        // 但 content/quotes/counter-* 的文本值整段保护，防止示例被改写
        if (prop === 'content' || prop === 'quotes' || prop?.startsWith('counter-')) {
          mask.fill(false, i, j);
        } else {
          mask.fill(false, i + 1, Math.max(i + 1, j - 1));
        }
      }
      i = j;
      continue;
    }
    // HTML 实体引号不是 CSS 字符串边界，由 isTextProperty 按属性名兜底判断
    i++;
  }
  return mask;
}

/** CSS url() 专用：只判本地引用，不限扩展名 */
function cssLocalRef(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (NON_LOCAL_RE.test(raw) || raw.startsWith('//')) return null;
  return normalizeRelPath(raw) || null;
}
