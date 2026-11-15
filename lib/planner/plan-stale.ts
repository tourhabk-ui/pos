/**
 * План устарел: анкету поправили после сборки (разбор планера 14.11, экран-1).
 *
 * Прогон: план на 01–05.08 для двоих → в сводке «Когда» 10–20.09 → 6 взрослых →
 * «К маршруту» → заявка. Дни и ссылки туров переехали на сентябрь, хотя места
 * движок проверял на август; в заявке — 10–20.09 и 6 взрослых, а в приложенном
 * плане — 5 дней на двоих. Теперь анкета и план сравниваются: расходятся —
 * экран говорит, что именно, и заявка не уходит, пока план не пересобран.
 *
 * Сторож: tests/unit/planner-plan-stale.test.tsx.
 */
export interface PlanSnapshot {
  arrival: string;
  departure: string;
  adults: number;
  children: readonly number[];
  tripOrigin: string;
  interests: readonly string[];
  budgetTier: string;
}

const sameList = (a: readonly (string | number)[], b: readonly (string | number)[]) =>
  a.length === b.length && [...a].map(String).sort().join('|') === [...b].map(String).sort().join('|');

/** Что в анкете не совпадает с тем, на что собран план; пусто — план в силе. */
export function planStaleReasons(built: PlanSnapshot, now: PlanSnapshot): string[] {
  const out: string[] = [];
  if (built.arrival !== now.arrival || built.departure !== now.departure) out.push('даты');
  if (built.adults !== now.adults || !sameList(built.children, now.children)) out.push('состав группы');
  if (built.tripOrigin !== now.tripOrigin) out.push('откуда едете');
  if (!sameList(built.interests, now.interests)) out.push('занятия');
  if (built.budgetTier !== now.budgetTier) out.push('уровень жилья');
  return out;
}

/** Строка человеку: «После сборки плана изменились даты и состав группы — …». */
export function planStaleText(reasons: readonly string[]): string {
  const what = reasons.length === 1 ? reasons[0] : `${reasons.slice(0, -1).join(', ')} и ${reasons[reasons.length - 1]}`;
  return `После сборки плана изменились ${what} — план собран на прежние. Пересоберите план, чтобы дни, туры и заявка были на то, что в анкете.`;
}
