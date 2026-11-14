/**
 * Правило точки кадра портретного снимка — по пикселям, без списка вручную.
 *
 * Одно на двоих (14.11, слово владельца «1 да»): станок
 * `scripts/photo-focus.mjs` (снимки в хранилище, `npm run images`) и загрузку
 * фото тура оператором (`lib/images/upload-focus.ts`). Поэтому файл — `.mjs`:
 * станок исполняет node без сборки, сайт берёт его через бандлер.
 *
 * Небо, туман и пересвет — ровная заливка без деталей; вершина, лес, человек —
 * детали. Первая строка с деталями (и следующая за ней) — начало содержимого;
 * окно плитки 16:10 ставится чуть выше неё. Подробности — в шапке станка.
 */

/** Ширина, до которой уменьшается снимок для счёта. */
export const SAMPLE_W = 48;
/** Строка с деталями: средняя разница соседних пикселей, 0..255. */
export const TEXTURE_MIN = 6;
/** Содержимое начинается выше этой доли высоты — неба нет, верх кадра. */
export const TOP_T = 0.12;
/** Сколько высоты кадра оставить над началом содержимого. */
export const MARGIN = 0.06;
/** Ширина к высоте у самой узкой плитки, под которую считается точка (16:10). */
export const TILE_RATIO = 1.6;

/**
 * Точка по пикселям уменьшенного снимка (RGB, без альфы) и пропорциям
 * исходника. `null` — точка не нужна: снимок не портретный или деталь в самом
 * верху кадра.
 *
 * @param {{ data: ArrayLike<number>, width: number, height: number, srcW: number, srcH: number }} px
 * @returns {number | null}
 */
export function focusFromPixels({ data, width, height, srcW, srcH }) {
  if (!(srcH > srcW) || width < 2 || height < 2) return null;
  const tex = new Array(height);
  for (let y = 0; y < height; y++) {
    let s = 0;
    let n = 0;
    for (let x = 1; x < width; x++) {
      const i = (y * width + x) * 3;
      for (let c = 0; c < 3; c++) s += Math.abs(data[i + c] - data[i - 3 + c]);
      n += 3;
    }
    if (y > 0) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 3;
        const j = ((y - 1) * width + x) * 3;
        for (let c = 0; c < 3; c++) s += Math.abs(data[i + c] - data[j + c]);
        n += 3;
      }
    }
    tex[y] = s / n;
  }
  let row = height;
  for (let y = 0; y + 1 < height; y++) {
    if (tex[y] >= TEXTURE_MIN && tex[y + 1] >= TEXTURE_MIN) { row = y; break; }
  }
  // Деталей нет вовсе (туман, пересвет): где предмет, правило не знает —
  // снимок остаётся на верхе кадра, а не уезжает вниз наугад.
  if (row === height) return null;
  const t = row / height;
  if (t < TOP_T) return null;
  // Плитка видит долю высоты v; точка p сдвигает окно на p·(1−v). Верх окна —
  // на (t − MARGIN) от высоты кадра.
  const v = srcW / srcH / TILE_RATIO;
  const p = Math.min(1, Math.max(0, (t - MARGIN) / (1 - v)));
  const y = Math.round(p * 20) * 5;
  return y === 0 ? null : y;
}
