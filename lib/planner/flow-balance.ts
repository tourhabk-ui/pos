/**
 * Распределение потока: не слать всех в одно место.
 *
 * Владелец 25.09: «всех туристов нельзя в один поток направлять — 500
 * человек на одну локацию, где есть природоохранные ограничения».
 *
 * Здесь чистое правило, без базы: сколько людей уже едет в место по броням
 * (`planned`), какой у места лимит (`limit`, миграция 1016) и что из этого
 * следует для выбора. Данные приносит `place-load.ts`, применяет
 * `recommendTrip` (engine.ts).
 *
 * ── Четыре исхода, а не два (§4.0) ───────────────────────────────────────
 *   over_limit   — лимит известен, и с вашей группой он превышен;
 *   within_limit — лимит известен, место есть;
 *   no_limit     — лимита нет в данных: это «не знаем», НЕ «свободно»;
 *   not_counted  — загрузку посчитать не вышло: судить не о чем.
 *
 * ── Как выбирается место ─────────────────────────────────────────────────
 * Из равноценных кандидатов (движок уже отобрал их по зоне и интересу)
 * сначала менее загруженный по броням в даты поездки. Кандидат, у которого
 * хоть одно место сверх лимита, не предлагается и называется в
 * предупреждении. Порядок равных сохраняется: сортировка устойчивая, и при
 * нулевой загрузке у всех план остаётся прежним.
 *
 * Не посчиталось — порядок не трогается и никто не отсеивается: отказ
 * запроса не повод ни прятать место, ни объявлять его свободным.
 */

export interface PlaceLoad {
  placeId: string;
  name: string;
  /** Людей по броням в самые загруженные сутки окна; null — не посчитано. */
  planned: number | null;
  /** Лимит людей в сутки; null — лимит не известен. */
  limit: number | null;
  /** Чья это норма; есть всегда, когда есть лимит (ограничение миграции 1016). */
  limitSource: string | null;
}

export type LoadVerdict = 'over_limit' | 'within_limit' | 'no_limit' | 'not_counted';

export function loadVerdict(place: PlaceLoad, group: number): LoadVerdict {
  if (place.planned === null) return 'not_counted';
  if (place.limit === null) return 'no_limit';
  return place.planned + group > place.limit ? 'over_limit' : 'within_limit';
}

/** Места кандидата сверх лимита — первое из них; null — упора нет. */
export function firstOverLimit(places: PlaceLoad[], group: number): PlaceLoad | null {
  return places.find((p) => loadVerdict(p, group) === 'over_limit') ?? null;
}

/** Загрузка кандидата — самое загруженное из его мест; не посчитано — 0. */
function busiest(places: PlaceLoad[]): number {
  let max = 0;
  for (const p of places) if (p.planned !== null && p.planned > max) max = p.planned;
  return max;
}

export interface Ranked<T> {
  ranked: T[];
  /** Не предложены: у кандидата место сверх лимита. */
  blocked: Array<{ candidate: T; place: PlaceLoad }>;
}

/**
 * Упорядочить кандидатов по загрузке и отсеять упёршихся в лимит.
 *
 * `loads` — места каждого кандидата по его id; `null` — загрузку спросить
 * не вышло, и тогда порядок возвращается нетронутым.
 */
export function rankByLoad<T extends { id: string }>(
  candidates: T[],
  loads: Map<string, PlaceLoad[]> | null,
  group: number,
): Ranked<T> {
  if (!loads) return { ranked: candidates, blocked: [] };
  const blocked: Ranked<T>['blocked'] = [];
  const open: Array<{ c: T; load: number; i: number }> = [];
  candidates.forEach((c, i) => {
    const places = loads.get(c.id) ?? [];
    const over = firstOverLimit(places, group);
    if (over) blocked.push({ candidate: c, place: over });
    else open.push({ c, load: busiest(places), i });
  });
  open.sort((a, b) => a.load - b.load || a.i - b.i);
  return { ranked: open.map((o) => o.c), blocked };
}

/** Строка о месте сверх лимита — одна для плана и для дня тура. */
export function overLimitText(place: PlaceLoad): string {
  return `${place.name}: по броням уже ${place.planned} из ${place.limit} человек в сутки (норма: ${place.limitSource})`;
}

/** Дата N-го дня поездки (день 1 — день прилёта), YYYY-MM-DD. */
export function dateOfTripDay(arrivalDate: string, dayNum: number): string | null {
  const t = Date.parse(`${arrivalDate.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(t) || dayNum < 1) return null;
  return new Date(t + (dayNum - 1) * 86_400_000).toISOString().slice(0, 10);
}
