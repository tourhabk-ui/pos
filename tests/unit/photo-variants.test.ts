/**
 * Фото не грузятся оригиналами: варианты нарезаны, подключены и не врут.
 *
 * Владелец 06.08 с телефона: «фото долго грузится, нужно адаптировать».
 * Оптимизатор Next выключен осознанно (sharp не влезает в лимит standalone на
 * Timeweb), поэтому «оптимизации по умолчанию» нет и не будет: карточки грузили
 * оригиналы 150–320 КБ, галерея тура — 1,7 МБ разом. На полевом EDGE — десятки
 * секунд. Решение — заранее нарезанные WebP-варианты (тот же приём, что у
 * бренд-графики) + манифест + хелпер, который подменяет путь ТОЛЬКО если
 * вариант существует.
 *
 * Сторож держит три вещи:
 *   1) тяжёлое фото нельзя закоммитить, не нарезав варианты (иначе оно снова
 *      поедет оригиналом и никто не заметит до жалобы с поля);
 *   2) манифест не врёт — каждый заявленный вариант существует на диске;
 *   3) поверхности, на которые указывал владелец, реально подключены.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { photoSrc, photoSrcSet } from '@/lib/images/variant';
import manifest from '@/lib/images/photo-variants.json';

const ROOT = process.cwd();
const IMAGES = join(ROOT, 'public', 'images');
const MIN_BYTES = 50 * 1024; // тот же порог, что в scripts/optimize-images.mjs

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

const entries = manifest as Array<{ src: string; widths: number[] }>;
const inManifest = new Set(entries.map((e) => e.src));

describe('нарезка покрывает все тяжёлые фото', () => {
  it('каждый jpg/png тяжелее порога есть в манифесте', () => {
    const missing: string[] = [];
    for (const file of walk(IMAGES)) {
      if (!/\.(jpe?g|png)$/i.test(file) || /\.(640|1280)\.webp$/.test(file)) continue;
      if (statSync(file).size < MIN_BYTES) continue;
      const web = '/' + file.slice(join(ROOT, 'public').length + 1).split('\\').join('/');
      if (!inManifest.has(web)) missing.push(web);
    }
    expect(
      missing,
      `Тяжёлые фото без вариантов — прогоните \`npm run images\` и закоммитьте результат:\n${missing.join('\n')}`,
    ).toEqual([]);
  });

  it('манифест не врёт: каждый заявленный вариант существует', () => {
    const broken: string[] = [];
    for (const e of entries) {
      for (const w of e.widths) {
        const variant = e.src.replace(/\.(jpe?g|png)$/i, `.${w}.webp`);
        if (!existsSync(join(ROOT, 'public', variant))) broken.push(variant);
      }
    }
    expect(broken, broken.join('\n')).toEqual([]);
  });

  it('варианты действительно легче оригиналов', () => {
    // Смысл всей затеи. Если нарезка вдруг станет тяжелее исходника,
    // «оптимизация» превратится в замедление — молча.
    let orig = 0, cut = 0;
    for (const e of entries) {
      const src = join(ROOT, 'public', e.src);
      if (!existsSync(src)) continue;
      orig += statSync(src).size;
      const w = Math.min(...e.widths);
      cut += statSync(join(ROOT, 'public', e.src.replace(/\.(jpe?g|png)$/i, `.${w}.webp`))).size;
    }
    expect(cut).toBeLessThan(orig * 0.6);
  });
});

describe('хелпер подменяет путь только по манифесту', () => {
  const known = entries.find((e) => e.widths.includes(640) && e.widths.includes(1280));

  it('для фото из манифеста отдаёт вариант', () => {
    expect(known, 'в манифесте нет фото с обеими ширинами').toBeDefined();
    const out = photoSrc(known!.src, 640);
    expect(out).toMatch(/\.640\.webp$/);
  });

  it('1280 деградирует до 640, если широкого варианта нет', () => {
    const narrow = entries.find((e) => e.widths.length === 1 && e.widths[0] === 640);
    if (!narrow) return; // допустимо: все исходники широкие
    expect(photoSrc(narrow.src, 1280)).toMatch(/\.640\.webp$/);
  });

  it('незнакомый путь остаётся как есть — загрузки операторов и S3', () => {
    for (const src of ['/images/tours/uploaded-later.jpg', 'https://s3.twcstorage.ru/x/y.jpg']) {
      expect(photoSrc(src, 640)).toBe(src);
      expect(photoSrcSet(src)).toBeUndefined();
    }
  });

  it('пустое значение не ломает рендер', () => {
    expect(photoSrc(null, 640)).toBe('');
    expect(photoSrc(undefined, 1280)).toBe('');
  });
});

describe('поверхности с жалобы владельца подключены', () => {
  it('главная: карточка и плитки идут через photoSrc', () => {
    const src = readFileSync(join(ROOT, 'app/_home/_HomeV8Client.tsx'), 'utf-8');
    const calls = src.match(/photoSrc\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
    // Оригинал в background-image напрямую — снова та же жалоба.
    expect(src).not.toMatch(/backgroundImage: `url\('\$\{plates\[0\]\.imageUrl\}'\)`/);
    expect(src).not.toMatch(/backgroundImage: `url\('\$\{p\.imageUrl\}'\)`/);
  });

  it('карточка тура: герой и филмстрип идут через photoSrc', () => {
    const src = readFileSync(join(ROOT, 'app/marketplace/tours/[id]/_TourDetailClient.tsx'), 'utf-8');
    expect(src).toMatch(/Image src=\{photoSrc\(heroImg, 1280\)\}/);
    expect(src).toMatch(/Image src=\{photoSrc\(src, 640\)\}/);
  });

  it('каталог туров идёт через photoSrc', () => {
    const src = readFileSync(join(ROOT, 'components/marketplace/MarketplaceClient.tsx'), 'utf-8');
    expect(src).toMatch(/photoSrc\(tour\.tour_image/);
  });

  it('лайтбокс остаётся на оригинале — полное качество по запросу', () => {
    const src = readFileSync(join(ROOT, 'app/marketplace/tours/[id]/_TourDetailClient.tsx'), 'utf-8');
    expect(src).toMatch(/Image src=\{images\[idx\]\}/);
  });

  it('статика фото кэшируется — повторный визит не платит второй раз', () => {
    const cfg = readFileSync(join(ROOT, 'next.config.js'), 'utf-8');
    expect(cfg).toMatch(/source: '\/images\/:path\*'/);
    expect(cfg).toMatch(/max-age=604800/);
  });
});
