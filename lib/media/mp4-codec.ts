/**
 * lib/media/mp4-codec.ts — каким кодеком сжата видеодорожка MP4.
 *
 * Зачем (07.11). Гид: «пишет, что формат видео не проигрывается в браузере,
 * хотя у меня mp4». MP4 — только коробка, внутри бывает H.264, HEVC (H.265),
 * VP9 или AV1. Во всех браузерах играет только H.264: HEVC не показывают
 * многие браузеры на компьютерах и Android, VP9 — iPhone и Safari. Кабинет
 * отвечал «нужен MP4, который открывается в браузере», и человек с MP4 на
 * руках не понимал, чего от него хотят. Из присланных гидом роликов один был
 * VP9 внутри MP4.
 *
 * Читаются только заголовки коробок и индекс (moov), не сам ролик: у файла
 * на 500 МБ индекс — сотни килобайт.
 *
 * Сторож: tests/unit/guide-tour-media.test.tsx.
 */

export type Mp4VideoCodec = 'h264' | 'hevc' | 'vp9' | 'av1' | 'other';

/** Тип записи образца в коробке stsd → кодек. Звук (mp4a и т. п.) сюда не входит. */
const VIDEO_SAMPLE_ENTRIES: Record<string, Mp4VideoCodec> = {
  avc1: 'h264', avc3: 'h264',
  hvc1: 'hevc', hev1: 'hevc', dvh1: 'hevc', dvhe: 'hevc',
  vp09: 'vp9',
  av01: 'av1',
  vp08: 'other', mp4v: 'other', s263: 'other', mjp2: 'other', apcn: 'other', apch: 'other',
};

/** Индекс больше этого — не разбираем: у роликов кабинета он на порядки меньше. */
const MAX_MOOV_BYTES = 32 * 1024 * 1024;

function fourcc(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
}

/**
 * Кодек видеодорожки по байтам индекса (moov целиком). `null` — видеодорожки
 * не нашлось. Коробка stsd: размер (4), тип (4), версия и флаги (4), число
 * записей (4), затем первая запись: размер (4) и её тип (4).
 */
export function videoCodecInMoov(moov: Uint8Array): Mp4VideoCodec | null {
  for (let p = 4; p + 20 <= moov.length; p++) {
    if (moov[p] !== 0x73 || moov[p + 1] !== 0x74 || moov[p + 2] !== 0x73 || moov[p + 3] !== 0x64) continue; // 'stsd'
    const codec = VIDEO_SAMPLE_ENTRIES[fourcc(moov, p + 16)];
    if (codec) return codec;
  }
  return null;
}

/**
 * Кодек видеодорожки файла MP4. `null` — не MP4, индекса нет или файл
 * обрезан: тогда решает браузер, откроет ли он ролик сам.
 */
export async function mp4VideoCodec(file: Blob): Promise<Mp4VideoCodec | null> {
  let off = 0;
  for (let i = 0; i < 64 && off + 8 <= file.size; i++) {
    const head = new Uint8Array(await file.slice(off, off + 16).arrayBuffer());
    if (head.length < 8) return null;
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    let size = view.getUint32(0);
    let header = 8;
    if (size === 1) {
      if (head.length < 16) return null;
      size = Number(view.getBigUint64(8));
      header = 16;
    } else if (size === 0) {
      size = file.size - off;
    }
    if (size < header) return null;
    if (fourcc(head, 4) === 'moov') {
      if (size > MAX_MOOV_BYTES) return null;
      return videoCodecInMoov(new Uint8Array(await file.slice(off, off + size).arrayBuffer()));
    }
    off += size;
  }
  return null;
}

const CODEC_NAMES: Record<Exclude<Mp4VideoCodec, 'h264'>, string> = {
  hevc: 'HEVC (H.265)',
  vp9: 'VP9',
  av1: 'AV1',
  other: 'не H.264',
};

const WHO_CANNOT: Record<Exclude<Mp4VideoCodec, 'h264'>, string> = {
  hevc: 'Его не показывают многие браузеры на компьютерах и Android.',
  vp9: 'Его не показывают iPhone и Safari.',
  av1: 'Его не показывают многие телефоны и Safari.',
  other: 'Его показывают не все браузеры.',
};

/** Как получить H.264 — одна строка для всех отказов кабинета. */
export const HOW_TO_H264 =
  'Пересохраните ролик в видеоредакторе телефона в MP4 или пришлите его менеджеру Ведара — загрузим сами. '
  + 'На iPhone для новых съёмок: Настройки → Камера → Форматы → «Наиболее совместимый».';

/** Почему ролик не взят и что сделать — словами для гида. */
export function codecAdvice(codec: Exclude<Mp4VideoCodec, 'h264'>): string {
  return `внутри этого MP4 — ${CODEC_NAMES[codec]}. ${WHO_CANNOT[codec]} Нужен MP4 с кодеком H.264. ${HOW_TO_H264}`;
}
