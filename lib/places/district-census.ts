/**
 * Перепись районов: район места против муниципального округа его точки
 * (16.10, #83).
 *
 * `places.zone` — адрес тревоги без своей координаты (зональная ветка
 * ALERT_MATCH_SQL). Тревога МЧС об округе получает зону по карте округов
 * разбора (mchs_zones: «Елизовский» → avachinsky, «Быстринский» → western…).
 * Место дойдёт до тревоги о своём округе, только если его район назван той
 * же зоной. Перепись 15.10 нашла кластер Эссо с районом «avachinsky» при
 * округе Быстринском и места Курильского озера с «avachinsky» при
 * Усть-Большерецком — тревоги о своих округах до них не доходили, а
 * петропавловские доходили.
 *
 * Здесь — только правило сличения: точки и контуры приходят снаружи
 * (scripts/place-districts.ts, выгрузка Geofabrik на раннере). Исход — факт
 * для человека, а не правка: район ставится миграцией, сверенной глазами,
 * потому что у некоторых районов своя причина (Кроноцкий заповедник —
 * eastern по текстам о нём, см. 1293).
 */
import { containingAreas, geometryBbox, type Area } from '@/lib/geo/point-in-area';
import { ALERT_ZONES } from '@/lib/safety/alert-zones';
import { KRAI_FAR_ZONES } from '@/lib/safety/krai-far';

export interface DistrictInfo {
  /** Имя округа из OSM («Елизовский район»). */
  name: string;
  /** Отношение OSM («relation 1234»). */
  osm: string;
}

export interface DistrictPlace {
  id: string;
  name: string;
  lat: number | null;
  lng: number | null;
  zone: string | null;
}

/** Исход сличения одного места. */
export type DistrictVerdict =
  /** Район совпал с зоной тревог своего округа. */
  | 'match'
  /** Район — не та зона, которую получает тревога о его округе. */
  | 'mismatch'
  /** Дальний округ: тревоги приходят по координате, район их не решает. */
  | 'far'
  /** Округ найден, но карта округов МЧС его не знает — тревога о нём зоны не получит. */
  | 'district_unmapped'
  /** Точка вне всех округов: вода или край выгрузки. */
  | 'no_district'
  /** Координаты нет — сличать нечем. */
  | 'no_point';

export interface DistrictRow extends DistrictPlace {
  verdict: DistrictVerdict;
  district: string | null;
  district_osm: string | null;
  /** Зона, которую получает тревога МЧС о его округе. */
  expected: string[];
}

export interface DistrictCensus {
  places: number;
  districts: number;
  counts: Record<DistrictVerdict, number>;
  /** Расхождения блоками «прежний район → зона округа (округ)». */
  mismatch_blocks: Array<{ from: string | null; to: string; district: string; count: number; places: DistrictRow[] }>;
  far: DistrictRow[];
  district_unmapped: DistrictRow[];
  no_district: DistrictRow[];
  no_point: DistrictRow[];
}

/**
 * Сличение. `zonesOfDistrict` — то правило, которым зону получает тревога
 * (вызывающий передаёт mchs_zones): своей карты округов здесь нет, иначе
 * перепись мерила бы своё.
 */
export function districtCensus(
  places: readonly DistrictPlace[],
  districts: readonly Area<DistrictInfo>[],
  zonesOfDistrict: (name: string) => string[],
): DistrictCensus {
  // Рамки — один раз: точек сотни, вершин у береговых округов сотни тысяч.
  const boxed = districts.map((d) => ({ d, box: geometryBbox(d.geometry) }));
  const rows: DistrictRow[] = places.map((p) => {
    const base = { ...p, district: null, district_osm: null, expected: [] as string[] };
    if (p.lat === null || p.lng === null) return { ...base, verdict: 'no_point' as const };
    const { lat, lng } = p;
    const near = boxed
      .filter(({ box: [w, s, e, n] }) => lng >= w && lng <= e && lat >= s && lat <= n)
      .map(({ d }) => d);
    // Самый мелкий содержащий контур — округ, а не что-то крупнее с тем же уровнем.
    const [d] = containingAreas(lng, lat, near);
    if (!d) return { ...base, verdict: 'no_district' as const };
    const expected = zonesOfDistrict(d.name);
    const found = { ...base, district: d.name, district_osm: d.osm, expected };
    if (expected.length === 0) return { ...found, verdict: 'district_unmapped' as const };
    if (expected.some((z) => KRAI_FAR_ZONES.includes(z))) return { ...found, verdict: 'far' as const };
    const own = p.zone?.trim() ?? null;
    return { ...found, verdict: own !== null && expected.includes(own) ? 'match' as const : 'mismatch' as const };
  });

  const counts = { match: 0, mismatch: 0, far: 0, district_unmapped: 0, no_district: 0, no_point: 0 } as Record<DistrictVerdict, number>;
  for (const r of rows) counts[r.verdict]++;

  const blocks = new Map<string, { from: string | null; to: string; district: string; places: DistrictRow[] }>();
  for (const r of rows.filter((x) => x.verdict === 'mismatch')) {
    // Зона тревоги округа — одна из четырёх; первая по списку, если их несколько.
    const to = r.expected.find((z) => ALERT_ZONES.includes(z)) ?? r.expected[0];
    const key = `${r.zone ?? ''}|${to}|${r.district}`;
    const b = blocks.get(key) ?? { from: r.zone, to, district: r.district!, places: [] };
    b.places.push(r);
    blocks.set(key, b);
  }

  return {
    places: rows.length,
    districts: districts.length,
    counts,
    mismatch_blocks: [...blocks.values()]
      .map((b) => ({ ...b, count: b.places.length }))
      .sort((a, b) => b.count - a.count),
    far: rows.filter((r) => r.verdict === 'far'),
    district_unmapped: rows.filter((r) => r.verdict === 'district_unmapped'),
    no_district: rows.filter((r) => r.verdict === 'no_district'),
    no_point: rows.filter((r) => r.verdict === 'no_point'),
  };
}
