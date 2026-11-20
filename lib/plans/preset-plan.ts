/**
 * lib/plans/preset-plan.ts — правила страницы готового плана /plans/[slug]
 * (аудит планировщика 07.11, волна 2.7, H16). Чистый модуль: страница
 * собирает данные, правила живут здесь и проверяются вызовом.
 *
 * До 07.11 на странице «Камчатка за 5 дней» было три расхождения с планом:
 * - отъезд считался как прилёт + 5 суток, а движок считает дни включительно,
 *   и «5 дней» собирались на шесть;
 * - день вылета движок нумерует по дате, и при недоборе номера шли с дырой
 *   (1, 2, 3, 4, 6), а строку «Наполнили N из M» страница не показывала;
 * - тур дня брался «лучший по виду», а не тот, что поставил движок. Движок
 *   выбирает туры тем же правилом 1в (lib/planner/data → orderOffersBy), что
 *   и витрина, — показ его тура правило «один порядок для всех» не нарушает.
 */
import { ACTIVITY_CONSTRAINTS } from '@/lib/planner/constants';
import { fillCalendarGaps, isFreeDay, type CalendarDayLike, type FreeDay } from '@/lib/planner/calendar-days';

const DAY_MS = 86_400_000;

/**
 * Даты плана: ближайший старт в месяцах пресета (`months` — у сезонных «в
 * июне», «в сентябре», «зимой»), у остальных — В СЕЗОНЕ главного интереса
 * (первого в списке), иначе — через месяц. N дней — N календарных дней:
 * отъезд — прилёт + (N − 1).
 *
 * До 20.11 месяцы пресета сюда не доходили: «Камчатка в июне» и «Камчатка в
 * сентябре» (главный интерес — вулканы, сезон 7–9) считались на 10 июля, и на
 * июньской странице стояли восхождение на Авачинский (тур идёт с 1.07) и
 * Курильское озеро (с 19.07), а на сентябрьской — рыбалка на чавычу и нерку
 * (18.06–20.07). Замечание Сыщика 20.11.
 */
export function presetPlanDates(
  days: number,
  interests: readonly string[],
  now: Date = new Date(),
  presetMonths?: readonly number[],
): { arrival: string; departure: string } {
  const soon = now.getTime() + 30 * DAY_MS;
  const months = presetMonths && presetMonths.length > 0
    ? presetMonths
    : ACTIVITY_CONSTRAINTS[interests[0] ?? '']?.months ?? [];

  let arrival = new Date(soon);
  if (months.length > 0) {
    const from = new Date(soon);
    for (let i = 0; i < 24; i++) {
      const candidate = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + i, 10));
      if (months.includes(candidate.getUTCMonth() + 1)) { arrival = candidate; break; }
    }
  }

  const departure = new Date(arrival.getTime() + (Math.max(1, Math.floor(days)) - 1) * DAY_MS);
  return {
    arrival: arrival.toISOString().slice(0, 10),
    departure: departure.toISOString().slice(0, 10),
  };
}

/**
 * Строка недобора от движка: «Наполнили N дней из M: …». Движок говорит её
 * предупреждением рода `duration` (engine.ts, «План короче запрошенного»);
 * других предупреждений этого рода у него несколько, нужное — по началу
 * строки. Плана без недобора — null.
 */
export function planFillNote(warnings: ReadonlyArray<{ type: string; message: string }> | null | undefined): string | null {
  return warnings?.find((w) => w.type === 'duration' && w.message.startsWith('Наполнили '))?.message ?? null;
}

/** Описание свободного дня на странице плана: карты, где выбрать маршрут, здесь нет. */
export const PRESET_FREE_DAY_TEXT = 'На этот день подтверждённого выхода в каталоге нет — день свободный.';

/**
 * Дни страницы — подряд по календарю: пропуск в номерах (недобор, день вылета
 * с номером-датой) — свободный день, как в планировщике (волна 2.1).
 */
export function presetCalendarDays<T extends CalendarDayLike>(days: readonly T[], tripDays: number): Array<T | FreeDay> {
  return fillCalendarGaps(days, tripDays).map((d) => (isFreeDay(d) ? { ...(d as FreeDay), description: PRESET_FREE_DAY_TEXT } : d));
}

/**
 * Тур дня: тот, что поставил движок; нет его (или он снят с витрины) — подбор
 * по виду занятия (правило 1в, оно названо на странице) с пометкой `kind`.
 */
export function presetDayTour<T>(
  day: { activityType: string; realTour?: { tourId: string } | null },
  engineTours: Readonly<Record<string, T>>,
  kindTours: Readonly<Record<string, T>>,
): { tour: T; source: 'plan' | 'kind' } | null {
  const planned = day.realTour?.tourId ? engineTours[String(day.realTour.tourId)] : undefined;
  if (planned) return { tour: planned, source: 'plan' };
  const kind = kindTours[day.activityType];
  return kind ? { tour: kind, source: 'kind' } : null;
}

const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

/**
 * Оговорка о сезоне тура на дне плана (Сыщик 21.11): план показывает тур и
 * вне его сезона. Год не называется: сезон оператора повторяется. Сезона нет
 * или он круглый год — null.
 */
export function tourSeasonNote(seasonStart: string | null | undefined, seasonEnd: string | null | undefined): string | null {
  const parse = (v: string | null | undefined) => {
    const m = v ? /^(\d{4})-(\d{2})-(\d{2})/.exec(v) : null;
    return m ? { month: Number(m[2]), day: Number(m[3]) } : null;
  };
  const a = parse(seasonStart);
  const b = parse(seasonEnd);
  if (!a || !b) return null;
  if (a.month === 1 && a.day === 1 && b.month === 12 && b.day === 31) return null;
  return `Тур идёт только с ${a.day} ${MONTHS_GEN[a.month - 1]} по ${b.day} ${MONTHS_GEN[b.month - 1]}: в другие даты этого дня в плане не будет.`;
}
