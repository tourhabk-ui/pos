/**
 * lib/home/trip-mode.ts
 *
 * Состояние главной: «планирую» или «я в поездке».
 *
 * Переключается ЯВНОЙ кнопкой, а не датами (решение владельца 29.07.2026).
 * Причина простая: даты сдвигаются. Поездка переносится из-за погоды,
 * начинается на день раньше, отменяется совсем — а автопереключение по
 * `arrival_date <= сегодня <= departure_date` уверенно показало бы человеку
 * режим маршрута, на который он не вышел, или спрятало бы его у того, кто
 * вышел раньше. На слое безопасности догадка хуже вопроса.
 *
 * Даты при этом не выбрасываются: они дают «День N из M» — но только внутри
 * уже включённого режима, как справка, а не как выключатель.
 *
 * Чистые функции без сети и БД: источник (колонка `users.active_trip_id` или
 * localStorage для гостя) подставляется снаружи.
 */

export interface TripDates {
  /** ISO-дата (YYYY-MM-DD) или null, если поездка сохранена без дат. */
  arrivalDate: string | null;
  departureDate: string | null;
}

export interface TripProgress {
  /** Номер текущего дня, начиная с 1. null — посчитать нечестно. */
  day: number | null;
  /** Всего дней в поездке. null — посчитать нечестно. */
  total: number | null;
  /** Сегодня раньше приезда / позже отъезда — режим включён, но поездка не идёт. */
  phase: 'before' | 'during' | 'after' | 'unknown';
}

/** Полночь по UTC: сравниваем календарные даты, а не моменты времени. */
function toDayNumber(iso: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}/.test(iso)) return null;
  const ms = Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(ms)) return null;
  return Math.floor(ms / 86_400_000);
}

/**
 * «День N из M» по датам поездки.
 *
 * Считает календарные дни включительно: поездка 6–9 августа — это четыре дня,
 * а не три. Турист считает ночёвки иначе, чем вычитание дат.
 *
 * Без дат или с испорченными датами возвращает null вместо выдуманного «День
 * 1 из 1»: пустое место честнее неверного числа.
 */
export function tripProgress(dates: TripDates, today: string): TripProgress {
  const a = dates.arrivalDate ? toDayNumber(dates.arrivalDate) : null;
  const d = dates.departureDate ? toDayNumber(dates.departureDate) : null;
  const t = toDayNumber(today);

  if (a === null || d === null || t === null || d < a) {
    return { day: null, total: null, phase: 'unknown' };
  }

  const total = d - a + 1;
  if (t < a) return { day: null, total, phase: 'before' };
  if (t > d) return { day: null, total, phase: 'after' };
  return { day: t - a + 1, total, phase: 'during' };
}

export interface TripCandidate extends TripDates {
  id: string;
  title: string;
  /** Когда поездку сохранили — тай-брейк при равных датах. */
  createdAt: string | null;
}

/**
 * Какую поездку показать, если активной не назначено ни одной.
 *
 * Нужна для подсказки «включить режим?», а не для автопереключения. Выбор
 * детерминированный, иначе на двух устройствах человек увидит разные поездки:
 * сначала та, что идёт сегодня; потом ближайшая будущая; потом самая свежая
 * по дате сохранения; при полном равенстве — по id.
 */
export function pickCandidateTrip(trips: TripCandidate[], today: string): TripCandidate | null {
  if (trips.length === 0) return null;

  const rank = (t: TripCandidate): number => {
    const p = tripProgress(t, today).phase;
    if (p === 'during') return 0;
    if (p === 'before') return 1;
    return 2;
  };

  const sorted = [...trips].sort((x, y) => {
    const r = rank(x) - rank(y);
    if (r !== 0) return r;
    const ax = x.arrivalDate ?? '';
    const ay = y.arrivalDate ?? '';
    if (ax !== ay) return ax < ay ? -1 : 1;
    const cx = x.createdAt ?? '';
    const cy = y.createdAt ?? '';
    if (cx !== cy) return cx > cy ? -1 : 1;
    return x.id < y.id ? -1 : 1;
  });

  return sorted[0] ?? null;
}

/** Ключ localStorage для гостя без аккаунта. Серверный источник — users.active_trip_id. */
export const GUEST_TRIP_MODE_KEY = 'vedar_active_trip';
