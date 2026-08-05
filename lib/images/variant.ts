/**
 * Подключение заранее нарезанных WebP-вариантов контентных фото.
 *
 * Владелец с телефона: «фото долго грузится». Оптимизатор Next отключён
 * осознанно (sharp не влезает в лимит standalone), поэтому карточки грузили
 * оригиналы по 150–320 КБ. Варианты нарезает `scripts/optimize-images.mjs`
 * и коммитит в git — тот же приём, что у бренд-графики (bear-64/128/192).
 *
 * Единственный источник правды о том, у какого фото ЕСТЬ варианты, — манифест,
 * который пишет тот же скрипт. Подмена пути происходит только по манифесту,
 * поэтому битой ссылки не бывает: фото, загруженное оператором в рантайме
 * (S3 или /tmp-фолбэк), в манифест не попадает и едет оригиналом. Молча отдать
 * оригинал — правильная деградация; отдать 404 — нет.
 */

import manifest from './photo-variants.json';

const VARIANTS = new Map<string, number[]>(
  (manifest as Array<{ src: string; widths: number[] }>).map((e) => [e.src, e.widths]),
);

function variantPath(src: string, width: number): string {
  return src.replace(/\.(jpe?g|png)$/i, `.${width}.webp`);
}

/**
 * Путь к варианту нужной ширины. Нет варианта — оригинал.
 * Ширина 1280 при отсутствии (узкий исходник) деградирует до 640.
 */
export function photoSrc(src: string | null | undefined, width: 640 | 1280): string {
  if (!src) return '';
  const widths = VARIANTS.get(src);
  if (!widths) return src;
  const w = widths.includes(width) ? width : Math.max(...widths);
  return variantPath(src, w);
}

/**
 * Значение srcSet для <img>: все нарезанные ширины. Нет вариантов — undefined,
 * чтобы браузер просто использовал src.
 */
export function photoSrcSet(src: string | null | undefined): string | undefined {
  if (!src) return undefined;
  const widths = VARIANTS.get(src);
  if (!widths || widths.length === 0) return undefined;
  return widths.map((w) => `${variantPath(src, w)} ${w}w`).join(', ');
}
