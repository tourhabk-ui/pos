/**
 * Что карточка каталога говорит о датах тура — три исхода, не два (§4.0).
 *
 * До аудита П5 (#46/#51) сервер считал `has_availability`, а карточка его
 * отбрасывала: у туров без единой открытой даты и у тура, чей сезон кончился
 * в августе, стояли та же зелёная «● Сезон» и та же «Забронировать», что у
 * живых. Турист нажимал и попадал в «Оператор пока не открыл даты».
 *
 * Исходы:
 *   - `dates`       — есть хотя бы одна открытая дата со свободными местами;
 *   - `season_over` — дат нет, и сезон тура (с учётом его длительности)
 *                     уже не вмещает поездку;
 *   - `on_request`  — дат нет, но сезон не кончился, ЛИБО мы не знаем
 *                     (поле не пришло, сезон не записан). Незнание не
 *                     выдаётся за «есть даты».
 *
 * «Сезон 2027» и прочие обещания будущего здесь не сочиняются: дат следующего
 * сезона в данных нет.
 */

import { tourDurationDays } from '@/lib/bookings/duration';

export type CatalogAvailability = 'dates' | 'on_request' | 'season_over';

export interface AvailabilityInput {
  has_availability?: boolean | null;
  season_start: string | null;
  season_end: string | null;
  duration_type: string | null;
  multi_day_count: number | null;
  duration_hours: number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Сколько календарных дней занимает тур; неизвестно — 1 (минимум поездки).
 *
 * Правило одно — брони (`tourDurationDays`, lib/bookings/duration). До 17.11
 * здесь жило своё: `multi_day_count` считался только при типе «многодневный».
 * Тур с типом «day» и пятью днями каталог, окно сезона заявки и планер
 * считали однодневным, а бронь — пятидневным: окно пускало выезд за четыре
 * дня до конца сезона, поездку бронь вела за его край (ревью #3484).
 * `duration_type` принимается ради прежних вызовов и на длину не влияет.
 * Числа из базы могут прийти строкой (NUMERIC) — приводятся здесь.
 */
export function tourDays(t: Pick<AvailabilityInput, 'duration_type' | 'multi_day_count' | 'duration_hours'>): number {
  return tourDurationDays({
    multi_day_count: finiteOrNull(t.multi_day_count),
    duration_hours: finiteOrNull(t.duration_hours),
  });
}

function finiteOrNull(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Конец дня `season_end` по UTC — дата сезона записана днём, а не моментом. */
function seasonEndMs(seasonEnd: string): number | null {
  const d = new Date(seasonEnd);
  const ms = d.getTime();
  if (!Number.isFinite(ms)) return null;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) + DAY_MS - 1;
}

export function catalogAvailability(t: AvailabilityInput, now: Date = new Date()): CatalogAvailability {
  if (t.has_availability === true) return 'dates';
  if (t.season_end) {
    const end = seasonEndMs(t.season_end);
    // Поездка, начатая завтра, должна успеть закончиться в сезоне.
    if (end != null && now.getTime() + tourDays(t) * DAY_MS > end) return 'season_over';
  }
  return 'on_request';
}

export const AVAILABILITY_LABEL: Record<CatalogAvailability, string> = {
  dates: 'Есть даты',
  on_request: 'Даты по запросу',
  season_over: 'Сезон завершён, даты по запросу',
};

/** Идёт ли сезон сейчас. «● Сезон» карточка ставит только вместе с датами. */
export function isInSeason(t: Pick<AvailabilityInput, 'season_start' | 'season_end'>, now: Date = new Date()): boolean {
  if (!t.season_start || !t.season_end) return false;
  const start = new Date(t.season_start).getTime();
  const end = seasonEndMs(t.season_end);
  if (!Number.isFinite(start) || end == null) return false;
  return now.getTime() >= start && now.getTime() <= end;
}
