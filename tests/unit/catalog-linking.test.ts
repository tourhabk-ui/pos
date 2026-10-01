/**
 * Перелинковка каталога (аудит vedarai.ru 01.10).
 *
 * Обход по ссылкам с главной дошёл до 826 страниц из 904 при глубине 10.
 * Не дошёл до 66 маршрутов, 4 мест, 6 парков. Причины:
 * - страницы каталога связывала одна цепочка «назад / вперёд»;
 * - canonical `/routes?page=2` указывал на первую страницу, и поисковик
 *   выбрасывал вторую и дальше как дубль;
 * - на /places пагинация вела на /routes?kind=place;
 * - полоса парков собиралась в браузере, в первом HTML ссылок не было.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pageSlots, parsePage, catalogCanonical, ALL_PAGES_MAX } from '@/lib/seo/catalog-paging';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

describe('номера страниц', () => {
  it('до ALL_PAGES_MAX — все страницы, каждая в одном переходе от первой', () => {
    expect(pageSlots(1, 17)).toEqual(Array.from({ length: 17 }, (_, i) => i + 1));
    expect(pageSlots(9, ALL_PAGES_MAX)).toHaveLength(ALL_PAGES_MAX);
  });

  it('больше — окно вокруг текущей, первая и последняя', () => {
    expect(pageSlots(1, 40)).toEqual([1, 2, 3, 'gap', 40]);
    expect(pageSlots(20, 40)).toEqual([1, 'gap', 18, 19, 20, 21, 22, 'gap', 40]);
    expect(pageSlots(40, 40)).toEqual([1, 'gap', 38, 39, 40]);
    expect(pageSlots(4, 40)).toEqual([1, 2, 3, 4, 5, 6, 'gap', 40]);
  });

  it('одна страница — пагинации нет', () => {
    expect(pageSlots(1, 1)).toEqual([]);
    expect(pageSlots(1, 0)).toEqual([]);
  });

  it('номер из адреса: мусор и ноль — первая', () => {
    expect(parsePage('3')).toBe(3);
    expect(parsePage('')).toBe(1);
    expect(parsePage('0')).toBe(1);
    expect(parsePage('-2')).toBe(1);
    expect(parsePage('abc')).toBe(1);
  });
});

describe('canonical каталога', () => {
  const S = 'https://vedarai.ru';
  it('страница N без фильтров — свой адрес', () => {
    expect(catalogCanonical(S, '/routes', 2, false)).toBe('https://vedarai.ru/routes?page=2');
    expect(catalogCanonical(S, '/places', 5, false)).toBe('https://vedarai.ru/places?page=5');
  });
  it('первая страница и любой фильтр — раздел', () => {
    expect(catalogCanonical(S, '/routes', 1, false)).toBe('https://vedarai.ru/routes');
    expect(catalogCanonical(S, '/routes', 3, true)).toBe('https://vedarai.ru/routes');
  });

  it('обе страницы считают canonical от номера, а не ставят раздел всегда', () => {
    for (const f of ['app/routes/(list)/page.tsx', 'app/places/page.tsx']) {
      const src = read(f);
      expect(src, f).toMatch(/export async function generateMetadata/);
      expect(src, f).toMatch(/catalogCanonical\(/);
      expect(src, f).not.toMatch(/export const metadata/);
    }
    // Вкладка мест на /routes — дубль /places.
    expect(read('app/routes/(list)/page.tsx')).toMatch(/isPlaces \? '\/places' : '\/routes'/);
  });
});

describe('ссылки пагинации', () => {
  const client = read('app/routes/_RoutesPageClient.tsx');

  it('раздел /places ссылается на /places, а не на /routes?kind=place', () => {
    expect(client).toMatch(/const basePath = lockedKind === 'place' \? '\/places' : '\/routes'/);
    expect(client).not.toMatch(/return `\/routes\$\{/);
    expect(client).not.toMatch(/router\.replace\(`\/routes\$\{/);
  });

  it('номера страниц — ссылки', () => {
    expect(client).toMatch(/pageSlots\(page, meta\.pages\)/);
    expect(client).toMatch(/href=\{pageHref\(slot\)\}/);
  });
});

describe('парки в первом HTML', () => {
  it('обе страницы каталога читают парки на сервере и отдают клиенту', () => {
    for (const f of ['app/routes/(list)/page.tsx', 'app/places/page.tsx']) {
      const src = read(f);
      expect(src, f).toMatch(/listActiveParks\(\)/);
      expect(src, f).toMatch(/initialParks=\{/);
    }
    expect(read('app/routes/_RoutesPageClient.tsx')).toMatch(/<ParksStrip initialParks=\{initialParks\} \/>/);
  });

  it('полоса не идёт в сеть, когда список пришёл с сервера', () => {
    const strip = read('components/routes/ParksStrip.tsx');
    expect(strip).toMatch(/if \(initialParks !== null\) return;/);
    expect(strip).toMatch(/useState<ParkLite\[\]>\(initialParks \?\? \[\]\)/);
  });
});

describe('заголовок парка помещается в выдачу', () => {
  it('самое длинное имя парка с « | Ведар» — не длиннее TITLE_LIMIT', async () => {
    const { fitTitle, PARK_TITLE_TAILS, BRAND_SUFFIX, TITLE_LIMIT } = await import('@/lib/seo/title-fit');
    for (const n of ['Природный парк «Быстринский»', 'Командорский заповедник', 'Природный парк «Налычево»']) {
      expect((fitTitle(n, PARK_TITLE_TAILS) + BRAND_SUFFIX).length, n).toBeLessThanOrEqual(TITLE_LIMIT);
    }
    expect(read('app/park/[slug]/page.tsx')).toMatch(/fitTitle\(name, PARK_TITLE_TAILS\)/);
  });
});
