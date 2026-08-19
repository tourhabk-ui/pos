/**
 * Чистая логика подбора GPS-трека маршрута из OSM Overpass (без сети/БД).
 * Используется и API-роутом `app/api/admin/import/osm-geometry/route.ts`,
 * и скриптом `scripts/import-osm-geometry.ts` — раньше эти четыре функции
 * дублировались в обоих. Сетевой вызов Overpass и запись в БД остаются
 * на стороне потребителей; здесь — только детерминированная геометрия,
 * покрытая юнит-тестами на синтетике.
 */

export const RADIUS_DEG_LAT = 0.07;
export const RADIUS_DEG_LNG = 0.10;
/** Трек считается «подходящим», если его конец в пределах этого радиуса от точки маршрута. */
export const MAX_START_DIST_KM = 4;

export interface OsmNode { lat: number; lon: number; }
export interface OsmWay { id: number; tags: Record<string, string>; geometry: OsmNode[]; }

export interface GeoJSONLineString { type: 'LineString'; coordinates: number[][]; }

/** Гаверсинус, км. */
export function distKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Overpass QL: пешие/тропные ways в bbox вокруг точки маршрута. */
export function buildOverpassQuery(lat: number, lng: number): string {
  const s = lat - RADIUS_DEG_LAT;
  const n = lat + RADIUS_DEG_LAT;
  const w = lng - RADIUS_DEG_LNG;
  const e = lng + RADIUS_DEG_LNG;
  return `[out:json][timeout:25];way["highway"~"path|track|footway"](${s},${w},${n},${e});out geom;`;
}

/** Оставляет только ways с валидной геометрией (≥3 узлов). */
export function parseOverpassWays(data: unknown): OsmWay[] {
  const elements = (data as { elements?: OsmWay[] } | null)?.elements ?? [];
  return elements.filter((e) => e.geometry && e.geometry.length >= 3);
}

/**
 * Насколько второй кандидат должен быть хуже первого, чтобы выбор считался
 * однозначным.
 *
 * Порог и его смысл взяты у KML-инбокса (AMBIGUOUS_MARGIN_KM): два трека,
 * одинаково хорошо ложащиеся на точки маршрута, — это не выбор, а гадание.
 */
export const AMBIGUOUS_MARGIN_KM = 0.5;

/**
 * Дальше этого путевая точка маршрута с найденной тропой не сходится.
 *
 * Тот же порог, что у полевого экрана и у черты (DATA_CONFLICT_KM): выше него
 * точка и линия описывают разные места. Свой порог здесь означал бы два
 * разных ответа на один вопрос о данных.
 */
export const WAYPOINT_FIT_KM = 2;

export interface WayCandidatePoint { lat: number; lng: number }

export type WayChoiceReason =
  | 'ok'
  | 'no_candidates'
  | 'no_waypoints'
  | 'waypoints_conflict'
  | 'ambiguous';

export interface WayChoice {
  way: OsmWay | null;
  reason: WayChoiceReason;
  /** Ближайший конец выбранной тропы до якоря маршрута, км. */
  startDistKm: number | null;
  /** Худшее расстояние путевой точки маршрута до выбранной тропы, км. */
  worstWaypointKm: number | null;
  /** Кандидат, который помешал выбрать однозначно. */
  runnerUpId: number | null;
}

/** Расстояние от точки до ЛОМАНОЙ (не до вершины), км. */
export function distToWayKm(p: WayCandidatePoint, way: OsmWay): number {
  let best = Infinity;
  for (let i = 0; i < way.geometry.length - 1; i++) {
    const a = way.geometry[i], b = way.geometry[i + 1];
    // Проекция на звено в плоскости «километры»: на масштабе звена кривизна
    // Земли ничего не меняет, а формула остаётся читаемой.
    const kx = 111.32 * Math.cos((p.lat * Math.PI) / 180);
    const ax = a.lon * kx, ay = a.lat * 111.32;
    const bx = b.lon * kx, by = b.lat * 111.32;
    const px = p.lng * kx, py = p.lat * 111.32;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
    const cx = ax + t * dx, cy = ay + t * dy;
    const d = Math.hypot(px - cx, py - cy);
    if (d < best) best = d;
  }
  return best;
}

