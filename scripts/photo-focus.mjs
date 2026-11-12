#!/usr/bin/env node
/**
 * Точка кадра портретных снимков — по самому снимку, без списка вручную.
 *
 * Владелец 12.11: «и на десктопной тоже небо вместо локаций». Плитка каталога
 * 16:10 показывает портрет 3:4 лишь на 47% высоты. Верх кадра (`50% 0%`)
 * держит голову рыбака, но у пейзажа, снятого вертикально, наверху небо — и
 * плитка была голубым прямоугольником. Список проверенных точек
 * (`PHOTO_FOCUS_Y` в lib/tours/photo-focus.ts) лечит снимки, которые кто-то
 * посмотрел; новая вертикальная обложка снова показала бы небо, пока её не
 * впишут руками («карт-бланш» владельца на то, чтобы так больше не было).
 *
 * Правило одно и простое, потому что его читают глазами:
 *   небо, туман и пересвет — ровная заливка без деталей;
 *   вершина, лес, человек, машина — детали.
 * Снимок уменьшается до 48 px по ширине, для каждой строки считается, насколько
 * соседние пиксели отличаются друг от друга. Первая строка с деталями (и
 * следующая за ней тоже — одиночная строка бывает шумом) — начало содержимого.
 * Окно плитки ставится так, чтобы его верх был чуть выше этой строки
 * (`MARGIN`): вершина вулкана целиком, голова человека целиком, а небо над
 * ними срезано. Деталь в самом верху кадра (`TOP_T`) — значит, неба там нет, и
 * снимок остаётся на верхе кадра, как раньше: так рыбак во весь рост не теряет
 * голову ни при каком раскладе. Деталей нет нигде — правило не знает, где
 * предмет, и тоже не двигает кадр.
 *
 * Пишет lib/images/photo-focus.json: ключ снимка (как `photoFocusKey`) →
 * точка 0..100 с шагом 5. Только снимкам, которым нужна точка ниже верха;
 * остальные в файл не попадают и едут на `50% 0%`. Ручной список главнее.
 *
 * Входит в `npm run images`: тот же станок, что режет копии 320/640/1280.
 * Снимок, загруженный оператором в рантайме, сюда не попадает и стоит на верхе
 * кадра — как фото без копий едет оригиналом.
 *
 * sharp — devDependency, в прод-бандл не попадает.
 * Сторож: tests/unit/photo-focus-auto.test.ts (файл совпадает с тем, что
 * правило даёт на снимках с диска; правило — на синтетических кадрах).
 */

import { readdir, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

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

/** Точка снимка с диска (с учётом поворота по EXIF). */
export async function photoFocusFor(file) {
  const meta = await sharp(file).metadata();
  let srcW = meta.width ?? 0;
  let srcH = meta.height ?? 0;
  if ((meta.orientation ?? 1) >= 5) [srcW, srcH] = [srcH, srcW];
  if (!(srcH > srcW)) return null;
  const width = SAMPLE_W;
  const height = Math.max(2, Math.round((SAMPLE_W * srcH) / srcW));
  const data = await sharp(file)
    .rotate()
    .resize(width, height, { fit: 'fill' })
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer();
  return focusFromPixels({ data, width, height, srcW, srcH });
}

const ROOT = process.cwd();
/** Снимки туров живут в хранилище (08.11): media/s3/photos. */
export const PHOTOS_DIR = path.join(ROOT, 'media', 's3', 'photos');
export const FOCUS_MANIFEST = path.join(ROOT, 'lib', 'images', 'photo-focus.json');
/** Исходники; копии `.320/.640/.1280.webp` — не входы. */
export const SOURCE_RE = /\.(jpe?g|png)$/i;

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (SOURCE_RE.test(entry.name)) yield full;
  }
}

/** Ключ, как у `photoFocusKey`: путь под photos/ без расширения. */
export function keyOf(file) {
  return path.relative(PHOTOS_DIR, file).split(path.sep).join('/').replace(SOURCE_RE, '');
}

async function main() {
  const out = {};
  let portraits = 0;
  if (existsSync(PHOTOS_DIR)) {
    for await (const file of walk(PHOTOS_DIR)) {
      const y = await photoFocusFor(file);
      const meta = await sharp(file).metadata();
      const rotated = (meta.orientation ?? 1) >= 5;
      const h = rotated ? meta.width : meta.height;
      const w = rotated ? meta.height : meta.width;
      if ((h ?? 0) > (w ?? 0)) portraits++;
      if (y != null) out[keyOf(file)] = y;
    }
  }
  const sorted = Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
  await mkdir(path.dirname(FOCUS_MANIFEST), { recursive: true });
  await writeFile(FOCUS_MANIFEST, JSON.stringify(sorted, null, 2) + '\n');
  process.stdout.write(`[photo-focus] портретных снимков: ${portraits}, с точкой ниже верха: ${Object.keys(sorted).length}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
