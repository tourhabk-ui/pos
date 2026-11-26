/**
 * Снять со снимка метаданные, в которых бывает место съёмки, прежде чем
 * снимок уйдёт в зарубежную модель зрения.
 *
 * Проверка безопасности ИИ-части 26.11 (слово владельца «чини Карт бланш»):
 * окно чата отправляло снимок до 3 МБ как есть, и сервер передавал его в
 * Gemini, OpenRouter, Qwen и DeepSeek вместе с EXIF. GPS снимка, сделанного в
 * походе, — это точное место человека, то есть его персональные данные
 * (152-ФЗ), уходящие за границу.
 *
 * Что снимается:
 *  - JPEG: сегменты APP1 (EXIF и XMP), APP13 (IPTC/Photoshop) и комментарии.
 *    APP0 (JFIF), APP2 (цветовой профиль) и APP14 (Adobe) остаются: без них
 *    часть снимков декодируется с другими цветами;
 *  - PNG: блоки eXIf, tEXt, zTXt, iTXt (там бывают EXIF и XMP);
 *  - WebP: блоки EXIF и XMP, флаги о них в VP8X и размер RIFF;
 *  - GIF: метаданных места не несёт и идёт как есть.
 *
 * Формат определяется по байтам, а не по типу, который назвал клиент.
 * Формат, который разобрать не удалось (HEIC, битый файл), — отказ с
 * причиной: такой снимок в модель не уходит (§4.0 — «не смог очистить» не
 * равно «чисто»).
 */

export type StripResult =
  | { ok: true; base64: string; format: 'jpeg' | 'png' | 'webp' | 'gif'; removed: number }
  | { ok: false; reason: string };

const JPEG_DROP = new Set([0xe1, 0xed, 0xfe]); // APP1, APP13, COM
const PNG_DROP = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt']);
const WEBP_DROP = new Set(['EXIF', 'XMP ']);

export function stripImageMetadata(base64: string): StripResult {
  let buf: Buffer;
  try {
    buf = Buffer.from(base64, 'base64');
  } catch {
    return { ok: false, reason: 'снимок не читается как base64' };
  }
  if (buf.length < 12) return { ok: false, reason: 'снимок слишком короткий' };
  try {
    if (buf[0] === 0xff && buf[1] === 0xd8) return finish(stripJpeg(buf), 'jpeg');
    if (buf.subarray(0, 8).equals(PNG_SIGNATURE)) return finish(stripPng(buf), 'png');
    if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return finish(stripWebp(buf), 'webp');
    if (buf.toString('latin1', 0, 4) === 'GIF8') return { ok: true, base64, format: 'gif', removed: 0 };
  } catch (err) {
    return { ok: false, reason: `разбор снимка не удался: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { ok: false, reason: 'формат снимка не JPEG, PNG, WebP или GIF — метаданные снять нечем' };
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function finish(r: { out: Buffer; removed: number }, format: 'jpeg' | 'png' | 'webp'): StripResult {
  return { ok: true, base64: r.out.toString('base64'), format, removed: r.removed };
}

function stripJpeg(buf: Buffer): { out: Buffer; removed: number } {
  const parts: Buffer[] = [buf.subarray(0, 2)];
  let i = 2;
  let removed = 0;
  while (i < buf.length) {
    if (buf[i] !== 0xff) throw new Error('JPEG: ожидался маркер');
    const marker = buf[i + 1];
    if (marker === undefined) throw new Error('JPEG: обрыв на маркере');
    // Заполняющие FF перед маркером.
    if (marker === 0xff) { i += 1; continue; }
    // Начало данных изображения: дальше метаданных нет, хвост — как есть.
    if (marker === 0xda || marker === 0xd9) {
      parts.push(buf.subarray(i));
      return { out: Buffer.concat(parts), removed };
    }
    // Маркеры без длины.
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      parts.push(buf.subarray(i, i + 2));
      i += 2;
      continue;
    }
    if (i + 4 > buf.length) throw new Error('JPEG: обрыв длины сегмента');
    const len = buf.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buf.length) throw new Error('JPEG: длина сегмента выходит за файл');
    const end = i + 2 + len;
    if (JPEG_DROP.has(marker)) removed += 1;
    else parts.push(buf.subarray(i, end));
    i = end;
  }
  throw new Error('JPEG: нет начала данных изображения');
}

function stripPng(buf: Buffer): { out: Buffer; removed: number } {
  const parts: Buffer[] = [buf.subarray(0, 8)];
  let i = 8;
  let removed = 0;
  while (i < buf.length) {
    if (i + 12 > buf.length) throw new Error('PNG: обрыв блока');
    const len = buf.readUInt32BE(i);
    const type = buf.toString('latin1', i + 4, i + 8);
    const end = i + 12 + len;
    if (end > buf.length) throw new Error('PNG: длина блока выходит за файл');
    if (PNG_DROP.has(type)) removed += 1;
    else parts.push(buf.subarray(i, end));
    i = end;
    if (type === 'IEND') break;
  }
  return { out: Buffer.concat(parts), removed };
}

function stripWebp(buf: Buffer): { out: Buffer; removed: number } {
  const chunks: Buffer[] = [];
  let i = 12;
  let removed = 0;
  while (i < buf.length) {
    if (i + 8 > buf.length) throw new Error('WebP: обрыв блока');
    const type = buf.toString('latin1', i, i + 4);
    const len = buf.readUInt32LE(i + 4);
    const end = i + 8 + len + (len % 2);
    if (i + 8 + len > buf.length) throw new Error('WebP: длина блока выходит за файл');
    const chunk = buf.subarray(i, Math.min(end, buf.length));
    if (WEBP_DROP.has(type)) {
      removed += 1;
    } else if (type === 'VP8X' && len >= 1) {
      const copy = Buffer.from(chunk);
      copy[8] &= ~(0x08 | 0x04); // флаги EXIF и XMP
      chunks.push(copy);
    } else {
      chunks.push(chunk);
    }
    i = end;
  }
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(4 + body.length, 4);
  header.write('WEBP', 8, 'latin1');
  return { out: Buffer.concat([header, body]), removed };
}
