/**
 * Общие предупреждения плана после правки (#3199, M10). Чистый модуль.
 *
 * Ответ `edit_trip_plan` печатал только предупреждения самой правки, и
 * общие строки плана пропадали — среди них критичная «дня на возвращение
 * нет». Хранить строки сборки в черновике и повторять их нельзя: после
 * правки они могут стать неправдой (добавили день — «рыбалке не нашлось
 * дня» уже ложь). Поэтому здесь — только то, что честно выводится из самих
 * дней плана после правки: самопроверка возвращения — план кончается в
 * дальней зоне, а дня переезда в город нет (то же правило и те же слова,
 * что у движка).
 * Чего из дней не вывести (какая зона не вошла, какой интерес без дня,
 * сезон), ответ называет одной строкой: это даёт новая сборка.
 */

import { ZONE_NAMES, type ZoneId } from '@/lib/planner/constants';
import { ZONE_GRAPH } from '@/lib/planner/zone-graph';
import type { TripOrigin } from '@/lib/planner/trip-origin';

/** Слова критичной самопроверки возвращения — одни у движка и у правки. */
export function returnLegMissingMessage(zone: ZoneId, origin: TripOrigin | undefined): string {
  return `План кончается в ${ZONE_NAMES[zone] ?? zone}, а дня на возвращение в Петропавловск в нём нет — `
    + (origin === 'local'
      ? 'вернуться в город в тот же день не выйдет. Добавьте день к поездке или уберите дальнюю зону; мы это учтём при следующей сборке.'
      : 'вылет из города в тот же день невозможен. Добавьте день к поездке или уберите дальнюю зону; мы это учтём при следующей сборке.');
}

/** Чего правка не пересчитывает — одной строкой, а не молчанием (§4.0). */
export const EDIT_NOT_RECHECKED_NOTE =
  'Сезон, зоны, не вошедшие в план, и просьбы без своего дня правка не пересчитывает — '
  + 'их заново проверит только новая сборка make_trip_plan.';

interface DayLike { day: number; type: string; zone: ZoneId }

/**
 * Зона, где план кончается без дня на возвращение, или null. Последний
 * день перед отъездом в дальней зоне, куда за день не съездить, — значит
 * дня возвращения нет. Северная зона (вертолёт туда и обратно в тот же
 * день) возвращения отдельным днём не требует, как и у движка.
 */
export function missingReturnZone(days: readonly DayLike[]): ZoneId | null {
  const stay = [...days].sort((a, b) => a.day - b.day).filter((d) => d.type !== 'departure');
  const last = stay[stay.length - 1];
  if (!last || last.zone === 'avachinsky') return null;
  const back = ZONE_GRAPH[last.zone]?.avachinsky;
  if (back && !back.needsTravelDay) return null;
  return last.zone;
}

/**
 * Критичные строки плана после правки — в «Важно» ответа, первыми.
 */
export function planWideAfterEdit(days: readonly DayLike[], origin?: TripOrigin): string[] {
  const zone = missingReturnZone(days);
  return zone ? [returnLegMissingMessage(zone, origin)] : [];
}
