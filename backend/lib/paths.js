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
// 标签体上限 4096 字符：未闭合标签若允许无限长，每次匹配都会扫到串尾，
// 与 rewriteLocalRefs 是同一类二次复杂度（findLocalAsset 也走这里）
const tagReFor = (tag) => new RegExp(`<${tag}\\b[^>]{0,4096}>`, 'gi');
const attrReFor = (attr) => new RegExp(`(?<![-\\w])${attr}\\s*=\\s*["']([^"']*)["']`, 'i');
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
 *
 * @param {string} html 用户 HTML
 * @param {string} [publicPrefix] 可选公开前缀（/p/<id>）。后端项目反向代理场景传入：
 *   应用按「部署在站点根目录」写引用，根绝对路径（/api、/style.css）需改写成相对路径
 *   才能落回 /p/<id>/ 下；而应用自己已拼好公开地址（/p/<id>/api）的引用原样保留。
 *   纯前端项目不传，行为与历史完全一致。
 */
export function rewriteLocalRefs(html, publicPrefix) {
  // 手写单向扫描，**保证线性**。
  //
  // 早期实现是「按 13 种标签各跑一次正则」：未闭合标签会让 `[^>]*` 每次扫到
  // 字符串末尾才失败，引擎再前进一个字符重试 → O(N·L)。实测 200KB 的 `<img `
  // 要 70 秒，而粘贴 / ZIP 上传 / 项目模式 publish 以及**每次公开页下发**
  // 都会调用本函数，等于匿名可反复触发的站点级 DoS。
  //
  // 换成带 `{0,4096}` 上限的正则后仍有 O(N·4096) 的常数项（200KB 仍要 2.5 秒），
  // 所以这里改为游标单调前进：内层扫描到下一个 `<` 或 `>` 就停，游标随之跳过
  // 已扫描区间，**每个字符最多被访问一次**，整体 O(N)。
  const source = String(html ?? '');
  const len = source.length;
  const out = [];
  let i = 0;

  while (i < len) {
    const lt = source.indexOf('<', i);
    if (lt === -1) {
      out.push(source.slice(i));
      break;
    }
    out.push(source.slice(i, lt));

    let j = lt + 1;
    while (j < len && isTagNameChar(source[j])) j++;
    if (j === lt + 1) {
      // `<` 后面不是标签名（注释、文本里的比较符号等）：原样输出
      out.push('<');
      i = lt + 1;
      continue;
    }
    const rawTag = source.slice(lt + 1, j);

    // 从标签名之后找 `>`；提前遇到 `<` 说明当前不是完整标签
    let k = j;
    let gt = -1;
    while (k < len && k - j <= MAX_TAG_BODY) {
      const ch = source[k];
      if (ch === '>') {
        gt = k;
        break;
      }
      if (ch === '<') break;
      k++;
    }

    if (gt === -1) {
      // 未闭合 / 超长：原样输出到扫描停止位置，游标前移（不回头重扫）
      out.push(source.slice(lt, k));
      i = k;
      continue;
    }

    out.push(`<${rawTag}${rewriteTagBody(rawTag, source.slice(j, gt), publicPrefix)}>`);
    i = gt + 1;
  }

  return out.join('');
}

/**
 * 给公开页面注入项目根 `<base>`。
 *
 * 公开入口是 `/p/<项目ID>`（无尾斜杠），浏览器会把它当成文件路径：
 * `<link href="style.css">` 会请求 `/p/style.css`，而不是
 * `/p/<项目ID>/style.css`。注入 `<base href="/p/<项目ID>/">` 后，HTML、CSS、
 * 图片、站内链接以及 JS 里的相对 fetch 都以项目目录为基准解析。
 *
 * 用户显式写了 `<base>` 时：只有「href 为 `/` 或空串」这种按「部署在站点根目录」
 * 假设写的 base 才替换为项目前缀（不改会把相对引用全部指到宿主根）；
 * 其他值（CDN 等完整 URL）尊重用户意图不动，`<base target>`（无 href）也不动。
 */
