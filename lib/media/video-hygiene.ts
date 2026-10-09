/**
 * lib/media/video-hygiene.ts — годится ли файл ролика или обложки в
 * хранилище. Чистая функция над байтами; зовёт её заливка
 * (lib/media/video-sync.ts) до записи.
 *
 * Правила — решения владельца 09.10: ролик без звука; в присланном с
 * телефона бывают дата и место съёмки, и наружу они не уходят. Пока файлы
 * лежали в репозитории, правила держал тест по самим файлам
 * (transfer-charter). Файлы уехали в хранилище — проверка переехала к
 * заливке: файл со звуковой дорожкой или меткой места туда не попадёт, а
 * отпечаток в манифесте закрепляет ровно те байты, что её прошли.
 *
 * Возвращает список бед словами; пустой — файл годится.
 */
import type { VideoFile } from '@/lib/media/video-manifest';

/** Ролик ~3 МБ на мобильной сети — потолок; присланные были по 15–17 МБ. */
export const MAX_VIDEO_BYTES = 4 * 1024 * 1024;
export const MAX_POSTER_BYTES = 100 * 1024;

/** Следы съёмки в служебных коробках MP4: место (©xyz, loci), устройство. */
const CAPTURE_TRACES = /©xyz|loci|location|com\.apple|creation_time/i;

interface Box { type: string; start: number; end: number }

/** Коробки верхнего уровня MP4; null — структура битая. */
function topBoxes(buf: Buffer): Box[] | null {
  const boxes: Box[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 8 > buf.length) return null;
    let size = buf.readUInt32BE(off);
    let header = 8;
    if (size === 1) {
      if (off + 16 > buf.length) return null;
      size = Number(buf.readBigUInt64BE(off + 8));
      header = 16;
    } else if (size === 0) {
      size = buf.length - off;
    }
    if (size < header || off + size > buf.length) return null;
    boxes.push({ type: buf.toString('latin1', off + 4, off + 8), start: off, end: off + size });
    off += size;
  }
  return boxes;
}

function mp4Problems(buf: Buffer): string[] {
  const boxes = topBoxes(buf);
  if (!boxes || boxes[0]?.type !== 'ftyp') return ['не MP4 или файл обрезан'];
  const moov = boxes.findIndex((b) => b.type === 'moov');
  const mdat = boxes.findIndex((b) => b.type === 'mdat');
  if (moov < 0) return ['в файле нет индекса (moov)'];
  const problems: string[] = [];
  // Индекс после данных: браузер не начнёт играть, пока не докачает конец.
  if (mdat >= 0 && moov > mdat) problems.push('индекс в конце файла — нужен перепак с +faststart');
  // Смотрим только служебные коробки: в сжатых кадрах (mdat) любые байты
  // случайны, и «найденная» там подпись была бы ложной тревогой.
  const meta = boxes
    .filter((b) => b.type !== 'mdat' && b.type !== 'free' && b.type !== 'skip')
    .map((b) => buf.toString('latin1', b.start, b.end))
    .join('');
  // hdlr: версия и флаги (4 байта), pre_defined (4 байта), затем тип дорожки.
  if (!/hdlr\0{8}vide/.test(meta)) problems.push('нет видеодорожки');
  if (/hdlr\0{8}soun/.test(meta)) problems.push('есть звуковая дорожка');
  const trace = CAPTURE_TRACES.exec(meta);
  if (trace) problems.push(`следы съёмки в метаданных: «${trace[0]}»`);
  if (buf.length > MAX_VIDEO_BYTES) problems.push(`ролик ${buf.length} байт, потолок ${MAX_VIDEO_BYTES}`);
  return problems;
}

function jpegProblems(buf: Buffer): string[] {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return ['не JPEG'];
  const problems: string[] = [];
  let off = 2;
  while (off + 4 <= buf.length) {
    if (buf[off] !== 0xff) return ['битая структура JPEG'];
    const marker = buf[off + 1]!;
    if (marker === 0xff) { off += 1; continue; }
    // Начало сжатых данных или конец: служебных сегментов дальше нет.
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue; }
    const len = buf.readUInt16BE(off + 2);
    if (len < 2 || off + 2 + len > buf.length) return ['битая структура JPEG'];
    if (marker === 0xe1) {
      const head = buf.toString('latin1', off + 4, Math.min(off + 4 + 29, off + 2 + len));
      if (head.startsWith('Exif\0\0')) problems.push('EXIF в обложке');
      if (head.startsWith('http://ns.adobe.com/xap/1.0/')) problems.push('XMP в обложке');
    }
    off += 2 + len;
  }
  if (buf.length > MAX_POSTER_BYTES) problems.push(`обложка ${buf.length} байт, потолок ${MAX_POSTER_BYTES}`);
  return problems;
}

export function mediaProblems(bytes: Buffer, type: VideoFile['type']): string[] {
  return type === 'video/mp4' ? mp4Problems(bytes) : jpegProblems(bytes);
}
