/**
 * Копии снимков под плитку 4:3 (#3564 п.1, слово владельца «Делать копии
 * 4:3»). Правила — lib/images/plate-crop.ts, нарезка — scripts/plate-crops.ts
 * (`npm run images`), список — lib/images/plate-crops.json.
 *
 * Сторож держит:
 *   - обрезку вызовом: что видит рамка `object-fit: cover` с точкой кадра;
 *   - список по файлам на диске: у каждой копии есть файл 640×480, точка в
 *     имени равна сегодняшней точке снимка (поменяли точку — копию надо
 *     перерезать, иначе плитка показала бы старую обрезку), лишних копий на
 *     диске нет, и у каждого вертикального снимка в хранилище копия есть.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import sharp from 'sharp';
import { plateCropBox, plateCropPath, plateCropFocus, PLATE_MIN_LOSS } from '@/lib/images/plate-crop';
import { photoFocusY } from '@/lib/tours/photo-focus';

const ROOT = process.cwd();
const CROPS = JSON.parse(readFileSync(join(ROOT, 'lib/images/plate-crops.json'), 'utf8')) as Record<string, string>;
const VARIANTS = JSON.parse(readFileSync(join(ROOT, 'lib/images/photo-variants.json'), 'utf8')) as Array<{ src: string; widths: number[] }>;
const S3 = '/api/images/s3/';
const fileOf = (src: string) => join(ROOT, 'media/s3', src.slice(S3.length));

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

describe('обрезка повторяет рамку плитки', () => {
  it('вертикальный кадр: ширина целиком, сверху — по точке кадра', () => {
    expect(plateCropBox(640, 853, 0)).toEqual({ left: 0, top: 0, width: 640, height: 480 });
    // 853 − 480 = 373 строки срезаются; при точке 55% сверху уходит 205.
    expect(plateCropBox(640, 853, 55)).toEqual({ left: 0, top: 205, width: 640, height: 480 });
    expect(plateCropBox(960, 1280, 100)).toEqual({ left: 0, top: 560, width: 960, height: 720 });
  });

  it('широкий кадр, почти 4:3 и узкий исходник — копии нет', () => {
    expect(plateCropBox(1280, 720, 0)).toBeNull();
    expect(plateCropBox(640, 480, 0)).toBeNull();
    // 640×520: рамка срезает 7,7% — меньше порога.
    expect(1 - 480 / 520).toBeLessThan(PLATE_MIN_LOSS);
    expect(plateCropBox(640, 520, 0)).toBeNull();
    expect(plateCropBox(600, 900, 0)).toBeNull();
  });

  it('точка кадра — в имени копии', () => {
    expect(plateCropPath('/api/images/s3/photos/p/a.jpg', 55)).toBe('/api/images/s3/photos/p/a.plate55.webp');
    expect(plateCropFocus('photos/p/a.plate55.webp')).toBe(55);
    expect(plateCropFocus('photos/p/a.640.webp')).toBeNull();
  });
});

describe('список копий сходится с диском и с точками кадра', () => {
  it('у каждой копии есть файл 640×480 WebP, точка в имени — сегодняшняя точка снимка', async () => {
    const bad: string[] = [];
    for (const [src, crop] of Object.entries(CROPS)) {
      if (!src.startsWith(S3) || !existsSync(fileOf(src))) { bad.push(`${src}: исходника нет`); continue; }
      if (crop !== plateCropPath(src, photoFocusY(src) ?? 0)) { bad.push(`${src}: копия ${crop}, точка кадра теперь ${photoFocusY(src) ?? 0}`); continue; }
      if (!existsSync(fileOf(crop))) { bad.push(`${crop}: файла нет`); continue; }
      const m = await sharp(fileOf(crop)).metadata();
      if (m.format !== 'webp' || m.width !== 640 || m.height !== 480) bad.push(`${crop}: ${m.format} ${m.width}×${m.height}`);
    }
    expect(bad, 'прогоните `npm run images` и закоммитьте результат').toEqual([]);
  });

  it('лишних копий на диске нет', () => {
    const listed = new Set(Object.values(CROPS).map((c) => fileOf(c)));
    const stray = filesUnder(join(ROOT, 'media/s3/photos'))
      .filter((f) => plateCropFocus(f) !== null && !listed.has(f))
      .map((f) => relative(ROOT, f));
    expect(stray).toEqual([]);
  });

  it('у каждого вертикального снимка в хранилище с копией 640 есть копия плитки', async () => {
    const missing: string[] = [];
    for (const { src, widths } of VARIANTS) {
      if (!src.startsWith(S3) || !widths.includes(640) || CROPS[src]) continue;
      const file = fileOf(src);
      if (!existsSync(file)) continue;
      const m = await sharp(file).metadata();
      // EXIF 5–8 — снимок повёрнут на 90°: ширина и высота меняются местами.
      const turned = (m.orientation ?? 1) >= 5;
      const w = (turned ? m.height : m.width) ?? 0;
      const h = (turned ? m.width : m.height) ?? 0;
      if (plateCropBox(w, h, photoFocusY(src) ?? 0)) missing.push(src);
    }
    expect(missing, 'прогоните `npm run images` и закоммитьте результат').toEqual([]);
  }, 60_000);
});
