/**
 * Перепись охвата тревогами: до какого места и маршрута доходит
 * предупреждение без своей координаты (15.10, #83).
 *
 * Такое предупреждение (ветер Росгидромета, «по всему краю» МЧС) ложится на
 * место по району `places.zone`, на маршрут — по `kamchatka_routes.zone`
 * (зональная ветка ALERT_MATCH_SQL; маршрут судится тем же правилом,
 * lib/routes/collect-signals.ts), а у дальних округов — по координате
 * (lib/safety/krai-far.ts). Тревожных зон четыре, а районов больше
 * (PLACE_ZONE_LABELS): район вне четвёрки и вне дальних округов таких тревог
 * не получает вовсе — и стоит «зелёным», хотя проверить его было нечем. Так
 * 15.10 Арка Стеллера с верным районом «commander» осталась без ветра и
 * волнения, которые были у Бакланьих камней в 15 км с ошибочным «avachinsky»
 * (проба 968).
 *
 * Предикат не переписан: пробная тревога предъявляется ТОМУ ЖЕ ALERT_MATCH_SQL,
 * которым красит крон, — строкой типа external_alerts из jsonb_populate_record,
 * без вставки; место и маршрут — строкой с колонками того же представления,
 * которое читает крон, но собранной из places и kamchatka_routes.
 * Зоны пробы — из настоящих разборов приёма (zoneProbes), а не из списка
 * здесь: иначе перепись мерила бы своё. Только чтение.
 */
import { ALERT_MATCH_SQL } from '@/lib/services/safety/alert-place-scope';
import { COMMANDER_BOX, KRAI_KORYAK_MIN_LAT } from '@/lib/safety/krai-far';
import { KRAI_WIDE_ZONES, METEOALERT_REGIONS } from '@/lib/safety/alert-zones';

export interface ZoneProbe {
  /** Имя пробы в ответе: krai_wide, meteo_south… */
  kind: string;
  title: string;
  zones: readonly string[];
}

/**
 * Пробные тревоги: вид, заголовок и зоны — те же списки, по которым зоны
 * ставит приём (lib/safety/alert-zones.ts: «по краю» у mchs_zones, регионы
 * Росгидромета у meteoalert). Совпадение с разбором держит сторож
 * place-zone-census.
 */
export function zoneProbes(): ZoneProbe[] {
  return [
    { kind: 'krai_wide', title: 'Перепись охвата: ветер по всему краю', zones: KRAI_WIDE_ZONES },
    { kind: 'meteo_south', title: 'Перепись охвата: Росгидромет, юг края', zones: METEOALERT_REGIONS['96'].zones },
    { kind: 'meteo_north', title: 'Перепись охвата: Росгидромет, север края', zones: METEOALERT_REGIONS['95'].zones },
  ];
}

/**
 * $1 — jsonb-массив проб {kind, title, zones}. Для каждого видимого места и
 * маршрута — какие пробы его накрыли; у места ещё — есть ли строка реалтайма
 * (без неё карточка не получает тревог вовсе, какой бы ни была зона).
 */
