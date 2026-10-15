/**
 * В каких контурах лежит точка — для сверки мест с охраняемыми территориями
 * OpenStreetMap (15.10, перепись режима по схеме парков).
 *
 * ── Зачем ──────────────────────────────────────────────────────────────────
 *
 * Режим места (`places.eco_zone`) 169/170 ставили по ILIKE в имени и
 * описании, а всем остальным видимым — «нет» одним UPDATE. Чтобы судить
 * режим, нужен контур территории: точка внутри границы заповедника — это
 * факт о месте, слово «кроноцк» в описании — нет. Публичные Overpass 15.10
 * не отдали даже пакет из восьми is_in («at capacity», проба 961), поэтому
 * контуры берутся из выгрузки Geofabrik на раннере, а точка проверяется
 * здесь.
 *
 * ── Что функция утверждает и чего нет ──────────────────────────────────────
 *
 * «Точка внутри контура OSM» — улика, а не вердикт: контур OSM нарисован
 * людьми и бывает рамкой вместо настоящей границы (случай Корякского
 * заповедника 14.10, CLAUDE.md §4.1). Поэтому функция отвечает только на
 * геометрический вопрос, а режим ставит человек миграцией, сверив
 * территорию с её положением.
 *
 * Координаты — как в GeoJSON: [долгота, широта]. Край не пересекает 180-й
 * меридиан (Командоры — до 168° в. д.), поэтому плоский луч по долготе
 * здесь честен.
 */

export type Position = readonly [number, number];
export type Ring = readonly Position[];

export type AreaGeometry =
  | { type: 'Polygon'; coordinates: readonly Ring[] }
  | { type: 'MultiPolygon'; coordinates: readonly (readonly Ring[])[] };

export interface Area<T = unknown> {
  geometry: AreaGeometry;
  /** Что вернуть вызывающему про этот контур (имя, класс, id OSM). */
  info: T;
}

/**
 * Что считаем охраняемой территорией — те же теги, что спрашивались у
 * Overpass в пробах is_in: `boundary=protected_area`, `boundary=national_park`,
 * `leisure=nature_reserve`.
 */
export function isProtectedArea(tags: Record<string, unknown>): boolean {
  return tags.boundary === 'protected_area' || tags.boundary === 'national_park' || tags.leisure === 'nature_reserve';
}

/** Точка внутри кольца — луч на восток, чётность пересечений. */
export function pointInRing(lng: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Внутри внешнего кольца и ни в одной дыре. */
export function pointInPolygon(lng: number, lat: number, rings: readonly Ring[]): boolean {
  if (rings.length === 0 || !pointInRing(lng, lat, rings[0])) return false;
  for (let k = 1; k < rings.length; k++) {
    if (pointInRing(lng, lat, rings[k])) return false;
  }
  return true;
}

export function pointInGeometry(lng: number, lat: number, g: AreaGeometry): boolean {
  if (g.type === 'Polygon') return pointInPolygon(lng, lat, g.coordinates);
  return g.coordinates.some((poly) => pointInPolygon(lng, lat, poly));
}

/** Площадь кольца в квадратных градусах (формула шнурка) — только для порядка. */
function ringArea(ring: Ring): number {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    s += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  }
  return Math.abs(s) / 2;
}

/** Площадь контура в квадратных градусах: внешние кольца минус дыры. */
export function geometryArea(g: AreaGeometry): number {
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  let total = 0;
  for (const rings of polys) {
    if (rings.length === 0) continue;
    total += ringArea(rings[0]);
    for (let k = 1; k < rings.length; k++) total -= ringArea(rings[k]);
  }
  return total;
}

/**
 * Контуры, в которых лежит точка, — от меньшего к большему: памятник внутри
 * парка стоит первым, потому что режим места строже всего говорит самый
 * тесный контур. Пустой список — законный ответ: «ни в одном контуре OSM»,
 * что НЕ значит «не на охраняемой территории» (не всё нанесено на карту).
 */
export function containingAreas<T>(lng: number, lat: number, areas: readonly Area<T>[]): T[] {
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return [];
  return areas
    .filter((a) => pointInGeometry(lng, lat, a.geometry))
    .map((a) => ({ a, size: geometryArea(a.geometry) }))
    .sort((x, y) => x.size - y.size)
    .map(({ a }) => a.info);
}
