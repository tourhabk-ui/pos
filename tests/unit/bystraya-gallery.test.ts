/**
 * Сторож миграции 813: у тура сплава есть галерея, а не одно фото.
 *
 * Повод: на проде у тура было `photos: 0` — карточка честно показывала один
 * `tour_image`, хотя оператор прислал девять кадров. Цепочка отказов:
 *   • 795 ставила галерею, но матчила ДЛИННОЕ название — это дубль, а не тот
 *     тур, который видит турист;
 *   • 806 матчила правильно, но упала целиком из-за INSERT INTO partners;
 *   • 810 подняла тур из небытия, но фото намеренно не трогала.
 *
 * Отсюда главное требование к 813: она не имеет права упасть по той же причине.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const src = readFileSync(join(ROOT, 'migrations/813_bystraya_gallery_restore.sql'), 'utf-8');
const sql = src.split('\n').filter(l => !l.trim().startsWith('--')).join('\n');

/** Пути к фото, которые миграция прописывает в галерею. */
const photos = [...sql.matchAll(/'(\/images\/tours\/bystraya-rafting\/[^']+)'/g)]
  .map(m => m[1]);

describe('миграция 813 — галерея тура сплава', () => {
  it('НЕ вставляет строк: именно INSERT уронил 806', () => {
    expect(sql).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(sql).toMatch(/\bUPDATE operator_tours\b/);
  });

  it('ставит галерею из восьми кадров', () => {
    const gallery = [...new Set(photos)];
    expect(gallery.length).toBeGreaterThanOrEqual(8);
  });

  it('все файлы галереи реально лежат в репозитории', () => {
    // Битый путь дал бы пустые плитки вместо фото — это хуже одного кадра.
    for (const p of new Set(photos)) {
      expect(existsSync(join(ROOT, 'public', p)), `нет файла: ${p}`).toBe(true);
    }
  });

  it('трогает ровно один тур — канонический', () => {
    expect(sql).toContain('WITH canonical AS');
    expect(sql).toMatch(/LIMIT 1/);
    expect(sql).toMatch(/FROM canonical c/);
  });

  it('матч по содержанию, а не по хрупкому длинному названию', () => {
    expect(sql).toMatch(/title ILIKE '%быстр%'/i);
    expect(sql).not.toContain('Однодневная экскурсия СПЛАВ ПО РЕКЕ БЫСТРАЯ');
  });

  it('идемпотентна: повторный прогон галерею не переписывает', () => {
    expect(sql).toMatch(/array_length\(ot\.photos, 1\), 0\) < 8/);
  });

  it('рабочую обложку не затирает', () => {
    expect(sql).toMatch(/COALESCE\(NULLIF\(ot\.tour_image, ''\)/);
  });
});
