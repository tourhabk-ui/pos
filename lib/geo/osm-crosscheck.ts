/**
 * Чистая логика массовой сверки places с OpenStreetMap (без сети/БД).
 *
 * Повод (10.09): четыре плохие координаты в `places` нашлись только по
 * жалобам туриста с телефона (Голубые озёра — 17 км от места; Овальное и
 * Смотровая у Авачинского — ~19-25 км; Лежбище сивучей — 506 км до
 * одноимённого мыса в OSM). ~380 живых мест никогда не проверялись массово
 * против внешнего источника.
 *
 * Правило то же, что у `lib/routes/place-link.ts` (23.08, «улика — не
 * приговор»): никакого автосуждения. Ни один порог расстояния не отсекает
 * кандидата — жёсткое правило «имя+расстояние» без разбора глазами уже
 * портило записи (см. шапку place-link.ts, 21 из 24 «улик» оказались
 * тёзками). Здесь то же самое: сортировка по убыванию расстояния, а не
 * фильтр — 506 км «Лежбища сивучей» обязаны остаться в списке рядом с
 * настоящей ошибкой, а не потеряться из-за порога, который где-то отсечёт
 * и честную запись.
 *
 * Похожесть имени считается снаружи (pg_trgm.similarity() одним SQL-запросом
 * в раннере) и передаётся сюда готовыми числами — не пересчитывается в JS.
 * Триграммы, а не `nameMatchScore` из place-link.ts: последний использует
 * грубый 7-буквенный стем и падежные окончания («голубые»/«голубых») режет
 * в ноль, а здесь это ровно тот случай, который нужно ловить.
 */

import { distanceKm } from '@/lib/routes/place-link';
import { isExtendedObject } from '@/lib/places/coord-source';

export interface GeoBounds {
  latMin: number;
  latMax: number;
  lngMin: number;
  lngMax: number;
}

/** Overpass QL: именованные природные/туристические/исторические объекты в bbox. */
export function buildOsmCrosscheckQuery(bounds: GeoBounds): string {
  const { latMin, lngMin, latMax, lngMax } = bounds;
  const bbox = `${latMin},${lngMin},${latMax},${lngMax}`;
  return (
    `[out:json][timeout:90];\n` +
    `(\n` +
    `  nwr[~"^(natural|waterway|place|tourism|historic|leisure)$"~"."]["name"](${bbox});\n` +
    `  nwr["boundary"="protected_area"]["name"](${bbox});\n` +
    `  nwr["man_made"="lighthouse"]["name"](${bbox});\n` +
    `);\n` +
    `out center;`
  );
}

export interface OsmFeature {
  id: number;
  kind: 'node' | 'way' | 'relation';
  name: string;
  lat: number;
  lng: number;
  /** Тег, по которому фича попала в выборку, для читаемости отчёта. */
  matchedTag: string;
}

