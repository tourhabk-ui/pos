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
 * Снимок, загруженный оператором в рантайме, сюда не попадает: ему точку
 * считает сама загрузка тем же правилом и пишет в имя файла
 * (lib/images/upload-focus.ts, 14.11).
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
import { SAMPLE_W, focusFromPixels } from '../lib/images/focus-from-pixels.mjs';

// Правило одно на станок и на загрузку оператором (14.11): lib/images/focus-from-pixels.mjs.
export {
  SAMPLE_W, TEXTURE_MIN, TOP_T, MARGIN, TILE_RATIO, focusFromPixels,
} from '../lib/images/focus-from-pixels.mjs';

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
