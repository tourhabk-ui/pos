/**
 * lib/trips/trip-now.ts — сохранённый план поездки, перепроверенный сегодня.
 *
 * Слово владельца 19.11: «3394 начни с обновления плана ближе к датам»
 * (#3394, хвост #3347, п. 2 рекомендаций: «сохранить черновик и предложить
 * переоткрыть и обновить ближе к датам»).
 *
 * План в «Моих маршрутах» — снимок на день сохранения: предупреждения дня и
 * плана записаны тогда, места туров и погода не записаны вовсе. Страница
 * поездки так и говорит: «обстановка с тех пор могла измениться». Здесь тот
 * же план проверяется заново — тем же правилом, что у планера и страницы по
 * ссылке, без своего:
 *  - строки безопасности дня (закрытия парков, штормовые и паводковые
 *    предупреждения, сводки МЧС) — `refreshDatedSafety`, как при сдвиге дат в
 *    планере. Ответ — что ПОЯВИЛОСЬ и что БОЛЬШЕ НЕ ДЕЙСТВУЕТ по сравнению с
 *    сохранённым днём. Не смогли прочитать — прежние строки остаются, а план
 *    говорит «проверить не удалось»: снятое закрытие хуже лишней осторожности;
 *  - места тура дня на его дату для всей группы — `readDayAvailability`
 *    (lib/trips/day-fresh), пять исходов;
 *  - прогноз на дату дня — `readDayForecast`, только в горизонте 16 суток.
 *
 * План при этом не меняется и не сохраняется: человек видит, что изменилось,
 * и сам решает, собирать ли план заново. Прошедшие дни не проверяются.
 */
import type { DayPlan } from '@/lib/planner/engine';
import { DEFAULT_SAFETY_DEPS, refreshDatedSafety, type SafetyRefreshDeps } from '@/lib/planner/plan-safety-refresh';
import { dateOfTripDay } from '@/lib/planner/flow-balance';
import { kamchatkaToday } from '@/lib/planner/calendar-days';
import { MOVABLE_TYPES, tourGroup } from '@/lib/planner/plan-ops';
import { createPlannerCache } from '@/lib/planner';
import type { TripDayAvailability } from './day-availability';
import { FORECAST_HORIZON_DAYS, readDayAvailability, readDayForecast, type TripDayForecast } from './day-fresh';
import type { TripNow, TripNowDay } from './trip-now-types';

export type { TripNow, TripNowDay } from './trip-now-types';

/** День сохранённого плана — поля, которые нужны перепроверке. */
export interface SavedTripDay {
  day: number;
  zone: string;
  title: string;
  type?: string;
  activityType?: string;
  coords?: readonly [number, number] | readonly number[];
  realTour?: { tourId: string } | null;
  availableDate?: string;
  dayWarnings?: readonly string[];
}

export interface SavedTripForNow {
  arrival_date: string | null;
  days: readonly SavedTripDay[];
  party?: { adults?: number; children?: readonly unknown[] } | null;
}

export interface TripNowDeps {
  safety: SafetyRefreshDeps;
  availability: (tourId: string, date: string, need: number) => Promise<TripDayAvailability>;
  forecast: (coords: readonly [number, number], date: string, today: string) => Promise<TripDayForecast | null>;
  now: () => Date;
}

export function defaultTripNowDeps(): TripNowDeps {
  const cache = createPlannerCache();
  return {
    safety: DEFAULT_SAFETY_DEPS,
    availability: (tourId, date, need) => readDayAvailability(tourId, date, need, cache, 'trips/now'),
    forecast: (coords, date, today) => readDayForecast(coords, date, today, 'trips/now'),
    now: () => new Date(),
  };
}

/** Сколько мест нужно туру: вся группа; не записана — один человек. */
export function groupSize(party: SavedTripForNow['party']): number {
  const adults = typeof party?.adults === 'number' && party.adults > 0 ? Math.floor(party.adults) : 0;
  const children = Array.isArray(party?.children) ? party.children.length : 0;
  return Math.max(1, adults + children);
}

