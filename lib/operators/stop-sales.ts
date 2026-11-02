/**
 * «Стоп-продажи» (план CRM в мессенджере, PR5; решение владельца 02.11:
 * только оператор). Тур → период (неделя / 2 недели / месяц от сегодня) →
 * предпросмотр «закроются N дат, даты с бронями остаются» → «Да». Снятие —
 * «Снять стоп» → «Да»: открываются только даты, закрытые стоп-продажей.
 *
 * Закрываются только открытые даты без записанных мест: бронь стоп-продажа
 * не трогает и дату с бронью не закрывает. Сайт и Кузьмич закрытую дату не
 * предлагают (is_cancelled в tour_availability). Каждое закрытие и снятие —
 * строка журнала tour_stop_sales (кто, когда, какие даты).
 *
 * Права: тур — только свой (operator_id), запись — только «Да» в личном
 * диалоге с ботом; «Да» подписано (signed-payload, `ss:[yv]:`).
 */

import { pool } from '@/lib/db-pool';
import { transaction } from '@/lib/database';
import { signPayload } from '@/lib/chat-cabinet/signed-payload';
import { occupiedOnDaySql } from '@/lib/bookings/occupancy';
import { kamchatkaDate, shiftDate } from '@/lib/analytics/kamchatka-day';
import { forgetLiveSeats } from '@/lib/operators/live-seats';
import { escapeHtml } from '@/lib/text/escape-html';

export const STOP_REASON = 'Стоп-продажа оператора';
export const STOP_PERIODS = [7, 14, 30] as const;
type Period = (typeof STOP_PERIODS)[number];
const PERIOD_WORDS: Readonly<Record<Period, string>> = { 7: 'Неделя', 14: '2 недели', 30: 'Месяц' };

type Btn = { text: string; payload: string };
export type StopReply = { text: string; rows: Btn[][] };

export type StopPress =
  | { step: 'list' }
  | { step: 'tour'; tourId: string }
  | { step: 'ask_close' | 'close'; tourId: string; days: Period }
  | { step: 'ask_open' | 'open'; tourId: string }
  | { step: 'no' };

const TOUR = '\\d{1,18}';

/** ss:l список · ss:t тур · ss:a/ss:y закрыть (вопрос/«Да») · ss:u/ss:v снять · ss:n «Нет». */
export function parseStopPress(payload: string): StopPress | null {
  if (payload === 'ss:l') return { step: 'list' };
  if (payload === 'ss:n') return { step: 'no' };
  let m = new RegExp(`^ss:t:(${TOUR})$`).exec(payload);
  if (m) return { step: 'tour', tourId: m[1]! };
  m = new RegExp(`^ss:([ay]):(${TOUR}):(\\d{1,2})$`).exec(payload);
  if (m) {
    const days = Number(m[3]) as Period;
    if (!STOP_PERIODS.includes(days)) return null;
    return { step: m[1] === 'a' ? 'ask_close' : 'close', tourId: m[2]!, days };
  }
  m = new RegExp(`^ss:([uv]):(${TOUR})$`).exec(payload);
  if (m) return { step: m[1] === 'u' ? 'ask_open' : 'open', tourId: m[2]! };
  return null;
}

export function isStopSalesPayload(payload: string): boolean {
  return payload.startsWith('ss:');
}

const fmt = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;
const back: Btn = { text: '‹ Стоп-продажи', payload: 'ss:l' };

function sqlstate(err: unknown): string {
  return (err as { code?: string } | null)?.code ?? 'нет SQLSTATE';
}

interface OwnTour { id: string; title: string }

async function ownTours(partnerId: string): Promise<OwnTour[]> {
  const { rows } = await pool.query<OwnTour>(
    `SELECT t.id::text AS id, t.title FROM operator_tours t
      WHERE t.operator_id = $1::uuid AND t.deleted_at IS NULL AND COALESCE(t.is_active, FALSE)
      ORDER BY t.title, t.id LIMIT 30`,
    [partnerId],
  );
  return rows;
}

async function ownTour(partnerId: string, tourId: string): Promise<OwnTour | null> {
  const { rows } = await pool.query<OwnTour>(
    `SELECT t.id::text AS id, t.title FROM operator_tours t
      WHERE t.id = $2::bigint AND t.operator_id = $1::uuid AND t.deleted_at IS NULL`,
    [partnerId, tourId],
  );
  return rows[0] ?? null;
}

