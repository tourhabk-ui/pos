/**
 * Перепись охвата мест тревогами: до какого места доходит предупреждение без
 * своей координаты (15.10, #83).
 *
 * Такое предупреждение (ветер Росгидромета, «по всему краю» МЧС) ложится на
 * место по району `places.zone` (зональная ветка ALERT_MATCH_SQL) или, у
 * дальних округов, по координате (lib/safety/krai-far.ts). Тревожных зон
 * четыре, а районов у мест больше (PLACE_ZONE_LABELS): место с районом вне
 * четвёрки и вне дальних округов не получает таких тревог вовсе — и стоит
 * «зелёным», хотя проверить его было нечем. Так 15.10 Арка Стеллера с верным
 * районом «commander» осталась без ветра и волнения, которые были у Бакланьих
 * камней в 15 км с ошибочным «avachinsky» (проба 968).
 *
 * Предикат не переписан: пробная тревога предъявляется ТОМУ ЖЕ ALERT_MATCH_SQL,
 * которым красит крон, — строкой типа external_alerts из jsonb_populate_record,
 * без вставки. Зоны пробы берёт вызывающий из настоящих разборов (mchs_zones,
 * METEOALERT_REGIONS), а не из списка здесь: иначе перепись мерила бы своё.
 * Только чтение.
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
 * $1 — jsonb-массив проб {kind, title, zones}. Для каждого видимого места —
 * какие пробы его накрыли и есть ли у него строка реалтайма (без неё карточка
 * не получает тревог вовсе, какой бы ни была зона).
 */
export const ZONE_CENSUS_SQL = `
  WITH probe AS (
    SELECT k.kind,
           (jsonb_populate_record(NULL::external_alerts, jsonb_build_object(
              'alert_type', 'weather', 'title', k.title, 'affected_zones', k.zones))).*
      FROM jsonb_to_recordset($1::jsonb) AS k(kind text, title text, zones jsonb)
  )
  SELECT p.id::text AS id, p.name, p.lat::float8 AS lat, p.lng::float8 AS lng,
         p.zone, p.location_type,
         EXISTS (SELECT 1 FROM location_real_time_status s WHERE s.agent_route_id = p.ark_id) AS has_status,
         COALESCE(array_agg(ea.kind ORDER BY ea.kind) FILTER (WHERE ea.kind IS NOT NULL), '{}') AS reached_by
    FROM places p
    LEFT JOIN agent_route_knowledge ark ON ark.id = p.ark_id
    LEFT JOIN probe ea ON (${ALERT_MATCH_SQL})
   WHERE p.is_visible = TRUE AND p.merged_into_id IS NULL
   GROUP BY p.id, p.name, p.lat, p.lng, p.zone, p.location_type, p.ark_id
   ORDER BY p.zone NULLS FIRST, p.name`;

export interface ZoneCensusRow {
  id: string;
  name: string;
  lat: number | null;
  lng: number | null;
  zone: string | null;
  location_type: string | null;
  has_status: boolean;
  reached_by: string[];
}

interface PlaceRef { id: string; name: string; lat: number | null; lng: number | null; zone: string | null }

const ref = (r: ZoneCensusRow): PlaceRef => ({ id: r.id, name: r.name, lat: r.lat, lng: r.lng, zone: r.zone });

const inCommanderBox = (r: ZoneCensusRow) =>
  r.lat !== null && r.lng !== null
  && r.lat >= COMMANDER_BOX.minLat && r.lat <= COMMANDER_BOX.maxLat
  && r.lng >= COMMANDER_BOX.minLng && r.lng <= COMMANDER_BOX.maxLng;

export interface ZoneCensus {
  places: number;
  /** Строки реалтайма нет — тревог карточка не получит никаких. */
  no_status: PlaceRef[];
  /**
   * По районам: сколько мест, назван ли район зоной хоть одной пробы (иначе
   * зональная ветка его не видит) и сколько мест накрыла каждая проба.
   */
  by_zone: Array<{ zone: string | null; alert_zone: boolean; places: number; reached: Record<string, number> }>;
  /** По пробам: места со строкой реалтайма, до которых проба НЕ дошла. */
  unreached: Record<string, PlaceRef[]>;
  /** Места в прямоугольнике Командор — с их районом. */
  commander_box: PlaceRef[];
  /** Места севернее черты Корякского округа — с их районом. */
  koryak: PlaceRef[];
}

/** Свод переписи. Пробы называет вызывающий — по ним и считается. */
export function summarizeZoneCensus(rows: ZoneCensusRow[], probes: readonly ZoneProbe[]): ZoneCensus {
  const kinds = probes.map((p) => p.kind);
  const byZone = new Map<string | null, { places: number; reached: Record<string, number> }>();
  const unreached: Record<string, PlaceRef[]> = Object.fromEntries(kinds.map((k) => [k, []]));
  for (const r of rows) {
    const z = byZone.get(r.zone) ?? { places: 0, reached: Object.fromEntries(kinds.map((k) => [k, 0])) };
    z.places++;
    for (const k of r.reached_by) if (k in z.reached) z.reached[k]++;
    byZone.set(r.zone, z);
    if (r.has_status) for (const k of kinds) if (!r.reached_by.includes(k)) unreached[k].push(ref(r));
  }
  return {
    places: rows.length,
    no_status: rows.filter((r) => !r.has_status).map(ref),
    by_zone: [...byZone.entries()]
      .map(([zone, v]) => ({ zone, alert_zone: zone !== null && probes.some((p) => p.zones.includes(zone)), ...v }))
      .sort((a, b) => b.places - a.places),
    unreached,
    commander_box: rows.filter(inCommanderBox).map(ref),
    koryak: rows.filter((r) => r.lat !== null && r.lat >= KRAI_KORYAK_MIN_LAT).map(ref),
  };
}
