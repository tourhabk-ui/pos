/**
 * Запросы офлайн-пакета маршрута (`/api/routes/[id]/offline-bundle`), которые
 * проверяются на настоящем PostgreSQL (tests/integration/alert-place-scope).
 *
 * Точки маршрута — с расстоянием до медпомощи из профиля безопасности места
 * (`location_safety_profile.nearest_medical_km`). Это поле шаблон 070 не
 * выдумывал (lib/safety/profile-source.ts), поэтому его можно унести в поле
 * как факт: без сети Кузьмич отвечает по нему (карт-бланш владельца 27.11,
 * шаг 2: «опасности, снаряжение, телефоны МЧС, ближайшая медпомощь»).
 * Подзапрос, а не JOIN: точка маршрута остаётся одной строкой, что бы ни
 * лежало в профиле.
 *
 * Медпомощь — только у точек ПУТИ: у связи рода `nearby` («это рядом,
 * загляните», §4.1, lib/routes/link-kind.ts) расстояние не берётся. Иначе
 * Халактырский пляж, привязанный «рядом» к Авачинскому, назвал бы туристу на
 * склоне вулкана свою медпомощь. Сама точка в пакете остаётся — для карты.
 */
export const OFFLINE_BUNDLE_WAYPOINTS_SQL = `
  SELECT p.lat, p.lng, p.name AS place_name, rw.position,
         CASE WHEN COALESCE(rw.link_kind, 'unknown') = 'nearby' THEN NULL
              ELSE (SELECT sp.nearest_medical_km
                      FROM location_safety_profile sp
                     WHERE sp.agent_route_id = p.ark_id
                       AND sp.nearest_medical_km IS NOT NULL
                     LIMIT 1)
         END AS nearest_medical_km
    FROM route_waypoints rw
    JOIN places p ON p.id = rw.place_id
   WHERE rw.route_id = $1 AND p.lat IS NOT NULL AND p.lng IS NOT NULL
   ORDER BY rw.position`;

/** Точка пакета. Нет расстояния в профиле — null: «не записано», а не ноль километров. */
export interface OfflineBundleWaypoint {
  position: number;
  name: string;
  lat: number;
  lng: number;
  nearest_medical_km: number | null;
}

/** Строки запроса точек — как их отдаёт драйвер (numeric приходит строкой). */
export function offlineBundleWaypoints(rows: ReadonlyArray<Record<string, unknown>>): OfflineBundleWaypoint[] {
  return rows.map((wp) => {
    const km = wp.nearest_medical_km == null || wp.nearest_medical_km === '' ? NaN : Number(wp.nearest_medical_km);
    return {
      position: Number(wp.position),
      name: typeof wp.place_name === 'string' ? wp.place_name : '',
      lat: Number(wp.lat),
      lng: Number(wp.lng),
      nearest_medical_km: Number.isFinite(km) && km >= 0 ? km : null,
    };
  });
}