export const ZONE_CENSUS_SQL = `
  WITH probe AS (
    SELECT k.kind,
           (jsonb_populate_record(NULL::external_alerts, jsonb_build_object(
              'alert_type', 'weather', 'title', k.title, 'affected_zones', k.zones))).*
      FROM jsonb_to_recordset($1::jsonb) AS k(kind text, title text, zones jsonb)
  ),
  -- Строка «ark» — с теми же колонками, что у представления, которое читает
  -- крон (id — UUID в пространстве VIEW, title, lat, lng, zone,
  -- location_type), но из самих таблиц: новому коду VIEW не читать (§4.1).
  place_ark AS (
    SELECT 'place'::text AS target, p.id::text AS rid, p.ark_id AS id, p.name::text AS title,
           p.lat::float8 AS lat, p.lng::float8 AS lng, p.zone::text AS zone, p.location_type::text AS location_type
      FROM places p
     WHERE p.is_visible = TRUE AND p.merged_into_id IS NULL
  ),
  -- Маршрут — так же, как его судит collect-signals: зоны — своя и районы
  -- мест на пути (связь не «рядом», §4.1), опоры — своя точка и точки этих
  -- мест; псевдо-место — каждая зона на каждую опору. Нет опор — одна строка
  -- без координаты, нет зон — зона NULL.
  route_base AS (
    SELECT r.id, COALESCE(r.ark_id, r.id) AS view_id, r.title::text AS title,
           r.zone::text AS zone, r.lat::float8 AS lat, r.lng::float8 AS lng
      FROM kamchatka_routes r
     WHERE r.is_visible = TRUE AND r.merged_into_id IS NULL
  ),
  route_pts AS (
    SELECT DISTINCT rw.route_id, p.zone::text AS zone, p.lat::float8 AS lat, p.lng::float8 AS lng
      FROM route_waypoints rw
      JOIN places p ON p.id = rw.place_id
     WHERE COALESCE(to_jsonb(rw)->>'link_kind', 'unknown') <> 'nearby'
  ),
  route_zones AS (
    SELECT b.id,
           ARRAY(SELECT DISTINCT z.zone FROM (
                   SELECT b.zone AS zone
                   UNION ALL
                   SELECT rp.zone FROM route_pts rp WHERE rp.route_id = b.id
                 ) z WHERE z.zone IS NOT NULL ORDER BY z.zone) AS zones
      FROM route_base b
  ),
  route_anchor AS (
    SELECT b.id, b.lat, b.lng FROM route_base b WHERE b.lat IS NOT NULL AND b.lng IS NOT NULL
    UNION ALL
    SELECT rp.route_id, rp.lat, rp.lng FROM route_pts rp
     WHERE rp.lat IS NOT NULL AND rp.lng IS NOT NULL
  ),
  route_ark AS (
    SELECT 'route'::text AS target, b.id::text AS rid, b.view_id AS id, b.title,
           a.lat, a.lng, z.zone, NULL::text AS location_type
      FROM route_base b
      JOIN route_zones rz ON rz.id = b.id
     CROSS JOIN LATERAL unnest(
             CASE WHEN cardinality(rz.zones) > 0 THEN rz.zones ELSE ARRAY[NULL]::text[] END
           ) AS z(zone)
     CROSS JOIN LATERAL (
             SELECT ra.lat, ra.lng FROM route_anchor ra WHERE ra.id = b.id
             UNION ALL
             SELECT NULL::float8, NULL::float8 WHERE NOT EXISTS (SELECT 1 FROM route_anchor ra WHERE ra.id = b.id)
           ) a
  ),
  ark AS (SELECT * FROM place_ark UNION ALL SELECT * FROM route_ark),
  matched AS (
    SELECT DISTINCT ark.target, ark.rid, ea.kind
      FROM ark
      JOIN probe ea ON (${ALERT_MATCH_SQL})
  ),
  targets AS (
    SELECT pa.target, pa.rid, pa.title, pa.lat, pa.lng, pa.zone, pa.zone AS own_zone, pa.location_type,
           EXISTS (SELECT 1 FROM location_real_time_status s WHERE s.agent_route_id = pa.id) AS has_status
      FROM place_ark pa
    UNION ALL
    SELECT 'route'::text, b.id::text, b.title, b.lat, b.lng,
           NULLIF(array_to_string(rz.zones, ','), ''), b.zone, NULL::text, NULL::boolean
      FROM route_base b
      JOIN route_zones rz ON rz.id = b.id
  )
  SELECT t.target, t.rid AS id, t.title AS name, t.lat, t.lng, t.zone, t.own_zone, t.location_type, t.has_status,
         COALESCE((SELECT array_agg(m.kind ORDER BY m.kind) FROM matched m
                    WHERE m.target = t.target AND m.rid = t.rid), '{}') AS reached_by
    FROM targets t
   ORDER BY t.target, t.zone NULLS FIRST, t.title`;

