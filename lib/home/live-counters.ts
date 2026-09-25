/**
 * lib/home/live-counters.ts
 *
 * Счётчики блока «живые на маршрутах» (components/homepage/LiveOnTrails).
 * Чистая функция: нет данных — нули, и вызывающий по нулям НЕ рисует блок
 * (аудит 24.09, #36/#40 — вместо слов-заглушек «Исследователь / Ваш стиль»).
 * Нечисловое и отрицательное — не число людей, считается нулём.
 */

export interface LiveCountersInput {
  bookings_today?: number | null;
  active_routes?: ReadonlyArray<{ tourists_hour?: number | null }> | null;
}

export interface LiveCounters {
  touristsOnTrail: number;
  bookingsToday: number;
}

const safe = (n: unknown): number => {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
};

export function liveCounters(data: LiveCountersInput | null | undefined): LiveCounters {
  if (!data) return { touristsOnTrail: 0, bookingsToday: 0 };
  const touristsOnTrail = (data.active_routes ?? []).reduce((s, r) => s + safe(r.tourists_hour), 0);
  return { touristsOnTrail, bookingsToday: safe(data.bookings_today) };
}