/** Открытые даты тура в периоде: свободные (закроются) и с записанными местами (останутся). */
async function openDays(tourId: string, from: string, to: string): Promise<{ free: string[]; booked: string[] }> {
  const { rows } = await pool.query<{ d: string; taken: number | string }>(
    `SELECT ta.date::text AS d, GREATEST(COALESCE(ta.booked_slots, 0), occ.taken)::int AS taken
       FROM tour_availability ta
       CROSS JOIN LATERAL (
         ${occupiedOnDaySql({ booking: 'b', day: 'ta.date', tourId: '$1::bigint' })}
       ) occ
      WHERE ta.operator_tour_id = $1::bigint AND ta.deleted_at IS NULL
        AND ta.date BETWEEN $2::date AND $3::date
        AND NOT COALESCE(ta.is_cancelled, FALSE) AND COALESCE(ta.available_slots, 0) > 0
      ORDER BY ta.date`,
    [tourId, from, to],
  );
  const free: string[] = [];
  const booked: string[] = [];
  for (const r of rows) (Number(r.taken) > 0 ? booked : free).push(r.d.slice(0, 10));
  return { free, booked };
}

/** Даты тура, закрытые стоп-продажей, с сегодняшней. */
async function stoppedDays(tourId: string, today: string): Promise<string[]> {
  const { rows } = await pool.query<{ d: string }>(
    `SELECT ta.date::text AS d FROM tour_availability ta
      WHERE ta.operator_tour_id = $1::bigint AND ta.deleted_at IS NULL AND ta.date >= $2::date
        AND COALESCE(ta.is_cancelled, FALSE) AND ta.cancellation_reason = $3
      ORDER BY ta.date`,
    [tourId, today, STOP_REASON],
  );
  return rows.map((r) => r.d.slice(0, 10));
}

/** Сколько дат своих туров закрыто стоп-продажей с сегодняшней — для сводки. */
export async function activeStopDays(partnerId: string, today: string): Promise<number> {
  const { rows } = await pool.query<{ n: number | string }>(
    `SELECT count(*)::int AS n FROM tour_availability ta
       JOIN operator_tours t ON t.id = ta.operator_tour_id AND t.operator_id = $1::uuid AND t.deleted_at IS NULL
      WHERE ta.deleted_at IS NULL AND ta.date >= $2::date
        AND COALESCE(ta.is_cancelled, FALSE) AND ta.cancellation_reason = $3`,
    [partnerId, today, STOP_REASON],
  );
  return Number(rows[0]?.n ?? 0);
}

function confirmRow(payload: string): Btn[] {
  return [{ text: 'Да', payload: signPayload(payload) }, { text: 'Нет', payload: 'ss:n' }];
}

function listDates(dates: readonly string[], max = 10): string {
  const head = dates.slice(0, max).map(fmt).join(', ');
  return dates.length > max ? `${head} и ещё ${dates.length - max}` : head;
}

