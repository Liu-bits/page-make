// =============================================================================
// 最小 ZIP 写入器（仅 store 模式，不压缩）
//
// 为什么不用第三方库：后端零 npm 依赖是硬约束。导出/备份只需要「把文件原样
// 打成一个能解压的包」，store 模式足够，而且对图片/字体这类已压缩内容不会
// 二次膨胀。代价是压缩包里文本文件不省空间，但项目上限本来就不大。
//
// 格式参考 PKWARE APPNOTE 4.3：local file header + data + central directory + EOCD。
// =============================================================================

/** CRC-32 查表（首次使用时构建） */
let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  CRC_TABLE = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    CRC_TABLE[i] = c >>> 0;
  }
  return CRC_TABLE;
}

export function crc32(bytes) {
  const table = crcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value) {
  const b = new Uint8Array(2);
  b[0] = value & 0xff;
  b[1] = (value >>> 8) & 0xff;
  return b;
}

function u32(value) {
  const b = new Uint8Array(4);
  b[0] = value & 0xff;
  b[1] = (value >>> 8) & 0xff;
  b[2] = (value >>> 16) & 0xff;
  b[3] = (value >>> 24) & 0xff;
  return b;
}

function concat(parts) {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** 固定为 DOS 时间 1980-01-01 00:00，避免同样内容每次导出字节不同 */
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

/**
 * 打包成 ZIP。
 * @param {Array<{path: string, data: Uint8Array}>} entries
 * @returns {Uint8Array}
 */
export function buildZip(entries) {
  const encoder = new TextEncoder();
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.path);
    const data = entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data);
    const crc = crc32(data);

    const localHeader = concat([
      u32(0x04034b50), // local file header signature
      u16(20), // version needed
      u16(0x0800), // general purpose flag: UTF-8 文件名
      u16(0), // compression: store
      u16(DOS_TIME),
      u16(DOS_DATE),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(nameBytes.length),
      u16(0), // extra length
      nameBytes,
    ]);

    locals.push(localHeader, data);

    const centralHeader = concat([
      u32(0x02014b50), // central directory signature
      u16(20), // version made by
      u16(20), // version needed
      u16(0x0800),
      u16(0),
      u16(DOS_TIME),
      u16(DOS_DATE),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(nameBytes.length),
      u16(0),
      u16(0),
      u16(0), // disk number
      u16(0), // internal attrs
      u32(0), // external attrs
      u32(offset), // relative offset of local header
      nameBytes,
    ]);
    centrals.push(centralHeader);

    offset += localHeader.length + data.length;
  }

  const centralStart = offset;
  const centralBytes = concat(centrals);
  const eocd = concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(centralBytes.length),
    u32(centralStart),
    u16(0),
  ]);

  return concat([...locals, centralBytes, eocd]);
}