/** Что появилось и что ушло: сравнение строк дня до и после перепроверки. */
export function safetyChanges(saved: readonly string[], fresh: readonly string[]): { added: string[]; gone: string[] } {
  return {
    added: fresh.filter((t) => !saved.includes(t)),
    gone: saved.filter((t) => !fresh.includes(t)),
  };
}

function isPair(c: SavedTripDay['coords']): c is readonly [number, number] {
  return Array.isArray(c) && c.length === 2 && c.every((x) => typeof x === 'number' && Number.isFinite(x));
}

/** Перепроверить сохранённый план сегодня. Ничего не пишет. */
export async function checkTripNow(trip: SavedTripForNow, deps: TripNowDeps = defaultTripNowDeps()): Promise<TripNow> {
  const arrival = trip.arrival_date;
  if (!arrival || dateOfTripDay(arrival, 1) === null || trip.days.length === 0) return { state: 'no_dates' };

  const now = deps.now();
  const today = kamchatkaToday(now);
  const dated = trip.days
    .map((d) => ({ d, date: dateOfTripDay(arrival, d.day) }))
    .filter((x): x is { d: SavedTripDay; date: string } => x.date !== null);
  const lastDay = dated.reduce((max, x) => (x.date > max ? x.date : max), '');
  if (lastDay < today) return { state: 'past', last_day: lastDay };
  const ahead = dated.filter((x) => x.date >= today);

  // Копии дней: правило планера меняет строки на месте, а сохранённый план
  // остаётся как был. Род дня у поездок до 07.11 не записан — считаем
  // занятием, как страница по ссылке.
  const copies = ahead.map(({ d }) => ({
    day: d.day,
    type: d.type ?? 'activity',
    zone: d.zone,
    title: d.title,
    dayWarnings: [...(d.dayWarnings ?? [])],
    ...(d.realTour?.tourId ? { realTour: { tourId: d.realTour.tourId } } : {}),
  }));
  const safety = await refreshDatedSafety(
    copies as unknown as DayPlan[], arrival, copies.map((c) => c.day), true, deps.safety,
  );

  const need = groupSize(trip.party);
  const horizonEnd = new Date(Date.parse(`${today}T00:00:00Z`) + FORECAST_HORIZON_DAYS * 86_400_000).toISOString().slice(0, 10);
  const days = await Promise.all(ahead.map(async ({ d, date }, i): Promise<TripNowDay> => {
    const { added, gone } = safetyChanges(d.dayWarnings ?? [], copies[i].dayWarnings);
    const isActivity = d.type === undefined || d.type === 'activity';
    const tourId = isActivity ? d.realTour?.tourId : undefined;
    const coords = isActivity && isPair(d.coords) ? d.coords : null;
    const askWeather = coords !== null && date < horizonEnd;
    const [availability, weather] = await Promise.all([
      tourId ? deps.availability(tourId, d.availableDate ?? date, need) : Promise.resolve(null),
      askWeather ? deps.forecast(coords, date, today) : Promise.resolve(null),
    ]);
    const weather_state: TripNowDay['weather_state'] = coords === null ? 'not_checked'
      : !askWeather ? 'later'
      : weather ? 'ok' : 'unavailable';
    const type = d.type ?? 'activity';
    const replaceable = MOVABLE_TYPES.has(type) && tourGroup(trip.days, d).length <= 1;
    const activity = type === 'activity' && typeof d.activityType === 'string' && d.activityType !== '' ? d.activityType : null;
    return { day: d.day, date, added, gone, availability, weather, weather_state, replaceable, activity };
  }));

  return {
    state: 'checked',
    checked_at: now.toISOString(),
    days,
    plan_warnings: safety.warnings,
    safety_changed: days.some((d) => d.added.length > 0 || d.gone.length > 0),
  };
}
