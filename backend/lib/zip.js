// 纯 JS ZIP 解析（边缘函数环境：无 node Buffer、无第三方库）
// 支持 stored(0) / deflate(8)；deflate 用运行时 DecompressionStream('deflate-raw')
// 自动过滤 __MACOSX / .DS_Store / 隐藏文件
import { ZIP_MAX_TOTAL_BYTES, ZIP_MAX_ENTRIES } from './state.js';
import { normalizeRelPath } from './paths.js';

export class ZipError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'ZipError';
    this.code = code;
  }
}

function shouldSkip(name) {
  const parts = name.split('/');
  if (parts.some((p) => p === '__MACOSX' || p === '.DS_Store')) return true;
  if (parts[0].startsWith('.')) return true; // .git 等
  return false;
}

function normalizePath(name) {
  // 折叠 . / .. 并统一斜杠：ZIP 条目名可能含 `sub/../../evil.css`，
  // 原样入库会污染 KV key 与 PHP 物化路径（路径穿越）
  return normalizeRelPath(name);
}

function decodeName(bytes, flags) {
  const utf8 = (flags & 0x800) !== 0;
  try {
    if (utf8) return new TextDecoder('utf-8').decode(bytes);
    // 无 utf-8 标志：先按 utf-8 试，失败退回 latin1
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    let out = '';
    for (const b of bytes) out += String.fromCharCode(b);
    return out;
  }
}

async function inflateRaw(raw) {
  if (typeof DecompressionStream === 'undefined') {
    throw new ZipError('STORAGE_ERROR', 'DecompressionStream 不可用，无法解压 deflate 条目');
  }
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

/**
 * 解压 zip
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {Promise<Map<string, Uint8Array>>} 文件路径 → 内容
 */
export async function unzip(buffer) {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

  // 定位 EOCD（End of Central Directory）
  let eocd = -1;
  const minPos = Math.max(0, u8.length - 22 - 65536);
  for (let i = u8.length - 22; i >= minPos; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('BAD_ZIP', '未找到 EOCD，zip 文件损坏');

  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);

  // 条目数上限：防止「海量小文件」耗尽内存与磁盘 inode
  if (count > ZIP_MAX_ENTRIES) {
    throw new ZipError('TOO_LARGE', `ZIP 条目过多（${count} > ${ZIP_MAX_ENTRIES}）`);
  }

  const files = new Map();
  let totalBytes = 0;
  for (let i = 0; i < count; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) {
      throw new ZipError('BAD_ZIP', '中央目录签名异常');
    }
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const declaredSize = view.getUint32(offset + 24, true);
    const flags = view.getUint16(offset + 8, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = normalizePath(decodeName(u8.subarray(offset + 46, offset + 46 + nameLen), flags));
    offset += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/') || shouldSkip(name)) continue;

    // 解压前先按中央目录声明的原始大小拦截：避免为单个超大条目分配内存
    if (declaredSize > ZIP_MAX_TOTAL_BYTES) {
      throw new ZipError('TOO_LARGE', `ZIP 单条目过大：${name}`);
    }

    if (view.getUint32(localOffset, true) !== 0x04034b50) {
      throw new ZipError('BAD_ZIP', '本地头签名异常');
    }
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = u8.subarray(dataStart, dataStart + compressedSize);

    let data;
    if (method === 0) {
      data = raw.slice();
    } else if (method === 8) {
      data = await inflateRaw(raw);
    } else {
      throw new ZipError('STORAGE_ERROR', `不支持的压缩方式：${method}`);
    }

    // 解压总量上限：边解压边累计，超限立即中止（而非解压完再判断）
    totalBytes += data.length;
    if (totalBytes > ZIP_MAX_TOTAL_BYTES) {
      throw new ZipError('TOO_LARGE', `ZIP 解压后体积过大（> ${ZIP_MAX_TOTAL_BYTES} 字节）`);
    }

    files.set(name, data);
  }
  return files;
}