export async function stopSalesPress(opts: {
  partnerId: string; userId: string | null; payload: string; via: 'max' | 'telegram'; dialog: boolean; nowMs?: number;
}): Promise<StopReply | null> {
  const p = parseStopPress(opts.payload);
  if (p === null) return null;
  if (p.step === 'no') return { text: 'Хорошо, даты не трогал.', rows: [[back]] };
  if (!opts.dialog && (p.step === 'close' || p.step === 'open')) {
    return { text: 'Стоп-продажи меняются только в личном чате с ботом. Ничего не записал.', rows: [] };
  }
  const today = kamchatkaDate(new Date(opts.nowMs ?? Date.now()));
  try {
    if (p.step === 'list') {
      const tours = await ownTours(opts.partnerId);
      if (tours.length === 0) return { text: '<b>Стоп-продажи</b>\nДействующих туров нет — закрывать нечего.', rows: [] };
      return {
        text: '<b>Стоп-продажи</b>\nВыберите тур: закрыть продажу на период или снять стоп. Брони не отменяются, даты с бронями не закрываются.',
        rows: tours.map((t) => [{ text: t.title.slice(0, 40), payload: `ss:t:${t.id}` }]),
      };
    }
    const tour = await ownTour(opts.partnerId, p.tourId);
    if (!tour) return { text: 'Этого тура среди ваших нет. Ничего не записал.', rows: [[back]] };
    const title = escapeHtml(tour.title);

    if (p.step === 'tour') {
      const stopped = await stoppedDays(tour.id, today);
      const lines = [`<b>${title}</b> — стоп-продажи`];
      lines.push(stopped.length > 0 ? `Сейчас закрыто стоп-продажей: ${stopped.length} дат (${listDates(stopped)}).` : 'Стоп-продаж сейчас нет.');
      lines.push('Закрыть продажу с сегодняшнего дня на:');
      const rows: Btn[][] = [STOP_PERIODS.map((d) => ({ text: PERIOD_WORDS[d], payload: `ss:a:${tour.id}:${d}` }))];
      if (stopped.length > 0) rows.push([{ text: 'Снять стоп', payload: `ss:u:${tour.id}` }]);
      rows.push([back]);
      return { text: lines.join('\n'), rows };
    }

    if (p.step === 'ask_close' || p.step === 'close') {
      const to = shiftDate(today, p.days - 1);
      const { free, booked } = await openDays(tour.id, today, to);
      const kept = booked.length > 0 ? ` Даты с бронями остаются открытыми: ${listDates(booked)}.` : '';
      if (free.length === 0) {
        return { text: `«${title}», ${fmt(today)}–${fmt(to)}: открытых дат без броней нет — закрывать нечего.${kept}`, rows: [[back]] };
      }
      if (p.step === 'ask_close') {
        return {
          text: `Закрыть продажу «${title}» с ${fmt(today)} по ${fmt(to)}? Закроются ${free.length} дат: ${listDates(free)}.${kept}\nСайт и Кузьмич эти даты предлагать не будут. Брони не отменяются.`,
          rows: [confirmRow(`ss:y:${tour.id}:${p.days}`)],
        };
      }
      const closed = await transaction(async (c) => {
        const r = await c.query<{ d: string }>(
          `UPDATE tour_availability ta SET is_cancelled = TRUE, cancellation_reason = $3, updated_at = now()
             FROM operator_tours t
            WHERE t.id = ta.operator_tour_id AND t.id = $1::bigint AND t.operator_id = $4::uuid
              AND ta.date = ANY($2::date[]) AND ta.deleted_at IS NULL AND NOT COALESCE(ta.is_cancelled, FALSE)
            RETURNING ta.date::text AS d`,
          [tour.id, free, STOP_REASON, opts.partnerId],
        );
        const dates = r.rows.map((x) => x.d.slice(0, 10)).sort();
        if (dates.length > 0) {
          await c.query(
            `INSERT INTO tour_stop_sales (operator_id, tour_id, action, date_from, date_to, dates, kept_booked, created_by, via)
             VALUES ($1::uuid, $2::bigint, 'close', $3::date, $4::date, $5::date[], $6::date[], $7::uuid, $8)`,
            [opts.partnerId, tour.id, today, to, dates, booked, opts.userId, opts.via],
          );
        }
        return dates;
      });
      forgetLiveSeats(tour.id);
      if (closed.length === 0) return { text: `«${title}»: эти даты уже закрыты. Повторно не закрывал.`, rows: [[back]] };
      return {
        text: `Стоп-продажа «${title}»: закрыто ${closed.length} дат (${listDates(closed)}).${kept} Снять — «Снять стоп».`,
        rows: [[{ text: 'Снять стоп', payload: `ss:u:${tour.id}` }], [back]],
      };
    }

    // Снять стоп: только даты, закрытые стоп-продажей.
    const stopped = await stoppedDays(tour.id, today);
    if (stopped.length === 0) return { text: `«${title}»: стоп-продаж нет. Ничего не менял.`, rows: [[back]] };
    if (p.step === 'ask_open') {
      return {
        text: `Снять стоп-продажу «${title}»? Снова откроются ${stopped.length} дат: ${listDates(stopped)} — с прежним числом мест.`,
        rows: [confirmRow(`ss:v:${tour.id}`)],
      };
    }
    const opened = await transaction(async (c) => {
      const r = await c.query<{ d: string }>(
        `UPDATE tour_availability ta SET is_cancelled = FALSE, cancellation_reason = NULL, updated_at = now()
           FROM operator_tours t
          WHERE t.id = ta.operator_tour_id AND t.id = $1::bigint AND t.operator_id = $4::uuid
            AND ta.date >= $2::date AND ta.deleted_at IS NULL
            AND COALESCE(ta.is_cancelled, FALSE) AND ta.cancellation_reason = $3
          RETURNING ta.date::text AS d`,
        [tour.id, today, STOP_REASON, opts.partnerId],
      );
      const dates = r.rows.map((x) => x.d.slice(0, 10)).sort();
      if (dates.length > 0) {
        await c.query(
          `INSERT INTO tour_stop_sales (operator_id, tour_id, action, date_from, date_to, dates, created_by, via)
           VALUES ($1::uuid, $2::bigint, 'open', $3::date, $4::date, $5::date[], $6::uuid, $7)`,
          [opts.partnerId, tour.id, dates[0], dates[dates.length - 1], dates, opts.userId, opts.via],
        );
      }
      return dates;
    });
    forgetLiveSeats(tour.id);
    if (opened.length === 0) return { text: `«${title}»: стоп уже снят. Ничего не менял.`, rows: [[back]] };
    return { text: `Стоп-продажа «${title}» снята: снова открыто ${opened.length} дат (${listDates(opened)}).`, rows: [[back]] };
  } catch (err) {
    console.error('[stop-sales] отказ базы, SQLSTATE', sqlstate(err));
    return { text: 'База не ответила. Даты не менял.', rows: [[back]] };
  }
}
