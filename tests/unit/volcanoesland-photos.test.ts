/**
 * Фото туров «Края Вулканов» и публикация карточки (миграция 1177, #2245).
 *
 * Держит: каждый путь из миграции лежит в репозитории (404 на hero — худшее,
 * что может случиться с карточкой тура), у всех 11 туров по 5 снимков, hero —
 * первый снимок, фото пишутся только туда, где их нет (загруженное оператором
 * не затирается), карточка партнёра открывается, но не помечается проверенной,
 * оригиналы с раннера (raw/) в репозиторий не попадают, снимки сжаты.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const SQL = readFileSync(join(ROOT, 'migrations/1177_volcanoesland_photos_and_card_public.sql'), 'utf-8');
const CODE = SQL.replace(/--[^\n]*/g, '');

describe('миграция 1177: фото туров «Края Вулканов»', () => {
  const rows = [...CODE.matchAll(/\('(volcanoesland-[a-z0-9-]+)', ARRAY\[([^\]]+)\]::text\[\]\)/g)]
    .map((m) => ({ slug: m[1], photos: [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1]) }));

  it('11 туров по 5 снимков, все файлы лежат в public/images/volcanoesland', () => {
    expect(rows).toHaveLength(11);
    for (const r of rows) {
      expect(r.photos, r.slug).toHaveLength(5);
      for (const p of r.photos) {
        expect(p).toMatch(/^\/images\/volcanoesland\/[a-z0-9-]+-0[1-5]\.jpg$/);
        expect(existsSync(join(ROOT, 'public', p)), p).toBe(true);
        expect(statSync(join(ROOT, 'public', p)).size, p).toBeLessThan(200 * 1024);
      }
    }
  });

  it('hero — первый снимок; пишется только туда, где фото ещё нет; id сравниваются текстом', () => {
    expect(CODE).toMatch(/tour_image = v\.photos\[1\]/);
    expect(CODE).toMatch(/AND COALESCE\(array_length\(t\.photos, 1\), 0\) = 0/);
    expect(CODE).toMatch(/t\.operator_id::text = p\.id::text/);
    expect(CODE).toMatch(/p\.slug = 'volcanoesland'/);
  });

  it('карточка партнёра открывается, но проверенной не становится', () => {
    expect(CODE).toMatch(/UPDATE partners\s+SET is_public = TRUE[\s\S]*WHERE slug = 'volcanoesland'/);
    expect(CODE).not.toMatch(/is_verified\s*=\s*TRUE|registry_status/);
  });

  it('оригиналы с раннера в репозитории не лежат, снимков ровно 55 плюс логотип', () => {
    const dir = join(ROOT, 'public/images/volcanoesland');
    expect(existsSync(join(dir, 'raw'))).toBe(false);
    const jpgs = readdirSync(dir).filter((f) => /^[a-z0-9-]+-0[1-5]\.jpg$/.test(f));
    expect(jpgs).toHaveLength(55);
    expect(existsSync(join(dir, 'logo.png'))).toBe(true);
  });
});
