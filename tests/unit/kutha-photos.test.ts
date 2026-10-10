/**
 * Сторож: фото и вместимость «Кутхи» (миграция 1204, слово владельца 10.10:
 * «28000 сутки, все даты свободны круглый год, до 12 человек, сумма за весь
 * дом» и двадцать снимков дома).
 *
 * Держит:
 * - каждый снимок из миграции лежит в public/images/kutha, сжат, без
 *   метаданных, а sha256 и размер в базе — от того же файла;
 * - главный кадр — дом снаружи; фото пишутся только объекту без фото;
 * - «до 12 человек» вместо «до 8 мест», «круглый год» — без «все даты
 *   свободны» (бронь идёт мимо платформы, календарь врал бы), и номера
 *   «весь дом» нет: он включил бы форму, которую некому подтвердить;
 * - порядок снимков задан одним правилом во всех чтениях;
 * - карточка показывает все снимки, а не только первый.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { STAY_PHOTO_ORDER_SQL } from '@/lib/stay/photo-order';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const SQL = read('migrations/1204_kutha_photos_capacity.sql');
const CODE = SQL.replace(/--[^\n]*/g, '');

const rows = [...CODE.matchAll(/\('(\/images\/kutha\/[a-z0-9-]+\.jpg)', '([0-9a-f]{64})', (\d+), (\d+), (\d+), '([^']+)'\)/g)]
  .map((m) => ({ url: m[1], sha: m[2], size: Number(m[3]), w: Number(m[4]), h: Number(m[5]), alt: m[6] }));

describe('миграция 1204: снимки «Кутхи»', () => {
  it('двадцать снимков по порядку, первый — дом снаружи', () => {
    expect(rows).toHaveLength(20);
    rows.forEach((r, i) => expect(r.url).toBe(`/images/kutha/kutha-${String(i + 1).padStart(2, '0')}.jpg`));
    expect(rows[0].alt).toMatch(/снаружи/);
  });

  it('файл лежит в репозитории, сжат, без EXIF; sha256 и размер в базе — от него', () => {
    for (const r of rows) {
      const path = join(ROOT, 'public', r.url);
      expect(existsSync(path), r.url).toBe(true);
      const buf = readFileSync(path);
      expect(statSync(path).size, r.url).toBeLessThan(200 * 1024);
      expect(buf.length, r.url).toBe(r.size);
      expect(createHash('sha256').update(buf).digest('hex'), r.url).toBe(r.sha);
      // APP1 «Exif» — там живут координаты съёмки и модель телефона.
      expect(buf.includes(Buffer.from('Exif\0\0')), r.url).toBe(false);
    }
  });

  it('пишет только объекту без фото и не плодит снимки на повторе', () => {
    expect(CODE).toMatch(/NOT EXISTS \(SELECT 1 FROM accommodation_assets aa WHERE aa\.accommodation_id::text = a\.id::text\)/);
    expect(CODE).toMatch(/NOT EXISTS \(SELECT 1 FROM assets s WHERE s\.url = v\.url\)/);
  });

  it('до 12 человек и круглый год; без «все даты свободны» и без номера «весь дом»', () => {
    expect(CODE).toMatch(/до 12 человек/);
    expect(CODE).toMatch(/Принимает гостей круглый год/);
    expect(CODE).not.toMatch(/все даты свободны/i);
    expect(CODE).not.toMatch(/accommodation_rooms|accommodation_availability/);
    // Текст переписывается только поверх 1198, правка администратора цела.
    expect(CODE).toMatch(/description LIKE '%до 8 мест%'/);
    expect(CODE).toMatch(/description LIKE '%28 000 ₽ за сутки за весь дом%'/);
  });
});

describe('порядок снимков и галерея карточки', () => {
  it('одно правило порядка во всех чтениях снимков жилья', () => {
    expect(STAY_PHOTO_ORDER_SQL).toBe('aa.created_at ASC, ast.url ASC');
    const detail = read('lib/stay/accommodation-detail.ts');
    expect(detail.match(/ORDER BY \$\{STAY_PHOTO_ORDER_SQL\}/g)).toHaveLength(2);
    expect(read('app/api/accommodations/route.ts')).toMatch(/ORDER BY \$\{STAY_PHOTO_ORDER_SQL\}\)/);
    expect(read('app/api/stay/bookings/my/route.ts')).toMatch(/ORDER BY \$\{STAY_PHOTO_ORDER_SQL\} LIMIT 1/);
  });

  it('карточка показывает все снимки и открывает их', () => {
    const c = read('app/accommodations/[id]/_AccommodationDetailClient.tsx');
    expect(c).toMatch(/<OperatorGallery images=\{data\.images\.slice\(1\)\.map\(i => i\.url\)\}/);
    expect(c).toMatch(/<PhotoLightbox\s+images=\{data\.images\.map\(i => i\.url\)\}/);
    expect(c).toMatch(/onClick=\{\(\) => setPhoto\(0\)\}/);
  });

  it('названная цена не противоречит фразе «цены — у владельца»', () => {
    const c = read('app/accommodations/[id]/_AccommodationDetailClient.tsx');
    expect(c).toMatch(/data\.pricePerNight\.from != null \? 'Свободные даты и условия' : 'Цены, свободные даты и условия'/);
  });
});