export function injectPublicBase(html, basePath) {
  const source = String(html ?? '');
  const base = normalizePublicBase(basePath);
  if (!base) return source;

  // 用户自写 base：抓第一个 base 开标签（HTML 只第一个 base 生效）。
  // 有界正则：标签体 {0,4096} 上限防未闭合标签扫到串尾；href 属性带
  // (?<![-\w]) 防前缀 data-href 之类误命中（同 attrReFor 的写法）。
  if (/<base\b/i.test(source)) {
    return source.replace(/<base\b[^>]{0,4096}>/i, (tag) => {
      const hrefMatch = tag.match(/(?<![-\w])href\s*=\s*(["'])([^"']*)\1/i);
      if (!hrefMatch) return tag;
      const hrefValue = hrefMatch[2].trim();
      if (hrefValue !== '' && hrefValue !== '/') return tag;
      return tag.replace(
        /((?<![-\w])href\s*=\s*)(["'])([^"']*)\2/i,
        (whole, attrPrefix, quote) => `${attrPrefix}${quote}${base}/${quote}`
      );
    });
  }

  const href = `${base}/`;
  const tag = `<base href="${href}">`;
  if (/<head\b[^>]*>/i.test(source)) {
    return source.replace(/<head\b[^>]*>/i, (head) => `${head}\n${tag}`);
  }
  if (/<html\b[^>]*>/i.test(source)) {
    return source.replace(/<html\b[^>]*>/i, (htmlTag) => `${htmlTag}\n<head>${tag}</head>`);
  }
  if (/<body\b[^>]*>/i.test(source)) {
    return source.replace(/<body\b[^>]*>/i, (bodyTag) => `<head>${tag}</head>\n${bodyTag}`);
  }
  return `${tag}\n${source}`;
}

// 后端项目运行时代理 shim：逐字内联，注入时把 <<BASE>> 占位替换为实际前缀。
// 注意：本段代码不得出现反引号与 ${ 序列（避免与模板字面量冲突），只允许
// <<BASE>> 这一处占位符。
const PROXY_SHIM_CODE = `(function () {
  if (window.__pagemakeProxyReady) return;
  window.__pagemakeProxyReady = true;
  var BASE = '<<BASE>>';
  function underBase(p) { return p === BASE || p.indexOf(BASE + '/') === 0; }
  function rebase(v) {
    var s = String(v);
    if (s.charAt(0) !== '/' || s.charAt(1) === '/') return s;
    if (underBase(s.split(/[?#]/)[0])) return s;
    return BASE + s;
  }
  var _fetch = window.fetch;
  if (_fetch) {
    window.fetch = function (input, init) {
      try {
        if (typeof input === 'string') {
          input = rebase(input);
        } else if (input && typeof URL !== 'undefined' && input instanceof URL) {
          if (input.origin === location.origin && !underBase(input.pathname)) {
            input = BASE + input.pathname + input.search;
          }
        } else if (input && typeof Request !== 'undefined' && input instanceof Request) {
          var u = new URL(input.url, location.href);
          if (u.origin === location.origin && !underBase(u.pathname)) {
            input = new Request(BASE + u.pathname + u.search, input);
          }
        }
      } catch (e) { /* 解析失败保底走原行为 */ }
      return _fetch.call(window, input, init);
    };
  }
  var _xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function () {
    var args = Array.prototype.slice.call(arguments);
    try { if (args.length > 1 && args[1] != null) args[1] = rebase(args[1]); } catch (e) {}
    return _xhrOpen.apply(this, args);
  };
  var _winOpen = window.open;
  if (_winOpen) {
    window.open = function (url) {
      try {
        if (arguments.length && url != null) {
          var rest = Array.prototype.slice.call(arguments, 1);
          return _winOpen.apply(window, [rebase(url)].concat(rest));
        }
      } catch (e) {}
      return _winOpen.apply(window, arguments);
    };
  }
})();`;

/**
 * 给后端项目的公开页注入运行时代理 shim（fetch / XMLHttpRequest / window.open）。
 *
 * 为什么需要：rewriteLocalRefs / injectPublicBase / rewriteCssRefs 是**静态**改写，
 * 只能覆盖 HTML 属性与 CSS 里的引用字符串；而用户 JS 代码里写死的绝对路径——
 * `fetch('/api/x')`、`xhr.open('POST', '/save')`、`window.open('/next')`——
 * 不经任何 HTML 属性，静态阶段根本看不到，运行时才会发出逃出 /p/<id> 前缀的
 * 请求 → 404。shim 在运行时把这类「同源根绝对路径」改写到 BASE（/p/<id>）之下。
 *
 * 覆盖三入口：window.fetch / XMLHttpRequest.prototype.open / window.open。
 * `location.href = '/x'` 这类赋值浏览器不允许劫持，shim 覆盖不到，逃出前缀的
 * 页面跳转由宿主层 Referer 兜底重定向处理（docker/server.mjs：未匹配路由的
 * GET/HEAD 且来源是某 /p/<id> 应用 → 302 回应用内同名路径）。
 *
 * 幂等：以 data-pagemake-proxy-shim 标记判重，已注入过直接返回原文。
 */
export function injectProxyShim(html, basePath) {
  const source = String(html ?? '');
  const base = normalizePublicBase(basePath);
  if (!base) return source;
  if (source.indexOf('data-pagemake-proxy-shim') !== -1) return source;

  const script = `<script data-pagemake-proxy-shim>${PROXY_SHIM_CODE.replace('<<BASE>>', () => base)}</script>`;
  // 插入位置与 injectPublicBase 相同的优先级：head 开标签后 → html 开标签后
  // （shim 是 script，不需要包 head）→ body 开标签前 → 整体最前面。
  // 正则沿用 injectPublicBase 的有界写法。
  if (/<head\b[^>]*>/i.test(source)) {
    return source.replace(/<head\b[^>]*>/i, (head) => `${head}\n${script}`);
  }
  if (/<html\b[^>]*>/i.test(source)) {
    return source.replace(/<html\b[^>]*>/i, (htmlTag) => `${htmlTag}\n${script}`);
  }
  if (/<body\b[^>]*>/i.test(source)) {
    return source.replace(/<body\b[^>]*>/i, (bodyTag) => `${script}\n${bodyTag}`);
  }
  return `${script}\n${source}`;
}

/**
 * 引用值是否已经带项目公开前缀（/p/<id> 或 /p/<id>/...）
 * 后端应用可能自己拼好公开地址（如 <a href="/p/<id>/api">），已是完整公开引用，
 * 不能再按宿主根假设改写，否则会被二次加前缀变成 /p/<id>/p/<id>/api。
 */
function isUnderPublicPrefix(raw, prefix) {
  if (!prefix) return false;
  const path = String(raw).trim().split(/[?#]/)[0];
  return path === prefix || path.startsWith(prefix + '/');
}

/**
 * 不限定扩展名的本地引用判定（img/iframe/a/form 等）
 * 与 cssLocalRef 同规则：只判「是不是本地引用」，不看扩展名
 */
function anyLocalRef(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (NON_LOCAL_RE.test(raw) || raw.startsWith('//')) return null;
  // `a href="/"`、`form action="/"` 指向应用首页：normalizeRelPath('/') 为空串
  // 会跳过改写，导致仍指向宿主根；改写为 `./` 后配合注入的 <base href="/p/<id>/">
  // 正确解析到项目入口。本函数只被改写链路调用（rewriteRefAttr / rewriteSrcsetAttr），
  // findLocalAsset 走的是 localAssetRef，不受影响。
  if (raw === '/') return './';
  return normalizeRelPath(raw) || null;
}

/**
 * 取出引用值末尾的查询串/锚点（`?v=1`、`#team`）。
 *
 * normalizeRelPath 会剥掉这一段——那是给「存储路径」用的；但改写引用时若直接把
 * 归一后的路径写回属性，用户写的 `about.html#team` 会变成 `about.html`（站内锚点
 * 全部失效）、`a.css?v=3` 变成 `a.css`（缓存参数被抹掉）。所以改写要把这一段接回去。
 */
function refSuffix(value) {
  const raw = String(value ?? '').trim();
  const at = raw.search(/[?#]/);
  return at === -1 ? '' : raw.slice(at);
}

// 标签体上限：超过这个长度的「标签」按普通文本处理（防病态输入）
const MAX_TAG_BODY = 4096;

function isTagNameChar(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')
    || (ch >= '0' && ch <= '9') || ch === ':' || ch === '-' || ch === '_';
}

/** 改写单个标签体内的引用属性（body 已是有界片段；publicPrefix 语义见 rewriteLocalRefs） */
function rewriteTagBody(rawTag, body, publicPrefix) {
  const rules = TAG_RULES[rawTag.toLowerCase()];
  let out = body;
  if (rules) {
    for (const rule of rules) {
      out = rule === 'srcset' ? rewriteSrcsetAttr(out, publicPrefix) : rewriteRefAttr(out, rule, publicPrefix);
    }
  }
  // 内联 style 属性里的 url() / @import（div/span 等无规则标签也要覆盖）
  if (/style/i.test(out)) out = rewriteInlineStyleAttr(out);
  return out;
}

// 每种标签要改写的属性；'srcset' 是逗号分隔多值，单独处理
const TAG_RULES = {
  script: [{ attr: 'src', ext: 'js' }],
  img: [{ attr: 'src' }, 'srcset'],
  source: [{ attr: 'src' }, 'srcset'],
  iframe: [{ attr: 'src' }],
  audio: [{ attr: 'src' }],
  video: [{ attr: 'src' }, { attr: 'poster' }],
  track: [{ attr: 'src' }],
  embed: [{ attr: 'src' }],
  object: [{ attr: 'data' }],
  a: [{ attr: 'href' }],
  area: [{ attr: 'href' }],
  form: [{ attr: 'action' }],
  // link 除样式表外还有 icon / manifest / preload，统一按本地引用归一
  link: [{ attr: 'href' }],
};

/** 改写单个标签体内的一个引用属性（body 已是有界片段；publicPrefix 语义见 rewriteLocalRefs） */
function rewriteRefAttr(body, rule, publicPrefix) {
  const re = new RegExp(`((?<![-\\w])${rule.attr}\\s*=\\s*)(["'])([^"']*)\\2`, 'i');
  return body.replace(re, (whole, prefix, quote, value) => {
    // 已是带公开前缀的完整公开地址（后端应用自己拼的）：原样保留，不能二次加前缀
    if (isUnderPublicPrefix(value, publicPrefix)) return whole;
    const normalized = rule.ext ? localAssetRef(value, rule.ext) : anyLocalRef(value);
    if (!normalized) return whole;
    const target = `${normalized}${refSuffix(value)}`;
    if (target === value.trim()) return whole;
    return `${prefix}${quote}${target}${quote}`;
  });
}

/** srcset 是「URL + 描述符」的逗号分隔列表，必须逐候选归一（publicPrefix 语义见 rewriteLocalRefs） */
function rewriteSrcsetAttr(body, publicPrefix) {
  const re = /((?<![-\\w])srcset\s*=\s*)(["'])([^"']*)\2/i;
  return body.replace(re, (whole, prefix, quote, value) => {
    const parts = value.split(',').map((cand) => {
      const m = cand.match(/^(\s*)(\S+)(\s.*)?$/);
      if (!m) return cand;
      // 已带公开前缀的候选原样保留，不能二次加前缀
      if (isUnderPublicPrefix(m[2], publicPrefix)) return cand;
      const normalized = anyLocalRef(m[2]);
      const target = normalized ? `${normalized}${refSuffix(m[2])}` : m[2];
      return `${m[1]}${target}${m[3] || ''}`;
    });
    const joined = parts.join(',');
    return joined === value ? whole : `${prefix}${quote}${joined}${quote}`;
  });
}

/** 内联 style 属性里的 url() / @import（文本类属性整体跳过，避免改写展示文字） */
function rewriteInlineStyleAttr(body) {
  const re = /((?<![-\\w])style\s*=\s*)(["'])([^"']*)\2/i;
  return body.replace(re, (whole, prefix, quote, value) => {
    if (/^\s*(?:content|quotes|counter-[a-z-]+)\s*:/i.test(value)) return whole;
    const rewritten = rewriteCssRefs(value);
    return rewritten === value ? whole : `${prefix}${quote}${rewritten}${quote}`;
  });
}

// CSS url() 引用：url(x) / url("x") / url('x') 三种写法都要覆盖
//
// **同样故意不用正则**（与下面的 @import 同因）：`url\(\s*(?:"([^"]*)"|…)\s*\)`
// 在一个 `url(` 上失败时，正则引擎只把起点前移 1 个字符重试，而每次重试都可能
// 扫到字符串末尾——`"url(".repeat(60000)`（240KB，远低于 300KB 粘贴上限）
// 实测耗时 96 秒，`"url(\"a".repeat(n)` 也呈平方增长。CSS 由用户提供，且
// /p/<id>/*.css 每次请求都会重新改写 → 匿名可触发的站点级 DoS。
// 改为手写线性扫描：失败时返回安全前进位置（stop），由调用方推进 cursor。

// CSS @import 的字符串形式：@import "a.css"; / @import 'a.css' screen;
// 与 url() 是两个独立语法，此前只处理了 url()，字符串形式整段漏过。
//
// **这里故意不用正则**：`@import(?:空白|/\*[\s\S]*?\*/)+"…"` 这种写法里，惰性
// 量词可以跨过后续的 `*/`，多个注释块会产生指数级回溯——实测 24 个 `/*x*/`
// （仅 152 字节）就要 413ms，28 个约 5 秒。CSS 内容完全由用户提供，一次上传
// 就能把单进程事件循环卡死（下发侧 /p/<id>/*.css 也会触发）。改为手写扫描：
// indexOf + 逐段前进，复杂度线性。
const CSS_IMPORT_KEYWORD = '@import';
const CSS_WS_RE = /[ \t\r\n\f]/;

/**
 * 从 `@import` 关键字之后扫描到路径字符串（允许中间夹空白与注释）。
 *
 * 每轮循环都严格前进。**失败时必须返回已扫描到的位置**（stop），调用方据此
 * 推进 cursor：否则 `@import/*` 这种「注释没闭合」的输入会让每次扫描都走到
 * 字符串末尾，而 cursor 只前进 7 个字符 → O(N·L) 二次复杂度（实测 540KB
 * 输入可卡 40 秒，且公开页每次请求都会重新改写，等于匿名可触发的站点级 DoS）。
 *
 * @returns {{quoteStart:number, quoteEnd:number, value:string, quote:string}
 *   | {stop:number}} 成功返回路径位置，失败返回安全的前进位置
 */
function scanImportPath(css, keywordEnd) {
  let j = keywordEnd;
  while (j < css.length && CSS_WS_RE.test(css[j])) j++;
  while (css[j] === '/' && css[j + 1] === '*') {
    const close = css.indexOf('*/', j + 2);
    // 注释未闭合：后面不可能再有路径，直接扫到结尾
    if (close === -1) return { stop: css.length };
    j = close + 2;
    while (j < css.length && CSS_WS_RE.test(css[j])) j++;
  }
  const quote = css[j];
  // 空白/注释之后不是引号：这个 @import 没有字符串形式，从当前位置继续
  if (quote !== '"' && quote !== "'") return { stop: j };
  const end = css.indexOf(quote, j + 1);
  // 引号未闭合：扫到结尾
  if (end === -1) return { stop: css.length };
  return { quoteStart: j, quoteEnd: end, value: css.slice(j + 1, end), quote };
}

/** 区间是否全部落在「代码区」（非注释/非字符串） */
function isAllCode(mask, offset, length) {
  for (let i = offset; i < offset + length; i++) {
    if (!mask[i]) return false;
  }
  return true;
}

/** 第二遍：改写 @import 字符串形式的本地引用，保留关键字后的空白与注释 */
function rewriteImportRefs(css, mask) {
  const lower = css.toLowerCase();
  const out = [];
  let cursor = 0;
  while (cursor < css.length) {
    const at = lower.indexOf(CSS_IMPORT_KEYWORD, cursor);
    if (at === -1) {
      out.push(css.slice(cursor));
      break;
    }
    out.push(css.slice(cursor, at));
    const keywordEnd = at + CSS_IMPORT_KEYWORD.length;
    const hit = scanImportPath(css, keywordEnd);
    if (hit.stop !== undefined) {
      // 失败也要把 cursor 推进到扫描停止位置，否则同一段文本会被反复重扫
      const stop = Math.max(hit.stop, keywordEnd);
      out.push(css.slice(at, stop));
      cursor = stop;
      continue;
    }
    const pathLen = hit.quoteEnd - hit.quoteStart + 1;
    const editable = isAllCode(mask, at, CSS_IMPORT_KEYWORD.length)
      && isAllCode(mask, hit.quoteStart, pathLen);
    const normalized = editable ? cssLocalRef(hit.value) : null;
    const target = normalized ? `${normalized}${refSuffix(hit.value)}` : '';
    if (!target || target === hit.value.trim()) {
      out.push(css.slice(at, hit.quoteEnd + 1));
    } else {
      out.push(css.slice(at, hit.quoteStart), hit.quote, target, hit.quote);
    }
    cursor = hit.quoteEnd + 1;
  }
  return out.join('');
}

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
  const afterUrl = rewriteUrlRefs(source, cssCodeMask(source));
  // 必须在 url() 改写**之后**重新计算 mask：改写会改变字符串长度，
  // 沿用旧 mask 会让偏移量错位，把真实代码误判成注释（反之亦然）。
  return rewriteImportRefs(afterUrl, cssCodeMask(afterUrl));
}

const CSS_URL_KEYWORD = 'url(';
const CSS_ANY_WS_RE = /\s/;

/**
 * 从 `url(` 关键字之后扫描到路径字符串与右括号。
 *
 * 与 scanImportPath 同一约束：**失败时必须返回已扫描到的位置**（stop），
 * 调用方据此推进 cursor，否则同一段文本会被反复重扫 → O(N·L) 平方复杂度。
 *
 * 三种失败各自的收敛方式：
 *  - 裸值扫到结尾（既无 `)` 也无空白）：后面不可能再有 url(...)，直接收敛到末尾；
 *  - 裸值后不是 `)`：从裸值终点继续，不会漏掉后续 url(；
 *  - 引号未闭合：从开引号处继续（不能收敛到末尾——`url("url(a)` 里后一个
 *    url(a) 仍是合法引用，旧正则也能匹配到它）。
 *
 * @returns {{start:number,end:number,value:string,quote:string}|{stop:number}}
 *   end 是右括号下标（含），start 是路径内容起点
 */
function scanUrlRef(css, keywordEnd) {
  const len = css.length;
  let j = keywordEnd;
  while (j < len && CSS_ANY_WS_RE.test(css[j])) j++;
  const quote = css[j];
  if (quote === '"' || quote === "'") {
    const close = css.indexOf(quote, j + 1);
    if (close === -1) return { stop: j };
    let k = close + 1;
    while (k < len && CSS_ANY_WS_RE.test(css[k])) k++;
    if (css[k] !== ')') return { stop: j };
    return { start: j, end: k, value: css.slice(j + 1, close), quote };
  }
  let k = j;
  while (k < len && css[k] !== ')' && !CSS_ANY_WS_RE.test(css[k])) k++;
  if (k >= len) return { stop: len };
  let m = k;
  while (m < len && CSS_ANY_WS_RE.test(css[m])) m++;
  if (css[m] !== ')') return { stop: k };
  return { start: j, end: m, value: css.slice(j, k), quote: '' };
}

/**
 * 线性改写 CSS 里的 url() 本地引用
 *
 * 除扫描本身外还有一处必须做增量处理：`isTextProperty` 原本每次调用都从当前
 * 位置向前回溯到最近的 `;`/`{` 再截取整段声明，同一段声明里出现 N 个 url()
 * 就是 O(N²)（实测 48KB 的 `url(a)` 串行耗时 1.1 秒）。这里维护一个单调前进的
 * 声明边界 + 按边界缓存的属性名判定，总代价降到 O(N)。
 */
function rewriteUrlRefs(source, mask) {
  const lower = source.toLowerCase();
  const out = [];
  const isTextProp = createTextPropChecker(source);
  let cursor = 0;
  // 最近一个声明边界（; 或 {）的下标；-1 表示「文件开头」
  let boundary = -1;
  // boundary 已经推进到的位置，保证整串只被扫一遍
  let scanned = 0;
  while (cursor < source.length) {
    const at = lower.indexOf(CSS_URL_KEYWORD, cursor);
    if (at === -1) {
      out.push(source.slice(cursor));
      break;
    }
    out.push(source.slice(cursor, at));
    for (let k = scanned; k < at; k++) {
      const ch = source[k];
      if (ch === ';' || ch === '{') boundary = k;
    }
    scanned = at;
    const hit = scanUrlRef(source, at + CSS_URL_KEYWORD.length);
    if (hit.stop !== undefined) {
      // 失败也要把 cursor 推进到扫描停止位置，否则同一段文本会被反复重扫
      const stop = Math.max(hit.stop, at + CSS_URL_KEYWORD.length);
      out.push(source.slice(at, stop));
      cursor = stop;
      continue;
    }
    const wholeLen = hit.end + 1 - at;
    const editable = isAllCode(mask, at, wholeLen) && !isTextProp(boundary);
    const normalized = editable ? cssLocalRef(hit.value) : null;
    const target = normalized ? `${normalized}${refSuffix(hit.value)}` : '';
    if (!target || target === hit.value.trim()) {
      out.push(source.slice(at, hit.end + 1));
    } else {
      out.push(source.slice(at, hit.start), hit.quote, target, hit.quote, ')');
    }
    cursor = hit.end + 1;
  }
  return out.join('');
}

/**
 * 属性名判定器：按「声明边界」缓存结果。
 *
 * 属性名只取决于边界之后的那一小段文本（`<ws>name<ws>:`），与 url() 位置无关，
 * 因此同一段声明里判定一次即可复用，避免逐个 url() 重复解析。
 */
function createTextPropChecker(source) {
  let cachedBoundary = -2;
  let cached = false;
  return (boundary) => {
    if (boundary !== cachedBoundary) {
      cachedBoundary = boundary;
      cached = parseTextProperty(source, boundary);
    }
    return cached;
  };
}

/**
 * 判断声明边界之后的属性名是否为 content / quotes / counter-*
 * 这些属性的值是文本，里面的 url(...) 只是文字内容，不能当资源引用改写。
 * 支持普通 CSS 与 HTML 内联 style 的 &quot; 实体形式（实体不是引号边界，
 * 靠属性名兜底）。不截取整段声明，只按需读取开头几个字符。
 */
function parseTextProperty(source, boundary) {
  const len = source.length;
  let i = boundary + 1;
  while (i < len && CSS_ANY_WS_RE.test(source[i])) i++;
  const start = i;
  while (i < len && /[a-z-]/i.test(source[i])) i++;
  if (i === start) return false;
  const prop = source.slice(start, i).toLowerCase();
  while (i < len && CSS_ANY_WS_RE.test(source[i])) i++;
  if (source[i] !== ':') return false;
  return prop === 'content' || prop === 'quotes' || prop.startsWith('counter-');
}


/**
 * 公开入口前缀：项目入口是不带尾斜杠的 `/p/<id>`，浏览器会把它当成文件路径，
 * 因而 `style.css` 实际被解析为 `/p/style.css`。下发时统一写成站点绝对路径，
 * 才能不受入口 URL 形态影响。
 */
function normalizePublicBase(basePath) {
  const base = String(basePath ?? '').trim().replace(/\/+$/, '');
  if (!base || !base.startsWith('/')) return '';
  return base;
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
