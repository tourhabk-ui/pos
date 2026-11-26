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
 *  - JPEG: все сегменты APPn, кроме JFIF (APP0), цветового профиля
 *    (APP2 ICC_PROFILE) и Adobe (APP14): без этих трёх часть снимков
 *    декодируется с другими цветами. Комментарии — тоже. Данные изображения
 *    разбираются до маркера конца кадра, и всё после него отбрасывается:
 *    телефоны дописывают туда второй кадр со своим EXIF (MPO, «живые фото»),
 *    а декодер хвост не читает (ревью безопасности PR #3840);
 *  - PNG: всё, кроме блоков изображения, цвета и анимации (eXIf, tEXt, zTXt,
 *    iTXt и незнакомые), и всё после IEND;
 *  - WebP: всё, кроме блоков изображения, цвета и анимации (EXIF, XMP и
 *    незнакомые); флаги EXIF и XMP в VP8X гасятся, размер RIFF пересчитан;
 *  - GIF: комментарии и блоки приложений (туда пишут XMP), кроме блока
 *    повтора анимации, и всё после конца файла.
 *
 * Формат определяется по байтам, а не по типу, который назвал клиент.
 * Формат, который разобрать не удалось (HEIC, битый файл), — отказ с
 * причиной: такой снимок в модель не уходит (§4.0 — «не смог очистить» не
 * равно «чисто»).
 */

export type StripResult =
  | { ok: true; base64: string; format: 'jpeg' | 'png' | 'webp' | 'gif'; removed: number }
  | { ok: false; reason: string };

/** Сегмент APPn, который остаётся: без него меняются цвета, места в нём нет. */
function jpegKeepApp(marker: number, payload: Buffer): boolean {
  if (marker === 0xe0) return payload.toString('latin1', 0, 5) === 'JFIF\0';
  if (marker === 0xe2) return payload.toString('latin1', 0, 12) === 'ICC_PROFILE\0';
  if (marker === 0xee) return payload.toString('latin1', 0, 5) === 'Adobe';
  return false;
}
/**
 * PNG и WebP — по списку того, что ОСТАЁТСЯ: изображение, цвет, анимация.
 * Всё прочее снимается, в том числе блок, которого здесь не знают: в
 * неизвестном блоке может лежать то же место съёмки, а «не узнал» не равно
 * «чисто» (ревью безопасности PR #3840).
 */
const PNG_KEEP = new Set([
  'IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'cHRM', 'gAMA', 'iCCP', 'sBIT', 'sRGB',
  'cICP', 'mDCv', 'cLLi', 'bKGD', 'hIST', 'pHYs', 'sPLT', 'acTL', 'fcTL', 'fdAT',
]);
const WEBP_KEEP = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF', 'ICCP']);

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
    if (buf.toString('latin1', 0, 4) === 'GIF8') return finish(stripGif(buf), 'gif');
  } catch (err) {
    return { ok: false, reason: `разбор снимка не удался: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { ok: false, reason: 'формат снимка не JPEG, PNG, WebP или GIF — метаданные снять нечем' };
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function finish(r: { out: Buffer; removed: number }, format: 'jpeg' | 'png' | 'webp' | 'gif'): StripResult {
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
    // Конец кадра: хвост за ним (второй кадр, приписанный EXIF) не идёт.
    if (marker === 0xd9) {
      parts.push(buf.subarray(i, i + 2));
      if (i + 2 < buf.length) removed += 1;
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
    const isApp = marker >= 0xe0 && marker <= 0xef;
    if ((isApp && !jpegKeepApp(marker, buf.subarray(i + 4, end))) || marker === 0xfe) {
      removed += 1;
    } else {
      parts.push(buf.subarray(i, end));
    }
    i = end;
    // После заголовка скана — данные изображения до следующего маркера.
    // Внутри них FF бывает только как FF 00 (экранированный байт), FF D0–D7
    // (перезапуск) и заполнение FF FF; любой другой FF xx — следующий
    // маркер: таблицы и скан прогрессивного JPEG, сегменты или конец кадра.
    if (marker === 0xda) i = jpegScanEnd(buf, i, parts);
  }
  throw new Error('JPEG: нет маркера конца кадра');
}

/** Копирует данные скана в parts и возвращает позицию следующего маркера. */
function jpegScanEnd(buf: Buffer, from: number, parts: Buffer[]): number {
  let j = from;
  while (j < buf.length - 1) {
    if (buf[j] !== 0xff) { j += 1; continue; }
    const next = buf[j + 1];
    if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) { j += 2; continue; }
    if (next === 0xff) { j += 1; continue; }
    parts.push(buf.subarray(from, j));
    return j;
  }
  throw new Error('JPEG: данные изображения без маркера конца');
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
    if (PNG_KEEP.has(type)) parts.push(buf.subarray(i, end));
    else removed += 1;
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
    if (!WEBP_KEEP.has(type)) {
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

/** Блоки повтора анимации: без них GIF играет один раз, места в них нет. */
const GIF_KEEP_APP = new Set(['NETSCAPE2.0', 'ANIMEXTS1.0']);

/** Индекс за терминатором цепочки подблоков GIF (размер, данные …, 0). */
function gifSubBlocksEnd(buf: Buffer, from: number): number {
  let j = from;
  for (;;) {
    if (j >= buf.length) throw new Error('GIF: обрыв подблоков');
    const size = buf[j];
    j += 1;
    if (size === 0) return j;
    j += size;
  }
}

function stripGif(buf: Buffer): { out: Buffer; removed: number } {
  const version = buf.toString('latin1', 0, 6);
  if (version !== 'GIF87a' && version !== 'GIF89a') throw new Error('GIF: неизвестная версия');
  if (buf.length < 13) throw new Error('GIF: обрыв заголовка');
  const packed = buf[10];
  let i = 13 + (packed & 0x80 ? 3 * 2 ** ((packed & 0x07) + 1) : 0);
  if (i > buf.length) throw new Error('GIF: обрыв таблицы цветов');
  const parts: Buffer[] = [buf.subarray(0, i)];
  let removed = 0;
  while (i < buf.length) {
    const block = buf[i];
    if (block === 0x3b) {
      // Конец файла: хвост за ним не идёт.
      parts.push(buf.subarray(i, i + 1));
      if (i + 1 < buf.length) removed += 1;
      return { out: Buffer.concat(parts), removed };
    }
    if (block === 0x2c) {
      if (i + 10 > buf.length) throw new Error('GIF: обрыв описания кадра');
      const lp = buf[i + 9];
      const dataAt = i + 10 + (lp & 0x80 ? 3 * 2 ** ((lp & 0x07) + 1) : 0);
      // Байт минимального размера кода LZW, затем подблоки данных.
      const end = gifSubBlocksEnd(buf, dataAt + 1);
      parts.push(buf.subarray(i, end));
      i = end;
      continue;
    }
    if (block === 0x21) {
      const label = buf[i + 1];
      if (label === undefined) throw new Error('GIF: обрыв расширения');
      const end = gifSubBlocksEnd(buf, i + 2);
      if (label === 0xf9) {
        // Управление кадром (задержка, прозрачность) — часть изображения.
        parts.push(buf.subarray(i, end));
      } else if (label === 0xff && buf[i + 2] === 11 && GIF_KEEP_APP.has(buf.toString('latin1', i + 3, i + 14))) {
        parts.push(buf.subarray(i, end));
      } else {
        // Комментарий, текст, блоки приложений (XMP) — снимаются.
        removed += 1;
      }
      i = end;
      continue;
    }
    throw new Error('GIF: неизвестный блок');
  }
  throw new Error('GIF: нет конца файла');
}
