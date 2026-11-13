/**
 * Где тур — одно правило для выездов крона, «Моей поездки» и проверки дат
 * после отказа (план «после отказа», 2в): координаты — свои, затем главного
 * места, затем маршрута; зона — маршрута, затем места.
 *
 * Модуль без импортов: «Моя поездка» грузит хранилище обстановки лениво, а
 * фрагмент ей нужен сразу. До 12.11 то же выражение стояло в трёх запросах
 * копией (ревью 2в).
 *
 * Алиасы в запросе: `ot` — operator_tours, `p` — places, `kr` — kamchatka_routes.
 */
export const TOUR_SITE_COLUMNS_SQL = `COALESCE(kr.zone, p.zone) AS zone,
         COALESCE(ot.latitude, p.lat, kr.lat)::float8 AS lat,
         COALESCE(ot.longitude, p.lng, kr.lng)::float8 AS lng`;

export const TOUR_SITE_JOINS_SQL = `LEFT JOIN places p ON p.id = ot.main_place_id
    LEFT JOIN kamchatka_routes kr ON kr.id = ot.route_id`;
