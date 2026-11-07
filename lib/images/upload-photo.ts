/**
 * lib/images/upload-photo.ts — снимок, который человек загрузил на сайт,
 * перед записью в хранилище.
 *
 * Зачем (07.11). Гид спросил, подрезаются ли загруженные фото до размера
 * сайта. Не подрезались: файл с телефона писался как есть — 3000×4000 и
 * больше, вместе с EXIF, где лежит место съёмки. Владелец: «Да, делай» и
 * «адаптируй загрузку фото». Так же как есть писались фото к отзывам
 * туристов (публичные — место съёмки там указывает, где был человек), фото
 * жилья, фото тура из формы оператора и обложка партнёра.
 *
 * Правило то же, что у фото мест (решение владельца 04.10,
 * app/api/places/[id]/photos): разворот по EXIF, уменьшение, файл без
 * метаданных. Длинная сторона снимка — до 2048 точек, а не до 1600: снимок
 * тура идёт в героя карточки во всю колонку 72rem (1152 точки CSS, на экране
 * с плотностью 2 — 2304), и 1600 там было бы мылом. Меньшие снимки не
 * увеличиваются. Кадр не обрезается: обрезку при показе делает вёрстка, файл
 * остаётся целым.
 *
 * sharp без `withMetadata()` метаданные не пишет: ни EXIF с местом и
 * устройством, ни XMP, ни IPTC.
 *
 * Снимок — JPEG; прозрачный PNG ложится на белый фон. Логотип — PNG до 1024
 * точек: у него бывает прозрачность, и белая подложка испортила бы его на
 * тёмном фоне.
 *
 * Исходов два, и второй называет причину: файл не разобрался (битый, HEIC
 * без кодека) — в хранилище не пишется ничего, а не исходник с местом
 * съёмки.
 *
 * Сторож: tests/unit/upload-photo-prepare.test.ts.
 */
import sharp from 'sharp';

/** Длинная сторона снимка, точек. */
export const PHOTO_MAX_SIDE = 2048;
/** Качество JPEG: у копий снимков мест для героя — то же (lib/images/web-variant). */
export const PHOTO_QUALITY = 85;
/** Длинная сторона логотипа, точек: на сайте он не крупнее пары сотен. */
export const LOGO_MAX_SIDE = 1024;
export { UPLOAD_PHOTO_MAX_BYTES, UPLOAD_PHOTO_MAX_MB, PHOTO_UPLOAD_HINT } from '@/lib/images/upload-limits';

export type PreparedImage =
  | { ok: true; buf: Buffer; width: number; height: number; mime: 'image/jpeg' | 'image/png'; ext: 'jpg' | 'png' }
  | { ok: false; reason: string };

function failed(e: unknown): PreparedImage {
  return { ok: false, reason: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
}

/** Снимок: разворот по EXIF, длинная сторона до `maxSide`, JPEG без метаданных. */
export async function preparePhoto(input: Buffer, maxSide: number = PHOTO_MAX_SIDE): Promise<PreparedImage> {
  try {
    const { data, info } = await sharp(input, { failOn: 'truncated' })
      // Поворот по EXIF — до уменьшения: иначе портрет ужался бы как лежащий.
      .rotate()
      .resize(maxSide, maxSide, { fit: 'inside', withoutEnlargement: true })
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .jpeg({ quality: PHOTO_QUALITY, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    return { ok: true, buf: data, width: info.width, height: info.height, mime: 'image/jpeg', ext: 'jpg' };
  } catch (e) {
    return failed(e);
  }
}

/** Логотип: разворот по EXIF, длинная сторона до 1024, PNG с прозрачностью, без метаданных. */
export async function prepareLogo(input: Buffer): Promise<PreparedImage> {
  try {
    const { data, info } = await sharp(input, { failOn: 'truncated' })
      .rotate()
      .resize(LOGO_MAX_SIDE, LOGO_MAX_SIDE, { fit: 'inside', withoutEnlargement: true })
      .png({ compressionLevel: 9 })
      .toBuffer({ resolveWithObject: true });
    return { ok: true, buf: data, width: info.width, height: info.height, mime: 'image/png', ext: 'png' };
  } catch (e) {
    return failed(e);
  }
}

/** HEIC/HEIF: по типу или расширению — его чаще всего присылает iPhone. */
export function looksLikeHeic(type: string, name: string): boolean {
  return /^image\/hei[cf]/i.test(type) || /\.hei[cf]$/i.test(name);
}

/** Как получить снимок, который сайт разберёт, — одна строка для отказов. */
export const HOW_TO_JPEG =
  'Сохраните фото как JPEG и загрузите снова. '
  + 'На iPhone для новых снимков: Настройки → Камера → Форматы → «Наиболее совместимый».';

/** Отказ словами, когда файл не разобрался. */
export function photoRefusal(type: string, name: string): string {
  return looksLikeHeic(type, name)
    ? `Это фото в формате HEIC — сайт его не разобрал, а многие браузеры такие не показывают. ${HOW_TO_JPEG}`
    : `Не удалось прочитать снимок. ${HOW_TO_JPEG}`;
}
