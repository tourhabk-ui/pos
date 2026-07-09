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
 * Из набора ways выбирает лучший: у которого ближайший конец в пределах
 * MAX_START_DIST_KM от точки маршрута, а среди таких — самый длинный (по узлам).
 * null — если ни один не подходит по близости.
 */
export function pickBestWay(ways: OsmWay[], lat: number, lng: number): OsmWay | null {
  const scored = ways.map((way) => {
    const first = way.geometry[0];
    const last = way.geometry[way.geometry.length - 1];
    const startDist = Math.min(
      distKm(lat, lng, first.lat, first.lon),
      distKm(lat, lng, last.lat, last.lon),
    );
    return { way, startDist, nodeCount: way.geometry.length };
  });
  const nearby = scored.filter((s) => s.startDist <= MAX_START_DIST_KM);
  if (nearby.length === 0) return null;
  nearby.sort((a, b) => b.nodeCount - a.nodeCount);
  return nearby[0].way;
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
