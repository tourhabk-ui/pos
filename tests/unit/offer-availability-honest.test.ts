/**
 * Offer.availability называет правду о датах тура (аудит vedarai.ru 01.10).
 *
 * Разметка объявляла `InStock` у каждого тура всегда: вне сезона, при всех
 * разобранных датах и когда дат не публиковали вовсе. Выдача обещала «в
 * наличии», а человек не находил ни одной даты.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { availabilityFromDates } from '@/lib/tours/open-dates';
import { buildTourStructuredData } from '@/lib/seo/tour-structured-data';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

describe('ответ по датам', () => {
  it('свободная дата — в продаже, все разобраны — мест нет', () => {
    expect(availabilityFromDates({ recorded: 5, open: 2 })).toBe('https://schema.org/InStock');
    expect(availabilityFromDates({ recorded: 5, open: 0 })).toBe('https://schema.org/SoldOut');
  });
  it('дат не записано или не сосчитали — утверждать нечего', () => {
    expect(availabilityFromDates({ recorded: 0, open: 0 })).toBeNull();
    expect(availabilityFromDates(null)).toBeNull();
  });
});

describe('разметка карточки тура', () => {
  const tour = { id: 7, title: 'Тур', base_price: 1000, operator_name: 'Оператор' };
  const offerOf = (availability: Parameters<typeof availabilityFromDates>[0]) => {
    const g = buildTourStructuredData(tour, [], {
      canonicalUrl: 'https://vedarai.ru/catalog/tours/7',
      siteUrl: 'https://vedarai.ru',
      activityLabel: 'Треккинг',
      availability: availabilityFromDates(availability),
    }) as { '@graph': Array<Record<string, unknown>> };
    const product = g['@graph'].find(n => n['@type'] === 'Product')!;
    return product.offers as Record<string, unknown>;
  };

  it('нет данных — поля нет вовсе, а не InStock по умолчанию', () => {
    expect('availability' in offerOf(null)).toBe(false);
  });
  it('все даты разобраны — SoldOut', () => {
    expect(offerOf({ recorded: 3, open: 0 }).availability).toBe('https://schema.org/SoldOut');
  });

  it('обе страницы тура считают даты и передают ответ', () => {
    for (const f of ['app/catalog/tours/[id]/page.tsx']) {
      const src = read(f);
      expect(src, f).toMatch(/countTourDates\(tour\.id\)/);
      expect(src, f).toMatch(/availability: availabilityFromDates\(dates\)/);
    }
  });
});

describe('InStock литералом не объявляется нигде', () => {
  it('в app/ и lib/ нет захардкоженного InStock', () => {
    const bad: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) { walk(rel); continue; }
        if (!/\.tsx?$/.test(e.name) || rel === 'lib/tours/open-dates.ts') continue;
        if (/availability:\s*'https:\/\/schema\.org\/InStock'/.test(read(rel))) bad.push(rel);
      }
    };
    walk('app');
    walk('lib');
    expect(bad).toEqual([]);
  });
});
