/**
 * Живые места из базы для чата оператора (план CRM в мессенджерах, PR2).
 * Один читатель для карточки заявки, «Сегодня» и предчерновика ответа.
 * Кэш — не дольше 30 секунд и только удачных чтений: отказ базы не
 * запоминается и не выдаётся за «мест нет».
 */

import { pool } from '@/lib/db-pool';
import { freeSlotsSql, occupiedOnDaySql } from '@/lib/bookings/occupancy';

export const LIVE_SEATS_TTL_MS = 30_000;

/** number — свободно; null — даты в календаре нет; 'failed' — не прочиталось. */
export type LiveSeats = number | null | 'failed';

const cache = new Map<string, { at: number; value: number | null }>();

export function forgetLiveSeats(tourId?: number | string): void {
  if (tourId === undefined) { cache.clear(); return; }
  for (const k of cache.keys()) if (k.startsWith(`${tourId}|`)) cache.delete(k);
}

export async function liveFreeSeats(tourId: number | string, date: string, nowMs = Date.now()): Promise<LiveSeats> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const key = `${tourId}|${date}`;
  const hit = cache.get(key);
  if (hit && nowMs - hit.at < LIVE_SEATS_TTL_MS && nowMs >= hit.at) return hit.value;
  try {
    const { rows } = await pool.query<{ free: number | string | null }>(
      `SELECT MAX(${freeSlotsSql('ta', 'ot', 'occ.taken')})::int AS free
         FROM tour_availability ta
         JOIN operator_tours ot ON ot.id = ta.operator_tour_id
         CROSS JOIN LATERAL (${occupiedOnDaySql({ booking: 'ob', day: 'ta.date', tourId: 'ta.operator_tour_id' })}) occ
        WHERE ta.operator_tour_id = $1 AND ta.date = $2::date
          AND COALESCE(ta.is_cancelled, false) = false AND ta.deleted_at IS NULL`,
      [tourId, date],
    );
    const v = rows[0]?.free;
    const value = v == null ? null : Number(v);
    cache.set(key, { at: nowMs, value });
    return value;
  } catch (err) {
    console.error('[live-seats] места не прочитаны, SQLSTATE', (err as { code?: string }).code ?? 'нет SQLSTATE');
    return 'failed';
  }
}

/**
 * Места на дату предмета «Входящих» — только своего: тур ищется по
 * оператору. null — у предмета нет тура и даты (заявка подбора).
 */
export async function liveSeatsForItem(
  partnerId: string, kind: string, id: string, nowMs = Date.now(),
): Promise<{ date: string; free: LiveSeats } | null | 'failed'> {
  const sql = kind === 'operator_booking'
    ? `SELECT t.id::text AS tour_id, b.booking_date::text AS d FROM operator_bookings b
         JOIN operator_tours t ON t.id = b.operator_tour_id
        WHERE b.id::text = $2 AND t.operator_id = $1::uuid AND b.deleted_at IS NULL`
    : kind === 'seat_request'
      ? `SELECT r.tour_id::text AS tour_id, r.tour_date::text AS d FROM tour_seat_requests r
          WHERE r.id::text = $2 AND r.operator_id = $1::uuid`
      : null;
  if (!sql) return null;
  try {
    const { rows } = await pool.query<{ tour_id: string; d: string | null }>(sql, [partnerId, id]);
    const r = rows[0];
    if (!r?.d) return null;
    const date = r.d.slice(0, 10);
    return { date, free: await liveFreeSeats(r.tour_id, date, nowMs) };
  } catch (err) {
    console.error('[live-seats] тур предмета не прочитан, SQLSTATE', (err as { code?: string }).code ?? 'нет SQLSTATE');
    return 'failed';
  }
}

export interface Departure { date: string; tourId: number; title: string; people: number; bookings: number }

/** Выезды сегодня и завтра по подтверждённым броням — числа, без имён. */
export async function loadDepartures(partnerId: string, days: readonly string[]): Promise<Departure[] | 'failed'> {
  try {
    const { rows } = await pool.query<{ d: string; tour_id: number | string; title: string; people: number | string; n: number | string }>(
      `SELECT b.booking_date::text AS d, t.id AS tour_id, t.title, COALESCE(SUM(b.participants), 0)::int AS people, COUNT(*)::int AS n
         FROM operator_bookings b JOIN operator_tours t ON t.id = b.operator_tour_id
        WHERE t.operator_id = $1::uuid AND b.deleted_at IS NULL
          AND b.booking_status IN ('confirmed', 'pending_payment')
          AND b.booking_date = ANY($2::date[])
        GROUP BY b.booking_date, t.id, t.title ORDER BY b.booking_date, t.title`,
      [partnerId, [...days]],
    );
    return rows.map((r) => ({ date: r.d.slice(0, 10), tourId: Number(r.tour_id), title: r.title, people: Number(r.people), bookings: Number(r.n) }));
  } catch (err) {
    console.error('[live-seats] выезды не прочитаны, SQLSTATE', (err as { code?: string }).code ?? 'нет SQLSTATE');
    return 'failed';
  }
}

/**
 * «Другая дата» (план PR3): ближайшие открытые даты тура брони с живыми
 * свободными местами — только из БД, только своего тура. Пусто — так и
 * говорим, дату не выдумываем. Кэш не нужен: читается по нажатию.
 */
export async function nextOpenDates(
  partnerId: string, bookingId: string, limit = 5,
): Promise<Array<{ date: string; free: number }> | null | 'failed'> {
  try {
    const { rows } = await pool.query<{ d: string; free: number | string | null }>(
      `SELECT ta.date::text AS d, MAX(${freeSlotsSql('ta', 'ot', 'occ.taken')})::int AS free
         FROM operator_bookings b
         JOIN operator_tours ot ON ot.id = b.operator_tour_id AND ot.operator_id = $1::uuid
         JOIN tour_availability ta ON ta.operator_tour_id = ot.id
         CROSS JOIN LATERAL (${occupiedOnDaySql({ booking: 'ob', day: 'ta.date', tourId: 'ta.operator_tour_id' })}) occ
        WHERE b.id::text = $2 AND b.deleted_at IS NULL
          AND ta.date >= CURRENT_DATE AND ta.date <> b.booking_date
          AND COALESCE(ta.is_cancelled, false) = false AND ta.deleted_at IS NULL
        GROUP BY ta.date
       HAVING MAX(${freeSlotsSql('ta', 'ot', 'occ.taken')}) > 0
        ORDER BY ta.date LIMIT $3`,
      [partnerId, bookingId, limit],
    );
    return rows.map((r) => ({ date: r.d.slice(0, 10), free: Number(r.free) }));
  } catch (err) {
    console.error('[live-seats] другие даты не прочитаны, SQLSTATE', (err as { code?: string }).code ?? 'нет SQLSTATE');
    return 'failed';
  }
}

export function openDatesLine(dates: Array<{ date: string; free: number }> | null | 'failed'): string {
  if (dates === 'failed') return 'Открытые даты сейчас не прочитались — посмотрите календарь на сайте.';
  if (!dates || dates.length === 0) return 'Других открытых дат с местами в календаре нет.';
  const fmt = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;
  return `Открыто в календаре: ${dates.map((x) => `${fmt(x.date)} (свободно ${x.free})`).join('; ')}.`;
}
