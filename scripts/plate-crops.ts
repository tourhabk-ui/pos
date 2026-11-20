/**
 * scripts/plate-crops.ts — копии снимков, обрезанные под плитку 4:3
 * (правила — lib/images/plate-crop.ts; #3564 п.1).
 *
 * Входы — снимки манифеста lib/images/photo-variants.json с копией 640: то,
 * что плитка и так берёт уменьшенным. Точка кадра — `photoFocusY` (тот же
 * порядок, что у плитки: ручная, посчитанная станком, пометка в имени, верх
 * кадра), поэтому скрипт идёт после scripts/photo-focus.mjs в `npm run images`.
 *
 * Пишет:
 *   - `<имя>.plate<точка>.webp` рядом с исходником в media/s3/photos (снимки
 *     плиток живут в хранилище); копия с другой точкой того же снимка удаляется;
 *   - lib/images/plate-crops.json — «адрес снимка → адрес копии»;
 *   - строки маркера .github/triggers/media-to-s3.json для копий из media/s3
 *     (без строки копия лежит в репозитории, а в хранилище её нет); строка
 *     удалённой копии из маркера убирается. Объект в хранилище остаётся:
 *     его никто не читает, а удалять из бакета этот путь не умеет.
 *
 * Идемпотентен: готовая копия с той же точкой не пересоздаётся.
 *
 *   npx tsx scripts/plate-crops.ts
 *
 * Сторож: tests/unit/plate-crops.test.ts.
 */
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { photoFocusY } from '@/lib/tours/photo-focus';
import { plateCropBox, plateCropPath, plateCropFocus, PLATE_WIDTH, PLATE_HEIGHT } from '@/lib/images/plate-crop';

const ROOT = process.cwd();
const VARIANTS = path.join(ROOT, 'lib/images/photo-variants.json');
const OUT = path.join(ROOT, 'lib/images/plate-crops.json');
const MARKER = path.join(ROOT, '.github/triggers/media-to-s3.json');
/** Качество — как у копии 640 (scripts/optimize-images.mjs). */
const QUALITY = 72;

/** Адрес раздачи → файл в репозитории. */
export function fileOf(src: string): string {
  if (src.startsWith('/api/images/s3/')) return path.join(ROOT, 'media/s3', src.slice('/api/images/s3/'.length));
  return path.join(ROOT, 'public', src.replace(/^\//, ''));
}

async function main(): Promise<void> {
  const variants = JSON.parse(readFileSync(VARIANTS, 'utf8')) as Array<{ src: string; widths: number[] }>;
  const crops: Record<string, string> = {};
  const removed: string[] = [];
  let made = 0;
  let kept = 0;

  for (const { src, widths } of variants) {
    // Плитки показывают снимки туров, жилья и перевозчиков — они в хранилище.
    // Оформление сайта (public/images: герой, фоны) в плитку не попадает.
    if (!src.startsWith('/api/images/s3/') || !widths.includes(640)) continue;
    const file = fileOf(src);
    if (!existsSync(file)) continue;
    const fy = photoFocusY(src) ?? 0;
    const want = plateCropPath(src, fy);

    // Копии этого снимка с другой точкой — устарели.
    const dir = path.dirname(file);
    const base = path.basename(file).replace(/\.(jpe?g|png)$/i, '');
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(`${base}.plate`) || plateCropFocus(name) === null) continue;
      if (name === path.basename(fileOf(want))) continue;
      unlinkSync(path.join(dir, name));
      removed.push(path.join(path.dirname(src), name).split(path.sep).join('/'));
    }

    // Размер — после поворота по EXIF: так снимок видит браузер.
    const upright = await sharp(file).rotate().toBuffer({ resolveWithObject: true });
    const box = plateCropBox(upright.info.width, upright.info.height, fy);
    if (!box) continue;
    crops[src] = want;
    const out = fileOf(want);
    if (existsSync(out)) { kept++; continue; }
    await sharp(upright.data).extract(box).resize(PLATE_WIDTH, PLATE_HEIGHT).webp({ quality: QUALITY }).toFile(out);
    made++;
  }

  const sorted = Object.fromEntries(Object.entries(crops).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(OUT, JSON.stringify(sorted, null, 2) + '\n');

  // Маркер заливки: строки копий из media/s3 — ровно по списку.
  const marker = JSON.parse(readFileSync(MARKER, 'utf8')) as { items: Array<{ file: string; key: string }> };
  const s3Crops = Object.values(sorted)
    .filter((p) => p.startsWith('/api/images/s3/'))
    .map((p) => p.slice('/api/images/s3/'.length));
  const wanted = new Set(s3Crops);
  const before = marker.items.length;
  marker.items = marker.items.filter((it) => plateCropFocus(it.key) === null || wanted.has(it.key));
  const have = new Set(marker.items.map((it) => it.key));
  for (const key of s3Crops) if (!have.has(key)) marker.items.push({ file: `media/s3/${key}`, key });
  writeFileSync(MARKER, JSON.stringify(marker, null, 2) + '\n');

  console.log(`[plate] копий 4:3: ${Object.keys(sorted).length} (создано ${made}, готовы ${kept}), устаревших удалено: ${removed.length}`);
  console.log(`[plate] строк маркера: было ${before}, стало ${marker.items.length}`);
}

main().catch((err: unknown) => {
  console.error('[plate] отказ:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
