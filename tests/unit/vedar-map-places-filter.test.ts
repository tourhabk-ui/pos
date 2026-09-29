/**
 * Фильтр мест на своей карте (владелец 06.09, /map: «нет точек мест» —
 * фильтр-чипсы над картой выбирали категорию, а VedarMap рисовала
 * vedar-places целиком, никак не реагируя). Сторож держит:
 *   - applyPlacesFilter находит слои по подстроке 'vedar-place' — так
 *     захватываются и круг (vedar-places<ns>), и подпись
 *     (vedar-place-labels<ns>), у обоих родов разный хвост id;
 *   - фильтр применяется сразу при смене пропа И когда сосед подкладывает
 *     свой слой мест (иначе выбор фильтра «слетал» бы при переезде камеры);
 *   - /map передаёt в VedarMap ровно то, что выбрано в activeFilter,
 *     кроме activity:* (у слоя нет такого поля).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');
const MAP = read('components/shared/VedarMap.tsx');
const CLIENT = read('app/map/_MapPageClient.tsx');

describe('applyPlacesFilter — VedarMap', () => {
  it('ищет слои по подстроке vedar-place, не по префиксу vedar-places', () => {
    expect(MAP).toMatch(/l\.id\.includes\('vedar-place'\)/);
  });

  it('строит ==-выражение по kind, снимает фильтр при null', () => {
    // С 29.09 впереди ветка «с маршрутом» (признак on_route, не род места —
    // сторож map-on-route-first); выражение по kind и снятие при null прежние.
    expect(MAP).toMatch(/: filter \? \['==', \['get', 'kind'\], filter\] : null/);
    expect(MAP).toMatch(/map\.setFilter\(l\.id, \(isDots && onRoute \? \['boolean', false\] : expr\) as never\)/);
  });

  it('применяется отдельным эффектом на смену placesFilter', () => {
    expect(MAP).toMatch(/useEffect\(\(\) => \{\s*const map = mapRef\.current;\s*if \(!map \|\| !ready\) return;\s*applyPlacesFilter\(map, placesFilter\);\s*\}, \[ready, placesFilter\]\)/);
  });

  it('применяется и когда сосед подкладывает свой слой мест', () => {
    const at = MAP.indexOf('map.addLayer(layer as never');
    const block = MAP.slice(at, MAP.indexOf('} catch (err) {', at));
    expect(block).toContain('applyPlacesFilter(map, placesFilterRef.current)');
  });
});

describe('/map — фильтр-чипсы доходят до карты', () => {
  it('placesFilter строится из выбранного фильтра, activity:* не передаётся слою', () => {
    // filterNow — выбранный фильтр с честным откатом «с маршрутом» → «все»,
    // когда признака нет (29.09, сторож map-on-route-first).
    expect(CLIENT).toMatch(
      /placesFilter=\{filterNow !== 'all' && !filterNow\.startsWith\('activity:'\) \? filterNow : null\}/,
    );
  });
});
