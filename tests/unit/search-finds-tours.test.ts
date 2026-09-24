// @vitest-environment node
/**
 * Поиск находит туры (аудит П7, находки #1/#97/#106/#111, 24.09).
 *
 * До этого дня поиск в шапке (`/api/search`) не знал `operator_tours` вовсе:
 * на «рыбалка» при семи рыболовных турах в продаже модалка отвечала «Ничего
 * не найдено», а отказ API (`success:false`) глотала тем же текстом. Поиск
 * героя главной вёл на /routes?q=…, где туров не было тоже.
 *
 * Сторож держит связку целиком:
 *   1. строка запроса → вид активности единого словаря (без нового движка);
 *   2. /api/search отдаёт туры ПЕРВЫМИ, с ценой «от N ₽» и ссылкой на
 *      /catalog/tours/{id}; отказ туров назван в ответе, а не пуст;
 *   3. модалка знает тип `tour`, «Туры» — первый быстрый переход, отказ API
 *      показан как «Поиск сейчас не работает», Enter открывает первый;
 *   4. /routes при непустом q рисует блок «Туры по запросу» через lib/search.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NextRequest } from 'next/server';

const queryMock = vi.fn();
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => queryMock(...a) }));
vi.mock('@/lib/ai/embeddings', () => ({ semanticSearch: vi.fn().mockResolvedValue([]) }));

const toursMock = vi.fn();
vi.mock('@/lib/search/tour-search', async () => {
  const { z } = await import('zod');
  return {
    MarketplaceToursQuerySchema: z.object({
      search: z.string().optional(),
      activity_type: z.string().optional(),
      sort: z.string().default('recommended'),
      limit: z.number().default(50),
    }),
    queryMarketplaceTours: (...a: unknown[]) => toursMock(...a),
  };
});

import { activityTypesForQuery, findToursForQuery, tourPriceFrom } from '@/lib/search/tour-query-match';
import { GET } from '@/app/api/search/route';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

function tour(id: number, title: string, activity_type: string, base_price: string | null = '25000.00') {
  return { id, title, activity_type, base_price, operator_name: 'Оператор', price_unit: 'per_person' };
}

const FISHING = [4, 6, 5, 9, 11, 10, 7].map(id => tour(id, `Рыбалка ${id}`, 'fishing'));

beforeEach(() => {
  vi.clearAllMocks();
  queryMock.mockResolvedValue({ rows: [] });
});

describe('строка запроса → вид активности', () => {
  it('рыбалка в любом падеже → fishing, сплав → rafting', () => {
    expect(activityTypesForQuery('рыбалка')).toEqual(['fishing']);
    expect(activityTypesForQuery('Рыбалку на Камчатке')).toEqual(['fishing']);
    expect(activityTypesForQuery('сплав')).toEqual(['rafting']);
  });
  it('название реки и короткие слова вид активности не называют', () => {
    expect(activityTypesForQuery('Быстрая')).toEqual([]);
    expect(activityTypesForQuery('тур на')).toEqual([]);
  });
});

describe('findToursForQuery', () => {
  it('текст первым, вид активности следом, без повторов', async () => {
    toursMock.mockImplementation((f: { search?: string; activity_type?: string }) =>
      Promise.resolve({ tours: f.search ? FISHING.slice(0, 3) : FISHING, total: 0 }),
    );
    const got = await findToursForQuery('рыбалка', 10);
    expect(got.map(t => t.id)).toEqual([4, 6, 5, 9, 11, 10, 7]);
  });
  it('отказ БД не глушится', async () => {
    toursMock.mockRejectedValue(new Error('db down'));
    await expect(findToursForQuery('рыбалка', 10)).rejects.toThrow('db down');
  });
});

describe('tourPriceFrom', () => {
  it('цена из данных, пустая и нулевая — null, не «от 0 ₽»', () => {
    expect(tourPriceFrom('25000.00')?.replace(/\s/g, ' ')).toBe('от 25 000 ₽');
    expect(tourPriceFrom(null)).toBeNull();
    expect(tourPriceFrom('0')).toBeNull();
  });
});

function req(q: string): NextRequest {
  return new Request(`http://localhost/api/search?q=${encodeURIComponent(q)}&limit=10`) as unknown as NextRequest;
}

describe('GET /api/search — туры', () => {
  it('туры первыми, с ценой и ссылкой на карточку каталога', async () => {
    toursMock.mockResolvedValue({ tours: FISHING, total: 7 });
    queryMock.mockImplementation((sql: string) =>
      Promise.resolve({ rows: String(sql).includes('FROM places') ? [{ id: 'p1', title: 'Рыбное место', location_type: 'lake' }] : [] }),
    );
    const res = await GET(req('рыбалка'));
    const json = await res.json();
    expect(res.status).toBe(200);
    const types = json.data.map((r: { type: string }) => r.type);
    expect(types.slice(0, 7)).toEqual(Array(7).fill('tour'));
    expect(types[7]).toBe('place');
    expect(json.data[0].href).toBe('/catalog/tours/4');
    expect(json.data[0].subtitle.replace(/\s/g, ' ')).toContain('от 25 000 ₽');
  });

  it('отказ туров назван в ответе, места всё равно отдаются', async () => {
    toursMock.mockRejectedValue(new Error('operator_tours down'));
    queryMock.mockImplementation((sql: string) =>
      Promise.resolve({ rows: String(sql).includes('FROM places') ? [{ id: 'p1', title: 'Озеро', location_type: 'lake' }] : [] }),
    );
    const res = await GET(req('озеро'));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.unavailable).toEqual(['tours']);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('отказ мест и маршрутов не прячет туры', async () => {
    toursMock.mockResolvedValue({ tours: FISHING.slice(0, 1), total: 1 });
    queryMock.mockRejectedValue(new Error('column "location_type" does not exist'));
    const res = await GET(req('рыбалка'));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data[0].type).toBe('tour');
    expect(json.unavailable).toEqual(['geo']);
  });

  it('отказ всего — 500, а не пустой успех', async () => {
    toursMock.mockRejectedValue(new Error('down'));
    queryMock.mockRejectedValue(new Error('down'));
    const res = await GET(req('рыбалка'));
    expect(res.status).toBe(500);
  });

  it('роут не пишет свой SQL по operator_tours — только через lib/search', () => {
    const route = read('app/api/search/route.ts');
    expect(route).not.toMatch(/FROM\s+operator_tours/i);
    expect(route).toMatch(/from '@\/lib\/search\/tour-query-match'/);
  });
});

describe('GlobalSearchModal', () => {
  const MODAL = read('components/search/GlobalSearchModal.tsx');

  it('знает тип tour и ставит «Туры» первым быстрым переходом', () => {
    expect(MODAL).toMatch(/\n\s+tour:\s+\{ label: 'Тур'/);
    const quick = MODAL.slice(MODAL.indexOf('const QUICK_LINKS'));
    expect(quick).toMatch(/^const QUICK_LINKS[^\n]*\n\s+\{ title: 'Туры',\s+href: '\/catalog'/);
  });

  it('отказ API — «Поиск сейчас не работает» и лог, а не «Ничего не найдено»', () => {
    expect(MODAL).not.toMatch(/catch\s*\{\s*\/\*\s*silent/);
    expect(MODAL).toMatch(/Поиск сейчас не работает/);
    expect(MODAL).toMatch(/console\.error\('\[search-modal\]/);
    expect(MODAL).toMatch(/!res\.ok \|\| !json \|\| !json\.success/);
    // «Ничего не найдено» показывается только при исходе ok
    expect(MODAL).toMatch(/status === 'ok' && allItems\.length === 0/);
  });

  it('Enter без выделения открывает первый результат', () => {
    expect(MODAL).toMatch(/activeIndex >= 0 \? allItems\[activeIndex\] : allItems\[0\]/);
  });

  it('телефон: поле 16px, крестик 44px, легенда клавиш только с md', () => {
    expect(MODAL).toMatch(/text-base md:text-sm outline-none/);
    expect(MODAL).toMatch(/aria-label="Закрыть поиск"[^>]*w-11 h-11/);
    expect(MODAL).toMatch(/hidden md:flex items-center justify-between/);
  });
});

describe('/routes — блок «Туры по запросу»', () => {
  const PAGE = read('app/routes/page.tsx');
  it('при непустом q страница спрашивает туры через lib/search и отдаёт блок клиенту', () => {
    expect(PAGE).toMatch(/findToursForQuery\(q, /);
    expect(PAGE).toMatch(/<ToursForQuery q=\{q\} state=\{toursState\}/);
    expect(PAGE).toMatch(/toursSlot=\{/);
    expect(PAGE).not.toMatch(/FROM\s+operator_tours/i);
  });
  it('отказ туров — состояние unavailable, не пустой список', () => {
    expect(PAGE).toMatch(/\{ status: 'unavailable' \}/);
    expect(PAGE).toMatch(/console\.error\('\[routes\] туры по запросу/);
  });
  it('карточка тура в блоке не распирает экран 390 (min-w-0 у элемента сетки)', () => {
    // Снимок 24.09: без min-w-0 элемент сетки брал ширину содержимого, и цена
    // «от 13 000 ₽» уезжала за правый край телефона.
    const BLOCK = read('components/search/ToursForQuery.tsx');
    expect(BLOCK).toMatch(/<li key=\{String\(t\.id\)\} className="min-w-0">/);
  });
  it('клиент рисует слот над вкладками', () => {
    const CLIENT = read('app/routes/_RoutesPageClient.tsx');
    const slot = CLIENT.indexOf('{toursSlot}');
    const tabs = CLIENT.indexOf('Kind tabs');
    expect(slot).toBeGreaterThan(0);
    expect(slot).toBeLessThan(tabs);
  });
});
