/**
 * lib/routes/twins.ts — правила уборки «маршрутов», которые на самом деле места.
 *
 * Импорт (visitkamchatka/idilesom) заводил каждую достопримечательность
 * дважды: как место и как «маршрут». Такая запись маскируется под путь,
 * но пути в ней нет — ни точек, ни дистанции, только имя чужой сущности.
 * Турист получает в каталоге маршрутов список озёр, а на карточке места —
 * ссылку «Маршруты: Озеро Синичкино», ведущую на само же озеро.
 *
 * Критерий намеренно узкий — ТРИ признака сразу:
 *   1. имя точно совпадает с именем живого места;
 *   2. ни одной путевой точки;
 *   3. нет дистанции.
 *
 * Одного «без точек» мало: «Налычевское кольцо» и «Забег на Аагские
 * источники» тоже без точек, но это настоящие маршруты — их спасает
 * отсутствие места-тёзки. Одного совпадения имени тоже мало: маршрут
 * «Долина гейзеров» с четырьмя точками — настоящий путь, названный по
 * цели.
 */

export interface TwinFacts {
  title: string;
  hasPlaceTwin: boolean;
  waypointCount: number;
  hasDistance: boolean;
  tourCount: number;
  geometrySource: string | null;
  hasGeometry: boolean;
}

/** Синтетика — не трек, а прямая, нарисованная миграцией 168. */
const SYNTHETIC_SOURCES = new Set(['waypoints_synthetic', 'road_graph_astar']);

/** Настоящий снятый трек: он ценен сам по себе, даже у записи-двойника. */
export function hasRealTrack(f: TwinFacts): boolean {
  return f.hasGeometry && !SYNTHETIC_SOURCES.has(f.geometrySource ?? '');
}

/** Маскируется под маршрут: три признака разом. */
export function isTwinJunk(f: TwinFacts): boolean {
  return f.hasPlaceTwin && f.waypointCount === 0 && !f.hasDistance;
}

/**
 * Причины НЕ убирать даже подходящую по критерию запись.
 * Пустой список — можно скрывать.
 */
export function blockers(f: TwinFacts): string[] {
  const out: string[] = [];
  if (f.tourCount > 0) {
    out.push(`на записи висит туров: ${f.tourCount} — скрытие оставит тур без маршрута`);
  }
  if (hasRealTrack(f)) {
    out.push(`есть настоящий трек (source=${f.geometrySource ?? 'без метки'}) — сначала решить его судьбу`);
  }
  return out;
}
