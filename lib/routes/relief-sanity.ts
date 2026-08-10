/**
 * Трек соответствует названию маршрута — или не соответствует, и это видно.
 *
 * Высоты, залитые 09.08, вскрыли то, что раньше было невидимо: маршрут
 * «Вулкан Кроноцкий» получил высоты −1…45 м. Модель рельефа не ошиблась — она
 * честно вернула уровень моря для координат, которые на уровне моря и лежат.
 * Значит трек этого маршрута идёт не туда, куда обещает название. Кроноцкая
 * сопка — 3528 м.
 *
 * Пока высот не было, такой трек выглядел как любой другой: линия и линия.
 * Теперь данные противоречат сами себе, и противоречие можно поймать
 * арифметикой, а не глазами. Это важно ровно по одной причине: человек
 * планирует выход по названию, а идёт по треку. Если они про разные места,
 * он узнает об этом в поле.
 *
 * Здесь только проверки — без запросов и вывода. Что делать с находкой,
 * решает человек: имена мест на Камчатке путаные, и автоматически чинить
 * геометрию по названию нельзя.
 */

/** Насколько далеко трек вправе уходить от объявленной точки маршрута. */
export const MAX_TRACK_OFFSET_KM = 30;
/** Ниже этой отметки «вулкан» и «сопка» не бывают. */
export const MIN_SUMMIT_M = 500;

const KM_PER_DEG_LAT = 111.32;

/** Слова, которые обещают высоту. */
const HEIGHT_WORDS = /(вулкан|сопка|сопки|гора|горы|перевал|пик|хребет|вершина)/i;

export interface RouteReliefRow {
  id: string;
  title: string;
  /** Объявленная точка маршрута. */
  lat: number | null;
  lng: number | null;
  /** Первая точка трека. */
  trackLat: number | null;
  trackLng: number | null;
  maxElevationM: number | null;
  minElevationM: number | null;
}

export interface ReliefFinding {
  id: string;
  title: string;
  kind: 'track_far' | 'summit_too_low';
  /** Человеческое объяснение — оно и попадёт в отчёт. */
  detail: string;
}

export function distanceKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const kmLng = KM_PER_DEG_LAT * Math.cos((((aLat + bLat) / 2) * Math.PI) / 180);
  return Math.hypot((bLat - aLat) * KM_PER_DEG_LAT, (bLng - aLng) * kmLng);
}

/**
 * Проверки, каждая из которых ловит своё.
 *
 * Расстояние от объявленной точки не зависит от языка и написания — им
 * ловится подменённый трек. Высота вершины зависит от названия, зато ловит
 * случай, когда точка маршрута верна, а трек ведёт вокруг горы понизу.
 */
export function checkRoute(row: RouteReliefRow): ReliefFinding[] {
  const out: ReliefFinding[] = [];

  if (row.lat != null && row.lng != null && row.trackLat != null && row.trackLng != null) {
    const km = distanceKm(row.lat, row.lng, row.trackLat, row.trackLng);
    if (km > MAX_TRACK_OFFSET_KM) {
      out.push({
        id: row.id,
        title: row.title,
        kind: 'track_far',
        detail: `Трек начинается в ${Math.round(km)} км от точки маршрута — похоже, трек чужой`,
      });
    }
  }

  if (HEIGHT_WORDS.test(row.title) && row.maxElevationM != null && row.maxElevationM < MIN_SUMMIT_M) {
    out.push({
      id: row.id,
      title: row.title,
      kind: 'summit_too_low',
      detail: `Название обещает высоту, а трек не поднимается выше ${row.maxElevationM} м`,
    });
  }

  return out;
}

export function checkRoutes(rows: RouteReliefRow[]): ReliefFinding[] {
  return rows.flatMap(checkRoute);
}

/** Короткий человеческий итог: сколько и чего. */
export function summarize(findings: ReliefFinding[], total: number): string {
  if (findings.length === 0) return `Проверено ${total} маршрутов, расхождений нет`;
  const far = findings.filter(f => f.kind === 'track_far').length;
  const low = findings.filter(f => f.kind === 'summit_too_low').length;
  const parts: string[] = [];
  if (far) parts.push(`${far} с чужим треком`);
  if (low) parts.push(`${low} без обещанной высоты`);
  return `Проверено ${total} маршрутов, расхождений ${findings.length}: ${parts.join(', ')}`;
}
