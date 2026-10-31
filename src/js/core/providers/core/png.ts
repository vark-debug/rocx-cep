/**
 * 手写 PNG 编码（Node 层无 canvas，Ark 透明画布专用）
 *
 * 全透明 PNG 结构：8 字节签名 + IHDR + IDAT(zlib) + IEND。
 * 像素数据：每行前置 filter byte 0，行内容为全 0 的 RGBA（全透明黑），
 * zlib 对全零数据压缩率极高（4096×4096 也只有几 KB）。
 */
import { zlib } from "../../../lib/cep/node";

/** PNG chunk CRC32（标准表驱动实现） */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** 打包一个 PNG chunk：length(4) + type(4) + data + crc32(type+data)(4) */
function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, body, crc]);
}

/**
 * 生成一张 width×height 全透明 PNG 的 data URI。
 * UXP 版用 DOM canvas.toDataURL —— Node 层手写结构等价产物。
 */
export function makeTransparentPngDataUri(
  width: number,
  height: number,
): string {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));

  // IHDR：宽、高、位深 8、颜色类型 6(RGBA)、压缩 0、滤波 0、隔行 0
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  // 其余字节已为 0（压缩/滤波/隔行）

  // 原始像素数据：每行 filter byte(0) + w*4 个 0（全透明黑）
  const rowLen = 1 + w * 4;
  const raw = Buffer.alloc(rowLen * h); // Buffer.alloc 全零即所需内容
  const idat = zlib.deflateSync(raw, { level: 9 });

  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString("base64")}`;
}
