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
 * без вставки; место и маршрут — строкой agent_route_knowledge, как в кроне.
 * Зоны пробы — из настоящих разборов приёма (zoneProbes), а не из списка
 * здесь: иначе перепись мерила бы своё. Только чтение.
 */
import { ALERT_MATCH_SQL } from '@/lib/services/safety/alert-place-scope';
import { COMMANDER_BOX, KRAI_KORYAK_MIN_LAT } from '@/lib/safety/krai-far';
import { mchs_zones } from '@/lib/services/safety/seismic-parser';
import { METEOALERT_REGIONS } from '@/lib/services/safety/meteoalert';

export interface ZoneProbe {
  /** Имя пробы в ответе: krai_wide, meteo_south… */
  kind: string;
  title: string;
  zones: readonly string[];
}

/** Пробные тревоги: вид, заголовок и зоны — из настоящих разборов приёма. */
export function zoneProbes(): ZoneProbe[] {
  return [
    { kind: 'krai_wide', title: 'Перепись охвата: ветер по всему краю', zones: mchs_zones('Штормовое предупреждение по всему краю') },
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
  targets AS (
    SELECT 'place'::text AS target, p.id::text AS id, p.name::text AS name, p.ark_id AS ark_id
      FROM places p
     WHERE p.is_visible = TRUE AND p.merged_into_id IS NULL
    UNION ALL
    SELECT 'route'::text, r.id::text, r.title::text, COALESCE(r.ark_id, r.id)
      FROM kamchatka_routes r
     WHERE r.is_visible = TRUE AND r.merged_into_id IS NULL
  )
  SELECT t.target, t.id, t.name, ark.lat::float8 AS lat, ark.lng::float8 AS lng,
         ark.zone, ark.location_type,
         CASE WHEN t.target = 'place'
              THEN EXISTS (SELECT 1 FROM location_real_time_status s WHERE s.agent_route_id = t.ark_id)
         END AS has_status,
         COALESCE(array_agg(ea.kind ORDER BY ea.kind) FILTER (WHERE ea.kind IS NOT NULL), '{}') AS reached_by
    FROM targets t
    LEFT JOIN agent_route_knowledge ark ON ark.id = t.ark_id AND ark.kind = t.target
    LEFT JOIN probe ea ON (${ALERT_MATCH_SQL})
   GROUP BY t.target, t.id, t.name, t.ark_id, ark.lat, ark.lng, ark.zone, ark.location_type
   ORDER BY t.target, ark.zone NULLS FIRST, t.name`;

export interface ZoneCensusRow {
  target: 'place' | 'route';
  id: string;
  name: string;
  lat: number | null;
  lng: number | null;
  zone: string | null;
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
   * зональная ветка его не видит) и сколько записей накрыла каждая проба.
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
  return {
    count: rows.length,
    by_zone: [...byZone.entries()]
      .map(([zone, v]) => ({ zone, alert_zone: zone !== null && probes.some((p) => p.zones.includes(zone)), ...v }))
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