export interface ZoneCensusRow {
  target: 'place' | 'route';
  id: string;
  name: string;
  lat: number | null;
  lng: number | null;
  /**
   * Район места; у маршрута — его зоны через запятую, как их собирает
   * collect-signals (своя и районы мест на пути), или null.
   */
  zone: string | null;
  /**
   * Своя колонка zone записи: у места совпадает с `zone`, у маршрута —
   * kamchatka_routes.zone без районов мест на пути. Её правит миграция, когда
   * перепись районов находит расхождение с округом точки.
   */
  own_zone: string | null;
  location_type: string | null;
  /** Только у места: есть ли строка реалтайма. У маршрута — null. */
  has_status: boolean | null;
  reached_by: string[];
}

interface Ref { id: string; name: string; lat: number | null; lng: number | null; zone: string | null }

const ref = (r: ZoneCensusRow): Ref => ({ id: r.id, name: r.name, lat: r.lat, lng: r.lng, zone: r.zone });

const inCommanderBox = (r: ZoneCensusRow) =>
  r.lat !== null && r.lng !== null
  && r.lat >= COMMANDER_BOX.minLat && r.lat <= COMMANDER_BOX.maxLat
  && r.lng >= COMMANDER_BOX.minLng && r.lng <= COMMANDER_BOX.maxLng;

export interface ZoneCensusPart {
  count: number;
  /**
   * По районам: сколько записей, назван ли район зоной хоть одной пробы (иначе
   * зональная ветка его не видит; у маршрута с несколькими зонами — хоть одна
   * из них) и сколько записей накрыла каждая проба.
   */
  by_zone: Array<{ zone: string | null; alert_zone: boolean; count: number; reached: Record<string, number> }>;
  /** По пробам: записи, до которых проба НЕ дошла (у мест — только со строкой реалтайма). */
  unreached: Record<string, Ref[]>;
  /** В прямоугольнике Командор — с районом. */
  commander_box: Ref[];
  /** Севернее черты Корякского округа — с районом. */
  koryak: Ref[];
}

export interface ZoneCensus {
  places: ZoneCensusPart & {
    /** Строки реалтайма нет — тревог карточка не получит никаких. */
    no_status: Ref[];
  };
  routes: ZoneCensusPart;
}

function part(rows: ZoneCensusRow[], probes: readonly ZoneProbe[]): ZoneCensusPart {
  const kinds = probes.map((p) => p.kind);
  const byZone = new Map<string | null, { count: number; reached: Record<string, number> }>();
  const unreached: Record<string, Ref[]> = Object.fromEntries(kinds.map((k) => [k, []]));
  for (const r of rows) {
    const z = byZone.get(r.zone) ?? { count: 0, reached: Object.fromEntries(kinds.map((k) => [k, 0])) };
    z.count++;
    for (const k of r.reached_by) if (k in z.reached) z.reached[k]++;
    byZone.set(r.zone, z);
    if (r.has_status !== false) for (const k of kinds) if (!r.reached_by.includes(k)) unreached[k].push(ref(r));
  }
  // У маршрута зона — список через запятую (своя и районы мест на пути):
  // зональная ветка находит его, если тревожна хоть одна из них.
  const isAlertZone = (zone: string | null) =>
    zone !== null && zone.split(',').some((z) => probes.some((p) => p.zones.includes(z)));
  return {
    count: rows.length,
    by_zone: [...byZone.entries()]
      .map(([zone, v]) => ({ zone, alert_zone: isAlertZone(zone), ...v }))
      .sort((a, b) => b.count - a.count),
    unreached,
    commander_box: rows.filter(inCommanderBox).map(ref),
    koryak: rows.filter((r) => r.lat !== null && r.lat >= KRAI_KORYAK_MIN_LAT).map(ref),
  };
}

/** Свод переписи. Пробы называет вызывающий — по ним и считается. */
export function summarizeZoneCensus(rows: ZoneCensusRow[], probes: readonly ZoneProbe[]): ZoneCensus {
  const places = rows.filter((r) => r.target === 'place');
  return {
    places: { ...part(places, probes), no_status: places.filter((r) => r.has_status === false).map(ref) },
    routes: part(rows.filter((r) => r.target === 'route'), probes),
  };
}
