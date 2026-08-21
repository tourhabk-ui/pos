/**
 * lib/routes/path-choice.ts — выбор пути ОТ МЕСТА (решение владельца 20.08).
 *
 * Как в навигаторе: человек называет место, платформа показывает пути к
 * нему, сравнимые по роду линии и длине. Прежний плоский список маршрутов
 * ломал модель: «Скалы Три Брата» давали четыре строки-варианта, и место
 * между ними терялось.
 *
 * Сравнение путей — как у зрелых аутдор-платформ (решение владельца 21.08),
 * но с нашим первым ключом: род линии (снятый трек выше любых догадок:
 * различение трека и ломаной — главная защита платформы), затем сложность
 * (легче выше — выбирает массовый турист, а не спортсмен), затем длина,
 * затем набор высоты. Совпавшие только НАЗВАНИЕМ маршрута — отдельной
 * секцией в конце, честно подписанной: они не «пути к месту», пока связь
 * не установлена.
 */

export interface PathCandidate {
  id: string;
  title: string;
  distanceKm: number | null;
  lineGrade?: string | null;
  waypointNames?: string[];
  difficulty?: string | null;
  elevationGainM?: number | null;
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

/**
 * Ранг сложности: легче выше. Неуказанная сложность — СЕРЕДИНА (1.5),
 * а не край: «не знаю» — не награда и не приговор (правило третьего
 * состояния), и константа держит компаратор транзитивным — null между
 * medium и hard, а не «равен всем сразу».
 */
const DIFF_RANK: Record<string, number> = {
  easy: 0, medium: 1, moderate: 1, hard: 2, extreme: 3,
};
const DIFF_UNKNOWN = 1.5;

function diffRank(d: string | null | undefined): number {
  if (!d) return DIFF_UNKNOWN;
  return DIFF_RANK[d.toLowerCase()] ?? DIFF_UNKNOWN;
}

export function comparePaths(a: PathCandidate, b: PathCandidate): number {
  const ga = GRADE_RANK[a.lineGrade ?? 'none'] ?? 4;
  const gb = GRADE_RANK[b.lineGrade ?? 'none'] ?? 4;
  if (ga !== gb) return ga - gb;
  const da = diffRank(a.difficulty);
  const db = diffRank(b.difficulty);
  if (da !== db) return da - db;
  const la = a.distanceKm ?? Infinity;
  const lb = b.distanceKm ?? Infinity;
  if (la !== lb) return la - lb;
  // Набор высоты — последний ключ: при прочих равных меньший набор выше,
  // неизвестный — после известного (Infinity), не вперемешку.
  return (a.elevationGainM ?? Infinity) - (b.elevationGainM ?? Infinity);
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
