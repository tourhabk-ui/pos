/**
 * Сторож возврата в каталог (голосовой запрос владельца 01.10).
 *
 * Долистал /routes до пятой страницы, открыл маршрут, закрыл — и снова
 * первая страница у первой локации. Правило: выход из карточки возвращает в
 * ТОТ ЖЕ список — страница, фильтры, прокрутка. Держит четыре связки:
 *
 * 1. адрес списка несёт страницу и фильтры, ссылки «назад» ведут на него;
 * 2. уход в карточку запоминает прокрутку, возврат её восстанавливает;
 * 3. номер страницы, которой больше нет, ужимается к последней, не к первой;
 * 4. первая страница по-прежнему открывается с /routes без параметров.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  CATALOG_RETURN_KEY,
  CATALOG_RETURN_TTL_MS,
  catalogReturnHref,
  clampPage,
  isCatalogListUrl,
  readCatalogReturn,
  rememberCatalogReturn,
  takeCatalogScroll,
} from '@/lib/routes/catalog-return';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

function fakeStore(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => { data.set(k, v); },
    removeItem: (k) => { data.delete(k); },
  };
}

describe('адрес списка: куда можно возвращать', () => {
  it('раздел с параметрами — да; карточка, чужой хост, относительный мусор — нет', () => {
    expect(isCatalogListUrl('/routes')).toBe(true);
    expect(isCatalogListUrl('/routes?page=5&difficulty=easy')).toBe(true);
    expect(isCatalogListUrl('/places?page=2')).toBe(true);
    expect(isCatalogListUrl('/routes/abc')).toBe(false);
    expect(isCatalogListUrl('//evil.example/routes')).toBe(false);
    expect(isCatalogListUrl('https://evil.example/routes')).toBe(false);
    expect(isCatalogListUrl('routes?page=5')).toBe(false);
    expect(isCatalogListUrl('/catalog')).toBe(false);
  });
});

describe('прокрутка: запомнить при уходе, вернуть один раз на том же адресе', () => {
  it('тот же адрес — та же прокрутка, запись одноразовая', () => {
    const store = fakeStore();
    rememberCatalogReturn('/routes?page=5', 1234.6, 1_000, store);
    expect(readCatalogReturn(2_000, store)).toEqual({ url: '/routes?page=5', scrollY: 1235, at: 1_000 });
    expect(takeCatalogScroll('/routes?page=5', 2_000, store)).toBe(1235);
    // Второй заход на тот же адрес (из шапки) — сверху, не вниз.
    expect(takeCatalogScroll('/routes?page=5', 3_000, store)).toBeNull();
  });

  it('другой адрес — прокрутки нет, запись остаётся для ссылки «назад»', () => {
    const store = fakeStore();
    rememberCatalogReturn('/routes?page=5&difficulty=easy', 800, 1_000, store);
    expect(takeCatalogScroll('/routes', 2_000, store)).toBeNull();
    expect(catalogReturnHref('/routes', 2_000, store)).toBe('/routes?page=5&difficulty=easy');
  });

  it('ссылка «назад» без записи — на раздел; устаревшая запись — тоже на раздел', () => {
    const store = fakeStore();
    expect(catalogReturnHref('/routes', 1_000, store)).toBe('/routes');
    rememberCatalogReturn('/places?page=3', 10, 1_000, store);
    expect(catalogReturnHref('/places', 1_000 + CATALOG_RETURN_TTL_MS + 1, store)).toBe('/places');
  });

  it('чужой или битый адрес в хранилище не уводит с сайта', () => {
    const store = fakeStore();
    rememberCatalogReturn('https://evil.example/routes', 10, 1_000, store);
    expect(store.data.has(CATALOG_RETURN_KEY)).toBe(false);
    store.setItem(CATALOG_RETURN_KEY, JSON.stringify({ url: '//evil.example', scrollY: 1, at: 1_000 }));
    expect(catalogReturnHref('/routes', 1_000, store)).toBe('/routes');
    store.setItem(CATALOG_RETURN_KEY, 'не json');
    expect(readCatalogReturn(1_000, store)).toBeNull();
  });

  it('без хранилища (приватный режим) — удобства нет, отказа тоже', () => {
    expect(() => rememberCatalogReturn('/routes', 1, 1, null)).not.toThrow();
    expect(takeCatalogScroll('/routes', 1, null)).toBeNull();
    expect(catalogReturnHref('/routes', 1, null)).toBe('/routes');
  });
});

describe('номер страницы, которой больше нет', () => {
  it('седьмая из пяти — пятая; пятая из пяти — пятая; пустая выдача — номер не трогается', () => {
    expect(clampPage(7, 5)).toBe(5);
    expect(clampPage(5, 5)).toBe(5);
    expect(clampPage(1, 5)).toBe(1);
    expect(clampPage(7, 0)).toBe(7);
    expect(clampPage(3, Number.NaN)).toBe(3);
  });
});

describe('связка в коде каталога', () => {
  const client = read('app/routes/_RoutesPageClient.tsx');

  it('адрес списка собирается одним сборщиком и несёт фильтры: сложность, цену, радиус, сортировку', () => {
    const builder = /const listUrl = useCallback\(\(pg: number\) => \{([\s\S]*?)\}, \[/.exec(client);
    expect(builder, 'listUrl — единый сборщик адреса').not.toBeNull();
    const body = builder![1];
    for (const key of ['difficulty', 'price', 'radius', 'sort', 'page']) {
      expect(body, `в адресе списка нет ${key}`).toContain(`p.set('${key}'`);
    }
    // Строка браузера и ссылки пагинации — из того же сборщика.
    expect(client).toContain('router.replace(listUrl(page)');
    expect(client).toContain('const pageHref = listUrl;');
  });

  it('первая страница без параметров: page=1, сложность и цена пустые — адрес голый', () => {
    const builder = /const listUrl = useCallback\(\(pg: number\) => \{([\s\S]*?)\}, \[/.exec(client)![1];
    expect(builder).toContain("if (pg > 1)            p.set('page'");
    expect(builder).toContain("if (sort !== 'recommended') p.set('sort'");
    expect(builder).toContain("return `${basePath}${p.size ? '?' + p : ''}`");
  });

  it('сортировка, цена и радиус читаются из адреса при старте', () => {
    expect(client).toContain("searchParams.get('sort')");
    expect(client).toContain("searchParams.get('price')");
    expect(client).toContain("searchParams.get('radius')");
    expect(client).toContain("searchParams.get('difficulty')");
  });

  it('уход в карточку запоминает адрес и прокрутку; возврат восстанавливает после отрисовки', () => {
    expect(client).toContain('rememberCatalogReturn(listUrl(page), window.scrollY)');
    expect(client).toContain('onClickCapture={rememberBeforeCard}');
    expect(client).toContain('takeCatalogScroll(listUrl(page))');
    expect(client).toContain('requestAnimationFrame');
  });

  it('ответ API с номером за пределом ужимает страницу к последней, а не сбрасывает к первой', () => {
    expect(client).toContain('const last = clampPage(pg, json.meta.pages)');
    expect(client).toContain('setPage(last)');
    expect(client).not.toMatch(/json\.meta\.pages[^\n]*setPage\(1\)/);
  });

  it('сервер обеих страниц ужимает номер и передаёт клиенту отрисованную страницу', () => {
    for (const p of ['app/routes/(list)/page.tsx', 'app/places/page.tsx']) {
      const src = read(p);
      expect(src, p).toContain('clampPage(requestedPage, initial.meta.pages)');
      expect(src, p).toContain('initialPage={page}');
      // Фильтры в адресе — вид раздела, canonical на раздел (catalog-paging).
      expect(src, p).toMatch(/hasFilters = \[[^\]]*'radius'[^\]]*'sort'/);
    }
    expect(client).toContain('if (initialPage != null');
  });

  it('ссылки «назад» на карточках маршрута и места ведут на сохранённый адрес списка', () => {
    const route = read('app/routes/[id]/_RouteDetailClient.tsx');
    const place = read('app/places/[id]/_PlaceDetailClient.tsx');
    expect(route).toContain("useCatalogReturnHref('/routes')");
    expect(place).toContain("useCatalogReturnHref('/places')");
    expect(route).not.toContain('href="/routes"\n');
    expect(route).not.toContain('<Link href="/routes" className="ds-btn');
    expect(place).not.toContain('href="/routes?kind=place"');
    const hook = read('hooks/use-catalog-return.ts');
    expect(hook).toContain('useSyncExternalStore');
    expect(hook).toContain('catalogReturnHref(fallback)');
  });
});
