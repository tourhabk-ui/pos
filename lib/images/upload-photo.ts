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
 * До разбора доходят только растровые снимки — JPEG, PNG, WebP, GIF, HEIF,
 * по байтам, а не по имени и заявленному типу. sharp умеет и SVG (через
 * librsvg), и TIFF, и другое; роуты загрузки до 07.11 файлы не разбирали
 * вовсе, и открывать им лишние разборщики незачем: SVG под именем «.jpg»
 * прошёл бы проверку типа у четырёх роутов из пяти.
 *
 * Сторож: tests/unit/upload-photo-prepare.test.ts.
 */
import sharp from 'sharp';
import { UPLOAD_PHOTO_MAX_BYTES } from '@/lib/images/upload-limits';

/** Длинная сторона снимка, точек. */
export const PHOTO_MAX_SIDE = 2048;
/** Качество JPEG: у копий снимков мест для героя — то же (lib/images/web-variant). */
export const PHOTO_QUALITY = 85;
/** Длинная сторона логотипа, точек: на сайте он не крупнее пары сотен. */
export const LOGO_MAX_SIDE = 1024;
export { UPLOAD_PHOTO_MAX_BYTES, UPLOAD_PHOTO_MAX_MB, PHOTO_UPLOAD_HINT, PHOTO_TOO_LARGE } from '@/lib/images/upload-limits';

export type PreparedImage =
  | { ok: true; buf: Buffer; width: number; height: number; mime: 'image/jpeg' | 'image/png'; ext: 'jpg' | 'png' }
  | { ok: false; reason: string };

function failed(e: unknown): PreparedImage {
  return { ok: false, reason: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Бренды ftyp у HEIF-семейства: снимки iPhone (heic) и родственные. */
const HEIF_BRANDS = /^(heic|heix|hevc|hevx|mif1|msf1|avif|avis)$/;

/** Растровый снимок по байтам: JPEG, PNG, WebP, GIF, HEIF. Остальное — null. */
export function rasterKind(b: Buffer): 'jpeg' | 'png' | 'webp' | 'gif' | 'heif' | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 8 && b.subarray(0, 8).equals(PNG_MAGIC)) return 'png';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.toString('latin1', 0, 6))) return 'gif';
  if (b.length >= 12 && b.toString('latin1', 4, 8) === 'ftyp' && HEIF_BRANDS.test(b.toString('latin1', 8, 12))) return 'heif';
  return null;
}

const NOT_RASTER: PreparedImage = { ok: false, reason: 'не растровый снимок: ждём JPEG, PNG, WebP, GIF или HEIF' };

/** Снимок: разворот по EXIF, длинная сторона до `maxSide`, JPEG без метаданных. */
export async function preparePhoto(input: Buffer, maxSide: number = PHOTO_MAX_SIDE): Promise<PreparedImage> {
  if (!rasterKind(input)) return NOT_RASTER;
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
  if (!rasterKind(input)) return NOT_RASTER;
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

/**
 * Форма не разобралась, а тело запроса больше предела снимка: значит, Next
 * отдал роуту только начало тела (experimental.middlewareClientMaxBodySize в
 * next.config.js), и правдивый отказ — «файл слишком большой», а не
 * «неверный формат». Длину называет заголовок Content-Length; его нет —
 * размер неизвестен, и вывод не делается.
 */
export function uploadBodyTooLarge(request: Request): boolean {
  // Нет заголовка или он пуст — Number даёт 0, не число — NaN: вывода нет.
  const n = Number(request.headers.get('content-length'));
  return Number.isFinite(n) && n > UPLOAD_PHOTO_MAX_BYTES;
}

/** Отказ словами, когда файл не разобрался. */
export function photoRefusal(type: string, name: string): string {
  return looksLikeHeic(type, name)
    ? `Это фото в формате HEIC — сайт его не разобрал, а многие браузеры такие не показывают. ${HOW_TO_JPEG}`
    : `Не удалось прочитать снимок. ${HOW_TO_JPEG}`;
}
