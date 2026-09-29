/**
 * Место «на маршруте»: через него проходит хотя бы один живой маршрут (29.09).
 *
 * Владелец о первом экране /map: «при открытии популярные места, но с формой
 * места, а по фильтрам открывать и другие — а то слишком много, и человек в
 * первый раз просто потеряется». Из трёх способов отобрать «популярные»
 * выбран этот: место, куда есть маршрут. Два других были отвергнуты по
 * данным, а не по вкусу:
 *
 *  - просмотры карточки (`places.view_count`) растут на каждый запрос, без
 *    отсева ботов и служебных проб — считали бы шум, а не интерес людей;
 *  - «доступность» (`location_safety_profile.road_type` / `road_accessibility`)
 *    у всех мест стоит умолчанием миграции 0645 — 'gravel' и 50, замеров нет.
 *    Отбор по ней был бы отбором по заглушке (§4.0).
 *
 * Правило одно на оба места, где оно нужно, — слой карты (places-export) и
 * выдача мест для счётчиков /map (lib/routes/catalog-query), — иначе число
 * на чипе разошлось бы с тем, что нарисовано.
 *
 *  - маршрут живой: `is_visible` и не слит — тот же предикат, что у переписей
 *    (catalog-census, place-link-suggest);
 *  - связь — точка пути: любой род, кроме `nearby` (lib/routes/link-kind,
 *    isPathPoint). «Рядом, загляните» не значит «маршрут сюда ведёт».
 */

/**
 * SQL-выражение boolean: через место с `places.id = <placeIdExpr>` проходит
 * живой маршрут. Выражение подставляется как есть — только имя колонки из
 * кода, не пользовательский ввод.
 */
export function placeOnLiveRouteSql(placeIdExpr: string): string {
  return `EXISTS (
    SELECT 1 FROM route_waypoints rw_on
      JOIN kamchatka_routes r_on ON r_on.id = rw_on.route_id
     WHERE rw_on.place_id = ${placeIdExpr}
       AND rw_on.link_kind <> 'nearby'
       AND r_on.is_visible = true
       AND r_on.merged_into_id IS NULL
  )`;
}

/** Фильтр /map и слоя карты: «места, куда есть маршрут». */
export const ON_ROUTE_FILTER = 'on_route';
