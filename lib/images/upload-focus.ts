/**
 * Точка кадра снимка, который оператор загрузил сам, — при загрузке, в имени
 * файла.
 *
 * Зачем (14.11, слово владельца «1 да»). Точку кадра портретных снимков считал
 * только станок `npm run images` по снимкам в хранилище (12.11). Фото тура,
 * загруженное оператором через сайт, станок не видит, и в плитке 16:10 оно
 * стояло на верхе кадра: у пейзажа, снятого вертикально, — одно небо.
 *
 * Правило то же, что у станка (`lib/images/focus-from-pixels.mjs`), а точка
 * пишется в имя файла: `tour_<hash>.fy55.jpg`. Так она живёт вместе со
 * снимком — без новой колонки, без миграции и без второй записи, которая
 * могла бы разойтись с файлом. Читает её `photoFocusY` (lib/tours/photo-focus.ts)
 * после ручной и посчитанной станком точек.
 *
 * Исходов три, как велит §4.0: точка есть; точка не нужна (не портрет, деталь
 * в самом верху, деталей нет — снимок остаётся на верхе кадра, как раньше);
 * посчитать не смог — тоже верх кадра, но с причиной в логе. Загрузку отказ
 * счёта не останавливает: снимок важнее точки.
 */
import sharp from 'sharp';
import { SAMPLE_W, focusFromPixels } from '@/lib/images/focus-from-pixels.mjs';

export type UploadFocus =
  | { ok: true; y: number | null }
  | { ok: false; reason: string };

/** Точка уже подготовленного снимка (повёрнут по EXIF, без метаданных). */
export async function uploadFocusY(prepared: Buffer): Promise<UploadFocus> {
  try {
    const meta = await sharp(prepared).metadata();
    let srcW = meta.width ?? 0;
    let srcH = meta.height ?? 0;
    // Подготовленный снимок уже развёрнут, но чужой буфер может нести поворот.
    if ((meta.orientation ?? 1) >= 5) [srcW, srcH] = [srcH, srcW];
    if (!(srcH > srcW)) return { ok: true, y: null };
    const width = SAMPLE_W;
    const height = Math.max(2, Math.round((SAMPLE_W * srcH) / srcW));
    const data = await sharp(prepared)
      .rotate()
      .resize(width, height, { fit: 'fill' })
      .removeAlpha()
      .toColourspace('srgb')
      .raw()
      .toBuffer();
    return { ok: true, y: focusFromPixels({ data, width, height, srcW, srcH }) };
  } catch (e) {
    return { ok: false, reason: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
  }
}

/** Пометка точки в имени файла: `.fy55`. Точки нет — пометки нет. */
export function focusMark(y: number | null): string {
  if (y == null || !Number.isFinite(y)) return '';
  const v = Math.round(Math.min(100, Math.max(0, y)));
  return v === 0 ? '' : `.fy${v}`;
}

/**
 * Пометка для имени загруженного снимка; отказ счёта — пустая пометка и строка
 * в лог с именем роута (не молча).
 */
export async function uploadFocusMark(prepared: Buffer, where: string): Promise<string> {
  const f = await uploadFocusY(prepared);
  if (!f.ok) {
    console.error(`[${where}] точка кадра не посчитана, снимок встанет на верх кадра:`, f.reason);
    return '';
  }
  return focusMark(f.y);
}
