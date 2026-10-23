// 统一响应 / 内容类型 / 公开页面文案（中英，跟随 Accept-Language）
const PAGES = {
  takedown: { zh: '该内容已被下架', en: 'This content has been taken down' },
  expired: { zh: '链接已过期，请在 App 内点击刷新', en: 'This link has expired — refresh it in the app' },
  notFound: { zh: '链接不存在或已删除', en: 'This link does not exist or has been deleted' },
};

export function pickLanguage(request) {
  const header = request?.headers?.get?.('Accept-Language') || '';
  return header.toLowerCase().startsWith('en') ? 'en' : 'zh';
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

export function ok(data) {
  return json({ ok: true, ...data });
}

export function fail(error, status = 400, extra = {}) {
  return json({ ok: false, error, ...extra }, status);
}

export function contentTypeFor(path) {
  const ext = (String(path).split('.').pop() || '').toLowerCase();
  const map = {
    html: 'text/html; charset=utf-8',
    htm: 'text/html; charset=utf-8',
    css: 'text/css; charset=utf-8',
    js: 'application/javascript; charset=utf-8',
    mjs: 'application/javascript; charset=utf-8',
    json: 'application/json; charset=utf-8',
    txt: 'text/plain; charset=utf-8',
    xml: 'application/xml; charset=utf-8',
    svg: 'image/svg+xml',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    ico: 'image/x-icon',
    woff: 'font/woff',
    woff2: 'font/woff2',
    ttf: 'font/ttf',
    otf: 'font/otf',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mp3: 'audio/mpeg',
    pdf: 'application/pdf',
    // 预处理器与源码映射：用户常直接下载模板使用，HTML 里会 link/script 引用。
    // 漏配会让浏览器拿到 application/octet-stream 而拒绝应用（MIME 嗅探拦截），
    // 表现为「CSS/JS 明明存在却不生效」
    scss: 'text/x-scss',
    sass: 'text/x-sass',
    less: 'text/x-less',
    styl: 'text/x-styl',
    map: 'application/json; charset=utf-8',
    ts: 'text/typescript',
    tsx: 'text/typescript',
    jsx: 'text/jsx',
    wasm: 'application/wasm',
    avif: 'image/avif',
    heic: 'image/heic',
    bmp: 'image/bmp',
    tif: 'image/tiff',
    tiff: 'image/tiff',
    csv: 'text/csv; charset=utf-8',
    vtt: 'text/vtt',
    m4a: 'audio/mp4',
    ogg: 'audio/ogg',
    wav: 'audio/wav',
    flac: 'audio/flac',
    oga: 'audio/ogg',
    m4v: 'video/mp4',
    mov: 'video/quicktime',
    avi: 'video/x-msvideo',
    mkv: 'video/x-matroska',
    eot: 'application/vnd.ms-fontobject',
  };
  return map[ext] || 'application/octet-stream';
}

export function htmlPage(status, kind, request) {
  const lang = pickLanguage(request);
  const message = PAGES[kind]?.[lang] || PAGES.notFound[lang];
  const html = `<!DOCTYPE html>
<html lang="${lang}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${message}</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;color:#333;background:#fafafa}
.card{text-align:center;padding:32px}h1{font-size:20px;font-weight:600}</style></head>
<body><div class="card"><h1>${message}</h1></div></body></html>`;
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
