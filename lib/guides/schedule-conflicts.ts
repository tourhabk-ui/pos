/**
 * Пересечения в расписании гида (#3213): день, на который оператор назначил
 * гида на свою бронь, а у гида в тот же день бронь СВОЕГО тура.
 *
 * До 11.11 расписание гида знало только его личный календарь и назначения
 * оператора: брони своих туров жили отдельно («Свои туры»), и гид, которого
 * оператор назначил на день его собственного тура, этого нигде не видел.
 *
 * Чистая функция: дни считаются по датам брони (`booking_date`, `end_date`
 * многодневной), внутри окна расписания. Времени у брони нет — пересечение
 * называется по дню, а не по часам: кто поведёт группу, решает гид.
 */

/** Бронь как отрезок дней: первый день и последний (null — однодневная). */
export interface DaySpan {
  date: string;
  endDate: string | null;
  tourTitle: string;
}

export interface ScheduleConflict {
  /** День пересечения, ГГГГ-ММ-ДД. */
  date: string;
  /** Туры, на брони которых назначил оператор, — без повторов. */
  assigned: string[];
  /** Свои туры гида с бронью на этот день — без повторов. */
  own: string[];
}

/** Самая длинная бронь, которую разворачиваем по дням: запись с битой датой конца не раздует экран. */
const MAX_SPAN_DAYS = 62;

function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + n)).toISOString().slice(0, 10);
}

/** Дни отрезка внутри окна [from, to], включительно. */
export function daysInWindow(span: Pick<DaySpan, 'date' | 'endDate'>, from: string, to: string): string[] {
  const start = span.date.slice(0, 10);
  const rawEnd = (span.endDate ?? span.date).slice(0, 10);
  const end = rawEnd < start ? start : rawEnd;
  const days: string[] = [];
  let day = start < from ? from : start;
  for (let i = 0; day <= end && day <= to && i < MAX_SPAN_DAYS; i += 1) {
    days.push(day);
    day = addDays(day, 1);
  }
  return days;
}

function byDay(spans: readonly DaySpan[], from: string, to: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const s of spans) {
    for (const d of daysInWindow(s, from, to)) {
      const titles = out.get(d) ?? [];
      if (!titles.includes(s.tourTitle)) titles.push(s.tourTitle);
      out.set(d, titles);
    }
  }
  return out;
}

/** Дни окна, где есть и назначение оператора, и бронь своего тура; по порядку дат. */
export function findScheduleConflicts(
  assignments: readonly DaySpan[],
  own: readonly DaySpan[],
  from: string,
  to: string,
): ScheduleConflict[] {
  const assigned = byDay(assignments, from, to);
  const mine = byDay(own, from, to);
  return [...assigned.keys()]
    .filter((d) => mine.has(d))
    .sort()
    .map((date) => ({ date, assigned: assigned.get(date) ?? [], own: mine.get(date) ?? [] }));
}
