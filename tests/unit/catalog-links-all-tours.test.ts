/**
 * Каталог ссылается на все туры в первом HTML (08.11).
 *
 * Обход прода 08.11 (SEO, пункт 2 плана владельца): в sitemap 75 туров, а
 * HTML /catalog ссылался на 50. Остальные 25 приезжали только по кнопке
 * «Показать ещё» — робот поисковика её не нажимает, и у трети туров не было
 * ни одной ссылки с главной страницы каталога.
 *
 * Сервер теперь просит первой страницей потолок роута туров. Судится вызовом:
 * что сервер просит и что роут такую страницу принимает (иначе запрос упал бы
 * валидацией, и каталог остался бы без списка вовсе).
 */
import { describe, it, expect } from 'vitest';
import { parseMarketplaceSearchParams, CATALOG_FIRST_PAGE } from '@/lib/tours/marketplace-page';
import { MarketplaceToursQuerySchema } from '@/lib/search';

describe('каталог: первая страница — весь каталог до потолка роута', () => {
  it('сервер просит CATALOG_FIRST_PAGE туров, а не 50', () => {
    const { filters } = parseMarketplaceSearchParams({});
    expect(filters.limit).toBe(CATALOG_FIRST_PAGE);
    expect(CATALOG_FIRST_PAGE, 'на 08.11 живых туров 75 — первая страница обязана вмещать их все')
      .toBeGreaterThanOrEqual(75);
  });

  it('роут туров принимает такую страницу — и это его потолок, а не больше', () => {
    expect(MarketplaceToursQuerySchema.safeParse({ limit: CATALOG_FIRST_PAGE }).success).toBe(true);
    expect(MarketplaceToursQuerySchema.safeParse({ limit: CATALOG_FIRST_PAGE + 1 }).success).toBe(false);
  });

  it('с фильтрами из адреса — тот же размер первой страницы', () => {
    const { filters } = parseMarketplaceSearchParams({ activity_type: 'fishing', sort: 'price_asc' });
    expect(filters.limit).toBe(CATALOG_FIRST_PAGE);
  });
});
