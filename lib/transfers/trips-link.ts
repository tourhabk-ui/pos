/**
 * lib/transfers/trips-link.ts — ссылка на поездки перевозчиков с датами,
 * местами и нужной поездкой, и её разбор страницей /transfers (#2304, шаг 3).
 * Чистый модуль.
 *
 * До 09.10 строки трансфера в плане не были ссылками вовсе, а общая «Запросить
 * место» открывала витрину на ближайшие две недели с одним местом: поездку из
 * плана человек искал заново.
 */

export interface TripsPrefill {
  from: string;
  to: string;
  seats: number;
  /** Поездка, ради которой пришли: её карточка выделена и прокручена. */
  tripId?: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Потолок окна — тот же, что у /api/carrier-trips. */
const MAX_WINDOW_DAYS = 60;

export function tripsLink(p: TripsPrefill): string {
  const q = new URLSearchParams({ from: p.from, to: p.to, seats: String(p.seats) });
  if (p.tripId) q.set('trip', p.tripId);
  return `/transfers?${q.toString()}`;
}

type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';

/** null — параметров нет или они негодны: витрина открывается как раньше. */
export function parseTripsPrefill(sp: Params): TripsPrefill | null {
  const from = one(sp.from);
  const to = one(sp.to);
  if (!DATE.test(from) || !DATE.test(to) || to < from) return null;
  const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  if (Number.isNaN(span) || span > MAX_WINDOW_DAYS) return null;
  const seatsRaw = one(sp.seats);
  const seats = /^\d{1,2}$/.test(seatsRaw) && Number(seatsRaw) >= 1 && Number(seatsRaw) <= 60 ? Number(seatsRaw) : 1;
  const trip = one(sp.trip);
  return { from, to, seats, ...(UUID.test(trip) ? { tripId: trip } : {}) };
}
