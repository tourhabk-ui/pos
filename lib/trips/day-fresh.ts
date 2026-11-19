/**
 * lib/trips/day-fresh.ts — места тура и прогноз на дату дня сохранённого плана,
 * прочитанные сейчас. Только сервер.
 *
 * Правило одно на две двери:
 *  - страница плана по ссылке (`/api/trips/share/[token]`) — откуда оно вынесено
 *    19.11 без изменения поведения;
 *  - перепроверка поездки в личном кабинете (`/api/trips/[id]/now`, #3394,
 *    слово владельца 19.11 «начни с обновления плана ближе к датам»).
 *
 * Места — пять исходов (`TripDayAvailability`, lib/trips/day-availability):
 * есть; не хватает на всю группу; нет при расписании (и ближайшая свободная
 * дата в 60 сутках); расписания нет — дату подтвердит оператор; не прочиталось.
 * Прогноз — только в горизонте Open-Meteo (16 суток) и только полный день:
 * ноль вместо пропуска рисовал бы штиль там, где данных нет (§4.0).
 */
import { tourKeepsSchedule } from '@/lib/seat-requests/service';
import { fetchAvailabilityForTour, fetchForecastDays, type PlannerCache } from '@/lib/planner';
import type { TripDayAvailability } from './day-availability';
import type { TripDayForecast } from './trip-now-types';

/** Окно поиска ближайшей свободной даты тура без мест на дату дня. */
export const NEXT_FREE_WINDOW_DAYS = 60;
/** Горизонт прогноза Open-Meteo, суток. */
export const FORECAST_HORIZON_DAYS = 16;

export type { TripDayForecast } from './trip-now-types';

function addDaysIso(dateIso: string, days: number): string {
  return new Date(Date.parse(`${dateIso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function sqlstate(err: unknown): string {
  return (err as { code?: string } | null)?.code ?? 'нет SQLSTATE';
}

/**
 * Места тура на дату дня для группы из `need` человек. Сбой чтения — `unread`
 * и строка в лог, а не «мест нет» и не «места есть».
 */
export async function readDayAvailability(
  tourId: string,
  date: string,
  need: number,
  cache: PlannerCache,
  scope = 'trips/day-fresh',
): Promise<TripDayAvailability> {
  try {
    const slots = await fetchAvailabilityForTour(tourId, date, date, cache);
    // Время чтения — страница называет его у ответа (принцип 2, 07.11).
    const checkedAt = new Date().toISOString();
    const remaining = slots[0]?.remaining ?? 0;
    if (remaining >= need) return { date, remaining, state: 'open', checkedAt };
    const nextForGroup = async () => (await fetchAvailabilityForTour(
      tourId, addDaysIso(date, 1), addDaysIso(date, NEXT_FREE_WINDOW_DAYS), cache,
    )).find((s) => s.remaining >= need)?.date;
    if (remaining > 0) {
      const next = await nextForGroup();
      return { date, remaining, state: 'short', ...(next ? { next } : {}), checkedAt };
    }
    const keeps = await tourKeepsSchedule(Number(tourId));
    if (keeps === false) return { date, remaining: 0, state: 'on_request' };
    if (keeps === null) return { date, remaining: 0, state: 'unread' };
    const next = await nextForGroup();
    return { date, remaining: 0, state: 'none', ...(next ? { next } : {}), checkedAt };
  } catch (err) {
    console.error(`[${scope}] занятость тура на дату дня не прочиталась, SQLSTATE`, sqlstate(err));
    return { date, remaining: 0, state: 'unread' };
  }
}

/**
 * Прогноз на дату дня по координатам. `null` — дата вне горизонта, прогноз не
 * пришёл или день в нём неполный; сбой — ещё и строка в лог.
 */
export async function readDayForecast(
  coords: readonly [number, number],
  date: string,
  today: string,
  scope = 'trips/day-fresh',
): Promise<TripDayForecast | null> {
  const dateMs = Date.parse(`${date}T00:00:00Z`);
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(dateMs) || !Number.isFinite(todayMs)) return null;
  if (dateMs < todayMs || dateMs >= todayMs + FORECAST_HORIZON_DAYS * 86_400_000) return null;
  try {
    const daysAhead = Math.ceil((dateMs - todayMs) / 86_400_000) + 1;
    const forecast = await fetchForecastDays(coords[0], coords[1], Math.min(FORECAST_HORIZON_DAYS, daysAhead));
    if (!forecast.ok) return null;
    const f = forecast.days.find((x) => x.date === date);
    // Неполный день не показывается: ноль вместо пропуска рисовал туристу
    // штиль и «0 °C» там, где данных не было (§4.0).
    if (!f || f.tempMin === null || f.tempMax === null || f.windKmh === null
      || f.precipMm === null || f.description === null) return null;
    return {
      date,
      tempMin: Math.round(f.tempMin),
      tempMax: Math.round(f.tempMax),
      windKmh: Math.round(f.windKmh),
      precipMm: Math.round(f.precipMm),
      description: f.description,
      bad: f.windKmh >= 40 || f.precipMm >= 10,
    };
  } catch (err) {
    console.error(`[${scope}] прогноз на дату дня не получен:`, err instanceof Error ? err.message.slice(0, 200) : 'неизвестная ошибка');
    return null;
  }
}