/**
 * Выбрать тропу OSM для маршрута — или честно отказаться.
 *
 * ── Почему правило переписано (17.08) ──────────────────────────────────────
 *
 * Прежнее звучало так: любая тропа, чей КОНЕЦ в четырёх километрах от якоря
 * маршрута, годится; среди годных побеждает САМАЯ ДЛИННАЯ. Ни проверки
 * второго кандидата, ни сверки с путевыми точками самого маршрута.
 *
 * Это ровно то правило, от которого репозиторий уже отказался: в
 * `lib/import/kml-inbox.ts` привязка по близости удалена — из 290 попыток
 * годными оказались 31. Там же записано, что чем длиннее трек, тем меньше
 * близость его начала о нём говорит; здесь длина была призом.
 *
 * Цена ошибки здесь выше обычной: линия получает метку `osm`, а `osm` входит
 * в список СНЯТЫХ источников — значит рисуется сплошной зелёной, то есть
 * «здесь идут». Неверная привязка выглядит проверенным маршрутом.
 *
 * ── Новое правило ──────────────────────────────────────────────────────────
 *
 * Решают ПУТЕВЫЕ ТОЧКИ маршрута, а не длина тропы. Тропа принимается, только
 * если все точки маршрута ложатся на неё ближе WAYPOINT_FIT_KM, и только если
 * такая тропа одна: второй кандидат, ложащийся почти так же хорошо, — это не
 * выбор, а гадание.
 *
 * Маршрут без двух точек с координатами не принимается вовсе. Проверить
 * привязку нечем, а линия, которую нечем проверить, получила бы вид снятого
 * трека — ровно то, что запрещает черта (lib/routes/navigability).
 */
export function chooseWay(
  ways: OsmWay[],
  lat: number,
  lng: number,
  waypoints: WayCandidatePoint[],
): WayChoice {
  const empty = { way: null, startDistKm: null, worstWaypointKm: null, runnerUpId: null };

  const scored = ways.map((way) => {
    const first = way.geometry[0];
    const last = way.geometry[way.geometry.length - 1];
    const startDist = Math.min(
      distKm(lat, lng, first.lat, first.lon),
      distKm(lat, lng, last.lat, last.lon),
    );
    return { way, startDist };
  });
  const nearby = scored.filter((s) => s.startDist <= MAX_START_DIST_KM);
  if (nearby.length === 0) return { ...empty, reason: 'no_candidates' };

  if (waypoints.length < 2) return { ...empty, reason: 'no_waypoints' };

  // Каждому кандидату — худшее расстояние путевой точки до него. Худшее, а не
  // среднее: одна точка в стороне означает, что тропа ведёт не туда, сколько
  // бы остальных на неё ни легло.
  const fitted = nearby
    .map((c) => ({
      ...c,
      worst: Math.max(...waypoints.map((w) => distToWayKm(w, c.way))),
    }))
    .filter((c) => c.worst <= WAYPOINT_FIT_KM)
    .sort((a, b) => a.worst - b.worst);

  if (fitted.length === 0) {
    const best = nearby
      .map((c) => Math.max(...waypoints.map((w) => distToWayKm(w, c.way))))
      .sort((a, b) => a - b)[0];
    return { ...empty, reason: 'waypoints_conflict', worstWaypointKm: Number(best.toFixed(3)) };
  }

  const winner = fitted[0];
  const runnerUp = fitted[1];
  if (runnerUp && runnerUp.worst - winner.worst < AMBIGUOUS_MARGIN_KM) {
    return {
      way: null,
      reason: 'ambiguous',
      startDistKm: Number(winner.startDist.toFixed(3)),
      worstWaypointKm: Number(winner.worst.toFixed(3)),
      runnerUpId: runnerUp.way.id,
    };
  }

  return {
    way: winner.way,
    reason: 'ok',
    startDistKm: Number(winner.startDist.toFixed(3)),
    worstWaypointKm: Number(winner.worst.toFixed(3)),
    runnerUpId: runnerUp?.way.id ?? null,
  };
}

/**
 * Way → GeoJSON LineString ([lng,lat]), ориентированный от точки маршрута:
 * если ближе конец, чем начало — трек разворачивается, чтобы старт был у точки.
 */
export function wayToGeoJSON(way: OsmWay, routeLat: number, routeLng: number): GeoJSONLineString {
  const first = way.geometry[0];
  const last = way.geometry[way.geometry.length - 1];
  const distFirst = distKm(routeLat, routeLng, first.lat, first.lon);
  const distLast = distKm(routeLat, routeLng, last.lat, last.lon);
  const coords =
    distLast < distFirst
      ? [...way.geometry].reverse().map((n) => [n.lon, n.lat])
      : way.geometry.map((n) => [n.lon, n.lat]);
  return { type: 'LineString', coordinates: coords };
}
