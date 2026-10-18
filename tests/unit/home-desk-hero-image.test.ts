/**
 * Десктопный герой главной (вариант А дизайн-аудита 18.10, PR 19.10).
 *
 * Аудит: hero — JPG 600×399, растянут на весь экран, без приоритета. Проверка
 * исходников 19.10: большего оригинала этого снимка в репозитории нет (все
 * IMG_20260316_* — 600–800 px), поэтому ширин 1280/1920/2560 не существует и
 * выдумывать их нельзя. Что можно честно: отдавать реальные нарезанные WebP
 * (манифест ширин этого фото — 320 и 640, фактический файл 640 — 600 px),
 * srcset/sizes и fetchPriority вместо оригинала JPEG через отключённый
 * оптимизатор next/image.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const DESK = readFileSync(join(ROOT, 'components/homepage/desk/DeskHero.tsx'), 'utf-8');
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'lib/images/photo-variants.json'), 'utf-8')) as Array<{ src: string; widths: number[] }>;

describe('десктопный герой: только реальные ширины', () => {
  it('фото берётся через манифест ширин, а не оригинал JPEG напрямую', () => {
    expect(DESK).toContain("photoSrcSet('/images/hero/IMG_20260316_133142.jpg')");
    expect(DESK).toContain("photoSrc('/images/hero/IMG_20260316_133142.jpg', 1280)");
    expect(DESK).not.toContain('<Image');
    expect(DESK).not.toMatch(/src="\/images\/hero\/IMG_20260316_133142\.jpg"/);
  });

  it('первый экран: fetchPriority high и sizes 100vw, alt сохранён', () => {
    expect(DESK).toContain('fetchPriority="high"');
    expect(DESK).toContain('sizes="100vw"');
    expect(DESK).toContain('alt="Скалы Три Брата в Авачинской бухте, на горизонте вулканы"');
  });

  it('манифест не обещает ширин шире исходника 600 px, файлы вариантов лежат на диске', () => {
    const entry = MANIFEST.find(e => e.src === '/images/hero/IMG_20260316_133142.jpg');
    expect(entry, 'записи манифеста для hero нет').toBeDefined();
    expect(Math.max(...entry!.widths)).toBeLessThanOrEqual(640);
    for (const w of entry!.widths) {
      expect(existsSync(join(ROOT, `public/images/hero/IMG_20260316_133142.${w}.webp`)), `нет файла варианта ${w}`).toBe(true);
    }
    expect(DESK).not.toMatch(/1920|2560/);
  });
});
