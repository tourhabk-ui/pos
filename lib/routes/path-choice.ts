/**
 * lib/routes/path-choice.ts — выбор пути ОТ МЕСТА (решение владельца 20.08).
 *
 * Как в навигаторе: человек называет место, платформа показывает пути к
 * нему, сравнимые по роду линии и длине. Прежний плоский список маршрутов
 * ломал модель: «Скалы Три Брата» давали четыре строки-варианта, и место
 * между ними терялось.
 *
 * Сравнение путей — сначала род линии (снятый трек выше любых догадок:
 * различение трека и ломаной — главная защита платформы), внутри рода —
 * длина. Совпавшие только НАЗВАНИЕМ маршрута — отдельной секцией в конце,
 * честно подписанной: они не «пути к месту», пока связь не установлена.
 */

export interface PathCandidate {
  id: string;
  title: string;
  distanceKm: number | null;
  lineGrade?: string | null;
  waypointNames?: string[];
}

export interface PlaceGroup<T extends PathCandidate = PathCandidate> {
  /** null — маршруты, совпавшие только названием (отдельная секция). */
  place: string | null;
  routes: T[];
}

/** Ранг рода линии: снятый трек всегда выше догадок и набросков. */
const GRADE_RANK: Record<string, number> = {
  surveyed: 0, gps: 0, unknown: 1, sketch: 2, points_only: 3, none: 4,
};

export function comparePaths(a: PathCandidate, b: PathCandidate): number {
  const ga = GRADE_RANK[a.lineGrade ?? 'none'] ?? 4;
  const gb = GRADE_RANK[b.lineGrade ?? 'none'] ?? 4;
  if (ga !== gb) return ga - gb;
  return (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity);
}

function normPlace(s: string): string {
  return s.toLowerCase().replace(/ё/g, 'е').trim();
}

/**
 * Пути группируются по месту, которым найдены (первое совпавшее имя из
 * путевых точек); внутри группы — по роду линии и длине. Группы — по
 * числу путей, чтобы самое богатое место стояло первым.
 */
export function groupRoutesByPlace<T extends PathCandidate>(
  routes: T[],
  query: string,
): PlaceGroup<T>[] {
  const nq = normPlace(query);
  const byPlace = new Map<string, T[]>();
  const titleOnly: T[] = [];
  for (const r of routes) {
    const hit = nq.length > 0
      ? (r.waypointNames ?? []).find(n => normPlace(n).includes(nq))
      : undefined;
    if (hit) {
      const list = byPlace.get(hit) ?? [];
      list.push(r);
      byPlace.set(hit, list);
    } else {
      titleOnly.push(r);
    }
  }
  const groups: PlaceGroup<T>[] = [...byPlace.entries()]
    .map(([place, rs]) => ({ place, routes: rs.sort(comparePaths) }))
    .sort((x, y) => y.routes.length - x.routes.length);
  if (titleOnly.length > 0) groups.push({ place: null, routes: titleOnly.sort(comparePaths) });
  return groups;
}
