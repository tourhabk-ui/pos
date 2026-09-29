/**
 * /map открывается местами, куда есть живой маршрут, — значками, с первого
 * экрана (владелец 29.09: «при открытии популярные места, но с формой места;
 * по фильтрам — остальные, а то человек в первый раз просто потеряется»).
 *
 * Держится связка целиком, а не половина (правило 10.09):
 *  - правило одно — lib/places/on-route;
 *  - его зовут оба потребителя: слой карты (places-export) и выдача мест для
 *    счётчиков (catalog-query) — иначе число на чипе разойдётся с картой;
 *  - слой несёт `on_route`, VedarMap умеет по нему фильтровать и показывает
 *    значки с нижнего зума;
 *  - страница выбирает этот фильтр первым и не рисует пустую карту, когда
 *    признака нет (офлайн-кэш).
 *
 * Сам SQL проверен на настоящем PostgreSQL 29.09 (место на живом маршруте —
 * да; «рядом», на скрытом маршруте, без маршрута — нет; у маршрута — null).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { placeOnLiveRouteSql, ON_ROUTE_FILTER } from '@/lib/places/on-route';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('правило «через место идёт живой маршрут»', () => {
  const sql = placeOnLiveRouteSql('p.id').replace(/\s+/g, ' ');

  it('маршрут живой: виден и не слит', () => {
    expect(sql).toContain('r_on.is_visible = true');
    expect(sql).toContain('r_on.merged_into_id IS NULL');
  });

  it('связь «рядом» маршрутом через место не считается', () => {
    expect(sql).toContain("rw_on.link_kind <> 'nearby'");
  });

  it('место подставляется по places.id', () => {
    expect(sql).toContain('rw_on.place_id = p.id');
  });
});

describe('оба потребителя зовут одно правило', () => {
  it('слой карты несёт on_route и поднял версию ответа', () => {
    const src = read('app/api/cron/places-export/route.ts');
    expect(src).toContain("${placeOnLiveRouteSql('p.id')} AS on_route");
    expect(src).toMatch(/on_route: r\.on_route,/);
    expect(src).toMatch(/const PLACES_EXPORT_V = 2;/);
    const marker = JSON.parse(read('.github/triggers/map-places-build.json')) as { expect_v?: number };
    expect(marker.expect_v).toBe(2);
  });

  it('выдача мест для счётчиков /map — то же правило', () => {
    const src = read('lib/routes/catalog-query.ts');
    expect(src).toContain("placeOnLiveRouteSql('pp.id')");
    expect(src).toMatch(/onRoute: r\.on_route == null \? null : Boolean\(r\.on_route\)/);
  });
});

describe('карта: значки мест с маршрутом — с первого экрана', () => {
  const map = read('components/shared/VedarMap.tsx');
  const fn = map.slice(map.indexOf('function applyPlacesFilter'), map.indexOf('function applyPlacesVisibility'));

  it('фильтр on_route — по признаку слоя, не по роду места', () => {
    expect(fn).toContain("['==', ['get', 'on_route'], true]");
    expect(fn).toContain('filter === ON_ROUTE_FILTER');
  });

  it('в этом режиме значки с нижнего зума, обзорные точки выключены', () => {
    expect(fn).toContain('map.setLayerZoomRange(l.id, onRoute ? OVERVIEW_MIN_ZOOM : PLACE_ICON_MIN_ZOOM, 24)');
    expect(fn).toMatch(/isDots && onRoute \? \['boolean', false\] : expr/);
  });
});

describe('страница /map', () => {
  const page = read('app/map/_MapPageClient.tsx');

  it('открывается фильтром «С маршрутом», чип стоит первым', () => {
    expect(ON_ROUTE_FILTER).toBe('on_route');
    expect(page).toContain('useState<string>(ON_ROUTE_FILTER)');
    const list = page.slice(page.indexOf('const LOCATION_FILTERS = ['));
    const first = list.indexOf('{ id: ON_ROUTE_FILTER');
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(list.indexOf("{ id: 'all'"));
  });

  it('признака нет (офлайн-кэш, пусто после загрузки) — «Все», а не пустая карта', () => {
    expect(page).toMatch(/activeFilter === ON_ROUTE_FILTER && \(isOffline \|\| \(!loading && !onRouteKnown\)\)\s*\?\s*'all'/);
    expect(page).toContain("placesFilter={filterNow !== 'all'");
  });
});
