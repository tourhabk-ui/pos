/**
 * Веб-копия снимка для показа на сайте.
 *
 * ПОВОД (аудит vedarai.ru 01.10). Главная весила 8,7 МБ на телефоне, и 6,1 МБ
 * из них — один снимок туриста 3000x4000: его перенесли в герои карточки места
 * ссылкой на ОРИГИНАЛ загрузки (lib/places/user-photo-hero), а загрузка
 * туриста хранится как есть, до 10 МБ. Других снимков тяжелее мегабайта на
 * 117 проверенных картинках карточек нет — оба писателя ai_route_images
 * прогоняют файл через sharp, а перенос героя через него не шёл.
 *
 * ВЕЛИЧИНЫ — канон платформы (1280x720, mozjpeg q85, как у писателей и у
 * images-recompress). Отличие одно: `fit: 'outside'`, а не `'inside'`. Герой
 * рисуется на всю ширину с object-cover, и портретный снимок, вписанный
 * ВНУТРЬ 1280x720, стал бы 540 пикселей в ширину и растянулся бы в мыло.
 * `outside` уменьшает до наименьшего размера, ПОКРЫВАЮЩЕГО 1280x720: кадр
 * целиком, без обрезки, без увеличения.
 *
 * Исходов три, а не два (§4.0): копия сделана; копия не нужна — оригинал и
 * так не тяжелее; не смог — с причиной. Третий не равен ни первому, ни второму.
 */
import sharp from 'sharp';

export const WEB_VARIANT = { width: 1280, height: 720, quality: 85 } as const;

/**
 * Копия для карточки (01.10): рамка карточки ~170 CSS-пикселей, на телефоне
 * с плотностью 2,6 это ~450 точек. 480x360 с `outside` покрывает рамку без
 * мыла; q80 — карточка мала, разница с q85 не видна, вес меньше.
 */
export const THUMB_VARIANT = { width: 480, height: 360, quality: 80 } as const;

export type VariantSize = { readonly width: number; readonly height: number; readonly quality: number };

/** Оригиналы тяжелее этого не качаем: загрузка туриста ограничена 10 МБ. */
export const MAX_SOURCE_BYTES = 20 * 1024 * 1024;

export type WebVariantResult =
  | { status: 'made'; buf: Buffer; width: number; height: number }
  | { status: 'not_needed'; reason: string }
  | { status: 'failed'; reason: string };

export async function makeWebVariant(input: Buffer, size: VariantSize = WEB_VARIANT): Promise<WebVariantResult> {
  try {
    const out = await sharp(input, { failOn: 'truncated' })
      // EXIF-ориентация — ДО уменьшения: иначе портрет ужался бы как лежащий.
      .rotate()
      .resize(size.width, size.height, { fit: 'outside', withoutEnlargement: true })
      .jpeg({ quality: size.quality, progressive: true, mozjpeg: true })
      .toBuffer();

    // Буфер вернулся — это ещё не изображение. Проверка ДО записи.
    const meta = await sharp(out).metadata();
    if (!meta.width || !meta.height) {
      return { status: 'failed', reason: 'результат не читается как изображение' };
    }
    if (out.length >= input.length) {
      return { status: 'not_needed', reason: `оригинал не тяжелее копии: ${input.length} против ${out.length}` };
    }
    return { status: 'made', buf: out, width: meta.width, height: meta.height };
  } catch (e) {
    return { status: 'failed', reason: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
  }
}

/**
 * Скачать оригинал по публичному адресу. Объекты хранилища — public-read,
 * отдельного клиента не нужно. null — не скачался (причина в `reason`).
 */
export async function fetchSource(url: string): Promise<{ buf: Buffer } | { buf: null; reason: string }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return { buf: null, reason: `оригинал ответил ${res.status}` };
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > MAX_SOURCE_BYTES) return { buf: null, reason: `оригинал тяжелее ${MAX_SOURCE_BYTES} байт` };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_SOURCE_BYTES) return { buf: null, reason: `оригинал тяжелее ${MAX_SOURCE_BYTES} байт` };
    return { buf };
  } catch (e) {
    return { buf: null, reason: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
  }
}

/**
 * Залить копию и ПРОЧИТАТЬ её обратно: размер обязан совпасть. Тот же
 * порядок, что у переезда снимков в хранилище: без второго шага «залито» и
 * «потеряно» выглядели бы одинаково.
 */
export async function uploadVerified(
  key: string,
  buf: Buffer,
  upload: (key: string, body: Buffer, contentType: string) => Promise<{ url: string; key: string }>,
): Promise<{ url: string; key: string } | { url: null; reason: string }> {
  try {
    const put = await upload(key, buf, 'image/jpeg');
    const back = await fetch(put.url, { signal: AbortSignal.timeout(30_000) });
    if (!back.ok) return { url: null, reason: `копия не читается: ${back.status}` };
    const got = Buffer.from(await back.arrayBuffer());
    if (got.length !== buf.length) {
      return { url: null, reason: `размер копии не сошёлся: залито ${buf.length}, прочитано ${got.length}` };
    }
    return put;
  } catch (e) {
    return { url: null, reason: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
  }
}
