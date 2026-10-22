/**
 * Адрес каталога для фоновых точек карты планировщика. Правило выбора плитки
 * и почему спрашиваются именно эти поля — в шапке lib/planner/bg-routes.ts.
 *
 * Отдельно от загрузки, потому что эту форму зовёт и диагностика каталога
 * (`/api/cron/catalog-diag`) — проверяет ровно ту строку запроса, что уходит
 * с экрана. Загрузчик ходит в сеть, диагностика — нет, и перечень
 * возможностей крона (`cron-capability-frozen`) не должен получать «ходит
 * наружу» из-за одного построителя строки.
 */

/** Сколько маршрутов на один интерес — как было. */
export const BG_ROUTES_PER_TYPE = 30;

/**
 * Плитка места → виды мест пути (`places.location_type`). Плитки, которых
 * здесь нет, — занятия: ищутся по `activity_type` маршрута.
 */
export const PLACE_TILE_LOCATION_TYPES: Readonly<Record<string, readonly string[]>> = {
  volcano:    ['volcano'],
  hot_spring: ['hot_spring', 'thermal'],
  geyser:     ['geyser'],
  sea:        ['bay', 'cape', 'beach'],
  mountain:   ['mountain', 'pass'],
  river:      ['river'],
};

/**
 * Адрес каталога для плитки: место — по месту пути, занятие — по виду
 * маршрута. Только маршруты, с координатами, в порядке для поля, описание
 * первой строкой (см. шапку, шестой круг).
 */
export function bgRoutesUrl(tile: string): string {
  const placeTypes = PLACE_TILE_LOCATION_TYPES[tile];
  const sp = new URLSearchParams(placeTypes ? { place_type: placeTypes.join(',') } : { activity_type: tile });
  sp.set('kind', 'route');
  sp.set('hasCoords', 'true');
  sp.set('sort', 'navigable');
  sp.set('brief', '1');
  sp.set('limit', String(BG_ROUTES_PER_TYPE));
  return `/api/routes?${sp.toString()}`;
}
