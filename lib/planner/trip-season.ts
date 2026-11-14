/**
 * Сезон занятия — по дате КАЖДОГО дня поездки, а не по месяцу прилёта
 * (разбор планера 14.11, движок-1/2/17).
 *
 * ── Что было ────────────────────────────────────────────────────────────
 *
 * Движок брал один месяц — месяц прилёта — и судил им всю поездку:
 *   - поездка с 28.09 на 10 дней, треккинг: самостоятельные «Тропа 4–5» на
 *     01–02.10 и ещё четыре дня треккинга в октябре — вне собственного
 *     сезона движка (6–9, «снег на тропах»), без единой строки о сезоне.
 *     По сетке разбора — 48 самостоятельных и 209 общих дней вне сезона;
 *   - поездка с 25.06 на 16 дней, вулканы: пустой план и «все просьбы вне
 *     сезона», хотя с 1 июля сезон и выезды есть;
 *   - месяц читался `new Date('YYYY-MM-DD').getMonth()` — по часовому поясу
 *     сервера: западнее UTC 1 июля было июнем.
 *
 * ── Правило ─────────────────────────────────────────────────────────────
 *
 *   - занятие берётся в план, если оно в сезоне хотя бы в одном месяце
 *     поездки (`inTripSeason`);
 *   - день ставится, только если занятие в сезоне в месяц ЭТОГО дня
 *     (`inSeasonIn`). Вне сезона в этот день — ни маршрута, ни общего дня;
 *   - месяц — из строки даты, без часового пояса (`monthOfIsoDate`).
 *
 * Свидетели сезона прежние (engine.ts, `inSeason`): таблица движка — пол,
 * каталог месяца (записи операторов и туры без календаря) окно расширяет.
 * Каталог спрашивается за каждый месяц поездки: запись оператора на июль не
 * открывает июнь.
 *
 * Сторож: tests/unit/planner-season-by-day.test.ts.
 */
import { ACTIVITY_CONSTRAINTS } from '@/lib/planner/constants';
import { dateOfTripDay } from '@/lib/planner/flow-balance';

/** «в июне» — месяц в предложном падеже, 1..12. */
export const MONTH_IN = ['январе', 'феврале', 'марте', 'апреле', 'мае', 'июне', 'июле', 'августе', 'сентябре', 'октябре', 'ноябре', 'декабре'];

/** Месяц даты «YYYY-MM-DD…» (1..12) — из строки, без часового пояса. */
export function monthOfIsoDate(iso: string | null | undefined): number | null {
  const m = /^\d{4}-(\d{2})-\d{2}/.exec(iso ?? '');
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 12 ? n : null;
}

/**
 * Месяцы поездки по порядку, без повторов. Дат нет — один месяц `fallback`
 * (текущий по Камчатке): судить больше нечем.
 */
export function tripMonths(arrival: string | null | undefined, tripDays: number, fallback: number): number[] {
  const out: number[] = [];
  if (arrival) {
    for (let n = 1; n <= Math.max(1, tripDays); n++) {
      const m = monthOfIsoDate(dateOfTripDay(arrival, n));
      if (m !== null && !out.includes(m)) out.push(m);
    }
  }
  return out.length > 0 ? out : [fallback];
}

/** Сезон поездки: месяцы и что каталог открыл в каждом из них. */
export interface TripSeason {
  months: readonly number[];
  /**
   * Открытое каталогом в месяц `m`: записи операторов этого месяца и туры без
   * календаря. `null` — записи месяца не прочитались (действует один пол).
   */
  openIn(m: number): Set<string> | null;
  /**
   * Открытое в месяц `m` ТОЛЬКО турами без календаря: по нашему ориентиру не
   * сезон, и без оператора туда не идут (ни маршрута, ни приглашения).
   */
  onRequestOnlyIn(m: number): ReadonlySet<string>;
}

/**
 * `scheduled` — записи операторов по месяцам (`null` — не прочиталось),
 * `onRequest` — занятия туров без календаря (`null` — не прочиталось; у «Сам»
 * пустое множество: туров он не берёт).
 */
export function buildTripSeason(
  months: readonly number[],
  scheduled: ReadonlyMap<number, Set<string> | null>,
  onRequest: ReadonlySet<string> | null,
): TripSeason {
  const open = new Map<number, Set<string> | null>();
  const requestOnly = new Map<number, Set<string>>();
  for (const m of months) {
    const sch = scheduled.get(m) ?? null;
    open.set(m, sch === null ? null : new Set([...sch, ...(onRequest ?? [])]));
    requestOnly.set(m, new Set([...(onRequest ?? [])].filter((k) => {
      const c = ACTIVITY_CONSTRAINTS[k];
      return c !== undefined && !c.months.includes(m) && !(sch?.has(k) ?? false);
    })));
  }
  return {
    months,
    openIn: (m) => (open.has(m) ? open.get(m)! : null),
    onRequestOnlyIn: (m) => requestOnly.get(m) ?? new Set(),
  };
}

/** В сезоне ли занятие в месяц `m`: пол таблицы или каталог месяца. */
export function inSeasonIn(season: TripSeason, interest: string, m: number): boolean {
  const c = ACTIVITY_CONSTRAINTS[interest];
  if (!c) return false;
  if (c.months.includes(m)) return true;
  return season.openIn(m)?.has(interest) ?? false;
}

/** В сезоне ли занятие хотя бы в одном месяце поездки. */
export function inTripSeason(season: TripSeason, interest: string): boolean {
  return season.months.some((m) => inSeasonIn(season, interest, m));
}

/** Месяцы поездки, где занятие вне сезона (пусто — в сезоне все дни). */
export function monthsOutOfSeason(season: TripSeason, interest: string): number[] {
  return season.months.filter((m) => !inSeasonIn(season, interest, m));
}

/** Занятие открыто только турами без календаря хотя бы в одном месяце поездки. */
export function onRequestOnlySomewhere(season: TripSeason, interest: string): boolean {
  return season.months.some((m) => season.onRequestOnlyIn(m).has(interest));
}

/**
 * Занятие открыто только турами без календаря во ВСЕХ месяцах поездки, где
 * оно в сезоне: маршрута для самостоятельного дня искать не нужно вовсе.
 */
export function onRequestOnlyEverywhere(season: TripSeason, interest: string): boolean {
  const live = season.months.filter((m) => inSeasonIn(season, interest, m));
  return live.length > 0 && live.every((m) => season.onRequestOnlyIn(m).has(interest));
}

/** «июне и июле» — список месяцев для строки человеку. */
export function monthsInWords(months: readonly number[]): string {
  const words = months.map((m) => MONTH_IN[m - 1] ?? String(m));
  return words.length <= 1 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} и ${words[words.length - 1]}`;
}
