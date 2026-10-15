/**
 * Ширина и высота JPEG из маркера SOF — без зависимостей. Сторожа снимков
 * сверяют ею, что файл в хранилище — тот самый, чей размер записан в
 * галерее и чья пропорция совпадает с оригиналом на Commons.
 */
export function jpegSize(buf: Buffer): { width: number; height: number } {
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) { i += 1; continue; }
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  throw new Error('нет маркера SOF');
}