interface OverpassElement {
  type?: string;
  id?: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

const NAME_TAG_KEYS = [
  'natural', 'waterway', 'place', 'tourism', 'historic', 'leisure',
  'boundary', 'man_made',
];

function pickMatchedTag(tags: Record<string, string>): string {
  for (const key of NAME_TAG_KEYS) {
    if (tags[key]) return `${key}=${tags[key]}`;
  }
  return 'unknown';
}

/**
 * Overpass JSON → плоский список именованных точек. Node даёт `lat/lon`
 * напрямую, way/relation — только `center` (запрошено `out center;`, не
 * `out geom;`, чтобы не тащить полную геометрию ради одной точки).
 * Без имени или без координат — не кандидат: сравнивать не с чем.
 */
export function parseOsmFeatures(data: unknown): OsmFeature[] {
  const elements = (data as { elements?: OverpassElement[] } | null)?.elements ?? [];
  const seen = new Set<string>();
  const out: OsmFeature[] = [];

  for (const el of elements) {
    const name = el.tags?.name?.trim();
    if (!el.id || !el.type || !name) continue;

    const lat = el.type === 'node' ? el.lat : el.center?.lat;
    const lng = el.type === 'node' ? el.lon : el.center?.lon;
    if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    const kind = el.type as OsmFeature['kind'];
    const key = `${kind}:${el.id}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({ id: el.id, kind, name, lat, lng, matchedTag: pickMatchedTag(el.tags ?? {}) });
  }
  return out;
}

export interface PlaceInput {
  id: string;
  name: string;
  locationType: string | null;
  lat: number | null;
  lng: number | null;
}

/** Похожесть имени места и фичи OSM, посчитанная снаружи (pg_trgm). */
export interface SimilarityRow {
  placeId: string;
  osmId: number;
  osmKind: OsmFeature['kind'];
  sim: number;
}

export interface CrosscheckCandidate {
  osmId: number;
  osmKind: OsmFeature['kind'];
  osmName: string;
  osmLat: number;
  osmLng: number;
  nameSim: number;
  distanceKm: number | null;
  matchedTag: string;
}

/**
 * Порог, с которого совпадение имени считается СИЛЬНЫМ.
 *
 * Первый боевой прогон (10.09, run 3) показал цену его отсутствия: при
 * пороге выборки 0.3 верх списка заняли «Водопад Ольга» → пик «Водопадная»
 * за 1357 км (sim 0.39) и «Голая» → река «Горелая» за 1281 км (sim 0.40) —
 * однокоренной шум, а не находки. Настоящие ошибки того же дня имели
 * sim 0.71 (Лежбище сивучей → мыс Сивучий) и 1.0 (Голубые озёра).
 *
 * Порог НЕ отсекает слабые совпадения из ответа — они остаются отдельной
 * группой в хвосте. Он решает только, по какому кандидату считать
 * расстояние-улику.
 */
export const STRONG_SIM = 0.5;

export interface CrosscheckItem {
  placeId: string;
  name: string;
  locationType: string | null;
  isExtendedObject: boolean;
  ourLat: number;
  ourLng: number;
  /** Лучшая похожесть имени среди кандидатов. */
  bestSim: number;
  /**
   * Расстояние до БЛИЖАЙШЕГО кандидата с сильным именем (sim ≥ STRONG_SIM),
   * км. Это и есть улика: «ближайший объект OSM, который правдоподобно и есть
   * это место, стоит вот настолько далеко». null — сильных совпадений нет.
   */
  nearestStrongKm: number | null;
  /** Наибольшее расстояние среди показанных кандидатов — для полноты картины. */
  worstDistanceKm: number | null;
  candidates: CrosscheckCandidate[];
}

export interface CrosscheckResult {
  items: CrosscheckItem[];
  /** Мест с хотя бы одним сильным совпадением имени. */
  itemsStrongTotal: number;
  /** Мест, у которых совпадения только слабые (sim < STRONG_SIM). */
  itemsWeakOnlyTotal: number;
  itemsWithoutCandidatesTotal: number;
}

/**
 * Сборка результата по всем местам сразу.
 *
 * НИКАКОЙ фильтрации по расстоянию — только сортировка. Единого порога,
 * отделяющего ошибку данных от однофамильца, не существует (сегодняшние
 * находки лежат на 17, ~20-25 и 506 км одновременно с честными совпадениями
 * на единицы метров) — решение остаётся за человеком, читающим список.
 *
 * Порядок: сначала места с сильным совпадением имени, по убыванию
 * `nearestStrongKm` (чем дальше ближайший одноимённый объект, тем громче
 * улика); затем места только со слабыми совпадениями, по убыванию bestSim.
 * Внутри места кандидаты идут по убыванию похожести, при равной — ближайший
 * первым: так первая строка отвечает «что это, скорее всего, и где оно».
 */
export function buildCrosscheckItems(
  places: PlaceInput[],
  features: OsmFeature[],
  simRows: SimilarityRow[],
  opts: { limit?: number } = {},
): CrosscheckResult {
  const limit = opts.limit ?? 4;
  const featureById = new Map<string, OsmFeature>(
    features.map(f => [`${f.kind}:${f.id}`, f]),
  );

  const simByPlace = new Map<string, SimilarityRow[]>();
  for (const row of simRows) {
    const bucket = simByPlace.get(row.placeId);
    if (bucket) bucket.push(row); else simByPlace.set(row.placeId, [row]);
  }

  const items: CrosscheckItem[] = [];
  let withoutCandidates = 0;
  let strongTotal = 0;
  let weakOnlyTotal = 0;

  for (const place of places) {
    const rows = simByPlace.get(place.id) ?? [];
    const candidates: CrosscheckCandidate[] = [];

    for (const row of rows) {
      const feature = featureById.get(`${row.osmKind}:${row.osmId}`);
      if (!feature) continue;
      const d = (place.lat != null && place.lng != null)
        ? Math.round(distanceKm(place.lat, place.lng, feature.lat, feature.lng) * 10) / 10
        : null;
      candidates.push({
        osmId: feature.id, osmKind: feature.kind, osmName: feature.name,
        osmLat: feature.lat, osmLng: feature.lng,
        nameSim: Math.round(row.sim * 100) / 100,
        distanceKm: d, matchedTag: feature.matchedTag,
      });
    }

    if (candidates.length === 0) {
      withoutCandidates += 1;
      continue;
    }

    candidates.sort((a, b) => (b.nameSim - a.nameSim)
      || ((a.distanceKm ?? Number.POSITIVE_INFINITY) - (b.distanceKm ?? Number.POSITIVE_INFINITY)));

    const nearestStrong = candidates.reduce<number | null>((acc, c) => {
      if (c.nameSim < STRONG_SIM || c.distanceKm == null) return acc;
      return acc == null ? c.distanceKm : Math.min(acc, c.distanceKm);
    }, null);
    if (nearestStrong == null) weakOnlyTotal += 1; else strongTotal += 1;

    const top = candidates.slice(0, limit);
    const worst = top.reduce<number | null>((acc, c) => (
      c.distanceKm == null ? acc : (acc == null ? c.distanceKm : Math.max(acc, c.distanceKm))
    ), null);

    items.push({
      placeId: place.id, name: place.name, locationType: place.locationType,
      isExtendedObject: isExtendedObject(place.locationType),
      ourLat: place.lat ?? NaN, ourLng: place.lng ?? NaN,
      bestSim: candidates[0].nameSim,
      nearestStrongKm: nearestStrong,
      worstDistanceKm: worst,
      candidates: top,
    });
  }

  items.sort((a, b) => {
    const as = a.nearestStrongKm, bs = b.nearestStrongKm;
    if (as != null && bs != null) return bs - as;
    if (as != null) return -1;
    if (bs != null) return 1;
    return b.bestSim - a.bestSim;
  });

  return {
    items,
    itemsStrongTotal: strongTotal,
    itemsWeakOnlyTotal: weakOnlyTotal,
    itemsWithoutCandidatesTotal: withoutCandidates,
  };
}
