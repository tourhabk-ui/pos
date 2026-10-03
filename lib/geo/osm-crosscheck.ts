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
export function buildOsmCrosscheckQuery(bounds: GeoBounds, timeoutSec = 90): string {
  const { latMin, lngMin, latMax, lngMax } = bounds;
  const bbox = `${latMin},${lngMin},${latMax},${lngMax}`;
  return (
    `[out:json][timeout:${timeoutSec}];\n` +
    `(\n` +
    `  nwr[~"^(natural|waterway|place|tourism|historic|leisure)$"~"."]["name"](${bbox});\n` +
    `  nwr["boundary"="protected_area"]["name"](${bbox});\n` +
    `  nwr["man_made"="lighthouse"]["name"](${bbox});\n` +
    `);\n` +
    `out center;`
  );
}

/**
 * Край — квадратами, а не одним запросом (03.10).
 *
 * Один запрос на весь край (50–64° × 155–167°) с шаблоном по ключу тега
 * публичные серверы Overpass перестали тянуть: 20.09 — отказ, 24.09 —
 * таймаут, 03.10 — HTTP 504. Сверки не было три недели, и «Гору Замок» за
 * это время нашёл турист. Квадрат 3.5° × 4° — лёгкий запрос; над морем он
 * пуст и отвечает сразу.
 */
export function splitBounds(bounds: GeoBounds, latStep = 3.5, lngStep = 4): GeoBounds[] {
  const tiles: GeoBounds[] = [];
  for (let lat = bounds.latMin; lat < bounds.latMax; lat += latStep) {
    for (let lng = bounds.lngMin; lng < bounds.lngMax; lng += lngStep) {
      tiles.push({
        latMin: lat, latMax: Math.min(lat + latStep, bounds.latMax),
        lngMin: lng, lngMax: Math.min(lng + lngStep, bounds.lngMax),
      });
    }
  }
  return tiles;
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

export interface OverpassElement {
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
 * Тот же отбор, что у запроса Overpass (buildOsmCrosscheckQuery), но по
 * тегам одного объекта — для выгрузки Geofabrik (03.10). Одно правило в двух
 * формах: меняется одно — меняется и другое (сторож osm-crosscheck.test).
 */
export function matchesCrosscheckTags(tags: Record<string, string> | null | undefined): boolean {
  if (!tags || !tags.name) return false;
  if (['natural', 'waterway', 'place', 'tourism', 'historic', 'leisure'].some((k) => Boolean(tags[k]))) return true;
  return tags.boundary === 'protected_area' || tags.man_made === 'lighthouse';
}

interface GeoJsonFeatureLike {
  id?: string | number;
  properties?: Record<string, unknown> | null;
  geometry?: { type?: string; coordinates?: unknown } | null;
}

/**
 * Объект `osmium export -u type_id` («n123», «w45», «r6») → элемент в форме
 * ответа Overpass с `out center;`: точка у узла, середина охватывающего
 * прямоугольника у линии и области — ровно так `center` считает Overpass.
 * Дальше его разбирает тот же parseOsmFeatures: правило одно.
 */
export function geojsonFeatureToElement(f: GeoJsonFeatureLike): OverpassElement | null {
  const m = /^([nwr])(\d+)$/.exec(String(f.id ?? ''));
  if (!m) return null;
  const type = m[1] === 'n' ? 'node' : m[1] === 'w' ? 'way' : 'relation';
  const tags: Record<string, string> = {};
  for (const [k, v] of Object.entries(f.properties ?? {})) if (typeof v === 'string') tags[k] = v;
  let latMin = Infinity, latMax = -Infinity, lngMin = Infinity, lngMax = -Infinity;
  const walk = (c: unknown): void => {
    if (!Array.isArray(c)) return;
    if (c.length >= 2 && typeof c[0] === 'number' && typeof c[1] === 'number') {
      const [lng, lat] = c as number[];
      if (lat < latMin) latMin = lat; if (lat > latMax) latMax = lat;
      if (lng < lngMin) lngMin = lng; if (lng > lngMax) lngMax = lng;
      return;
    }
    for (const x of c) walk(x);
  };
  walk(f.geometry?.coordinates);
  if (!Number.isFinite(latMin) || !Number.isFinite(lngMin)) return null;
  const lat = (latMin + latMax) / 2;
  const lon = (lngMin + lngMax) / 2;
  return type === 'node'
    ? { type, id: Number(m[2]), lat, lon, tags }
    : { type, id: Number(m[2]), center: { lat, lon }, tags };
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

/**
 * Теги OSM, у которых объект — ТОЧКА по смыслу: вершина, кратер-вершина
 * вулкана, водопад, источник, маяк, памятник (03.10).
 *
 * Повод — «Гора Замок». Сверка 10.09 нашла её: «6.2 км → Замок
 * (natural=peak)», — но пометила «[протяжённый]», и при разборе её отложили
 * как гору, у которой центр законно далеко. Пометка бралась из НАШЕГО рода
 * места (isExtendedObject, lib/places/coord-source), а тот написан под другой
 * вопрос: можно ли по расстоянию судить, проходит ли маршрут через место, —
 * и там гора действительно широка. Здесь вопрос иной: где точка объекта. Если
 * одноимённый объект OSM — вершина, то и наша запись про гору значит её
 * вершину, и шесть километров между двумя вершинами — ошибка, а не ширина
 * горы. Через полгода турист с телефона показал то же самое из Maps.me.
 *
 * Точечность судится по тегу САМОГО объекта OSM, а не по нашему роду.
 * tourism=* сюда не входит намеренно: «Озеро Костакан» в OSM — смотровая
 * площадка, а не озеро, и её точка о самом озере не говорит.
 */
const OSM_POINT_TAGS = new Set([
  'natural=peak', 'natural=volcano', 'natural=hot_spring', 'natural=spring',
  'natural=geyser', 'natural=cave_entrance', 'natural=saddle', 'natural=stone',
  'waterway=waterfall', 'man_made=lighthouse',
]);

export function isOsmPointTag(matchedTag: string): boolean {
  return OSM_POINT_TAGS.has(matchedTag) || matchedTag.startsWith('historic=');
}

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
  /**
   * Расстояние до ближайшего сильного тёзки, который в OSM — ТОЧКА
   * (isOsmPointTag). Улика, которую пометка «протяжённый» не гасит: две
   * вершины с одним именем в шести километрах друг от друга — это ошибка
   * координаты. null — сильных точечных тёзок нет.
   */
  nearestStrongPointKm: number | null;
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
    const nearestStrongPoint = candidates.reduce<number | null>((acc, c) => {
      if (c.nameSim < STRONG_SIM || c.distanceKm == null || !isOsmPointTag(c.matchedTag)) return acc;
      return acc == null ? c.distanceKm : Math.min(acc, c.distanceKm);
    }, null);

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
      nearestStrongPointKm: nearestStrongPoint,
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
