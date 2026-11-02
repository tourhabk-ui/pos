/**
 * «Стоп-продажи» (план CRM в мессенджере, PR5; решение владельца 02.11 —
 * только оператор): закрыть тур для продажи на период одной кнопкой.
 *
 * Тур → период (неделя / 2 недели / месяц от сегодня) → предпросмотр
 * «закроются N дат, даты с бронями остаются» → «Да». Снять — той же кнопкой
 * тура, тоже через «Да»: открываются только даты, закрытые стоп-продажей.
 *
 * Закрываются только открытые даты без броней: бронь на закрытой дате
 * осталась бы без продажи, но с туристом — такие даты называются и не
 * трогаются. Закрытие — `tour_availability.is_cancelled`: сайт и Кузьмич
 * закрытую дату не предлагают (core.ts, open-dates, nearest-free-date).
 * Каждое закрытие и снятие — строка `tour_stop_sales` (1370): кто, когда, что.
 *
 * Права: тур — только этой карточки (operator_id в каждом запросе); записи —
 * подписанными кнопками и только в личном диалоге.
 */

import { pool } from '@/lib/db-pool';
import { signPayload } from '@/lib/chat-cabinet/signed-payload';
import { occupiedOnDaySql } from '@/lib/bookings/occupancy';
import { kamchatkaDate, shiftDate } from '@/lib/analytics/kamchatka-day';
import { escapeHtml } from '@/lib/text/escape-html';

export const STOP_REASON = 'Стоп-продажа оператора';
export const STOP_PERIODS = [7, 14, 30] as const;
type Period = (typeof STOP_PERIODS)[number];
const PERIOD_WORD: Readonly<Record<Period, string>> = { 7: 'Неделя', 14: '2 недели', 30: 'Месяц' };

type Btn = { text: string; payload: string };
export type StopReply = { text: string; rows: Btn[][] };

export type StopPress =
  | { step: 'list' }
  | { step: 'no' }
  | { step: 'tour'; tourId: string }
  | { step: 'ask_close' | 'close'; tourId: string; days: Period }
  | { step: 'ask_open' | 'open'; tourId: string };

/**
 * ss:l список · ss:t:<тур> тур · ss:a:<тур>:<дн> вопрос · ss:y:<тур>:<дн> закрыть ·
 * ss:u:<тур> вопрос о снятии · ss:v:<тур> снять · ss:n «Нет».
 */
export function parseStopPress(payload: string): StopPress | null {
  if (payload === 'ss:l') return { step: 'list' };
  if (payload === 'ss:n') return { step: 'no' };
  let m = /^ss:t:(\d{1,18})$/.exec(payload);
  if (m) return { step: 'tour', tourId: m[1]! };
  m = /^ss:([ay]):(\d{1,18}):(\d{1,2})$/.exec(payload);
  if (m) {
    const days = Number(m[3]) as Period;
    if (!STOP_PERIODS.includes(days)) return null;
    return { step: m[1] === 'a' ? 'ask_close' : 'close', tourId: m[2]!, days };
  }
  m = /^ss:([uv]):(\d{1,18})$/.exec(payload);
  if (m) return { step: m[1] === 'u' ? 'ask_open' : 'open', tourId: m[2]! };
  return null;
}

export const stopPayload = {
  list: (): string => 'ss:l',
  tour: (id: string): string => `ss:t:${id}`,
};

const fmt = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;
const listDates = (ds: readonly string[]) => (ds.length <= 8 ? ds.map(fmt).join(', ') : `${ds.slice(0, 8).map(fmt).join(', ')} и ещё ${ds.length - 8}`);

function sqlstate(err: unknown): string {
  return (err as { code?: string } | null)?.code ?? 'нет SQLSTATE';
}

interface OwnTour { id: string; title: string }

async function ownTour(partnerId: string, tourId: string): Promise<OwnTour | null> {
  const { rows } = await pool.query<OwnTour>(
    `SELECT t.id::text AS id, t.title FROM operator_tours t
      WHERE t.id = $2::bigint AND t.operator_id = $1::uuid AND t.deleted_at IS NULL`,
    [partnerId, tourId],
  );
  return rows[0] ?? null;
}

/** Открытые даты тура в периоде: свободные (закроются) и с бронями (остаются). */
async function openDays(tourId: string, from: string, to: string): Promise<{ free: string[]; booked: string[] }> {
  const { rows } = await pool.query<{ d: string; taken: number | string }>(
    `SELECT ta.date::text AS d, GREATEST(COALESCE(ta.booked_slots, 0), occ.taken)::int AS taken
       FROM tour_availability ta
       CROSS JOIN LATERAL (
         ${occupiedOnDaySql({ booking: 'b', day: 'ta.date', tourId: '$1::bigint' })}
       ) occ
      WHERE ta.operator_tour_id = $1::bigint AND ta.deleted_at IS NULL
        AND ta.date BETWEEN $2::date AND $3::date
        AND COALESCE(ta.is_cancelled, FALSE) = FALSE
        AND COALESCE(ta.available_slots, 0) > 0
      ORDER BY ta.date`,
    [tourId, from, to],
  );
  const free: string[] = [];
  const booked: string[] = [];
  for (const r of rows) (Number(r.taken) > 0 ? booked : free).push(r.d.slice(0, 10));
  return { free, booked };
}

/** Даты тура от сегодня, закрытые стоп-продажей. */
async function stoppedDays(tourId: string, today: string): Promise<string[]> {
  const { rows } = await pool.query<{ d: string }>(
    `SELECT ta.date::text AS d FROM tour_availability ta
      WHERE ta.operator_tour_id = $1::bigint AND ta.deleted_at IS NULL AND ta.date >= $2::date
        AND ta.is_cancelled = TRUE AND ta.cancellation_reason = $3
      ORDER BY ta.date`,
    [tourId, today, STOP_REASON],
  );
  return rows.map((r) => r.d.slice(0, 10));
}

/** Сколько дат под стоп-продажей у карточки от сегодня — для сводки. null — не прочиталось. */
export async function countStoppedDates(partnerId: string, today: string): Promise<number | null> {
  try {
    const { rows } = await pool.query<{ n: number | string }>(
      `SELECT count(*)::int AS n FROM tour_availability ta
         JOIN operator_tours t ON t.id = ta.operator_tour_id AND t.operator_id = $1::uuid AND t.deleted_at IS NULL
        WHERE ta.deleted_at IS NULL AND ta.date >= $2::date
          AND ta.is_cancelled = TRUE AND ta.cancellation_reason = $3`,
      [partnerId, today, STOP_REASON],
    );
    return Number(rows[0]?.n ?? 0);
  } catch (err) {
    console.error(`[stop-sales] счёт стоп-продаж не прочитан, SQLSTATE ${sqlstate(err)}`);
    return null;
  }
}

function confirmRow(payload: string): Btn[][] {
  return [[{ text: 'Да', payload: signPayload(payload) }, { text: 'Нет', payload: 'ss:n' }]];
}

const back = (tourId?: string): Btn[] => (tourId
  ? [{ text: '‹ Тур', payload: stopPayload.tour(tourId) }, { text: '‹ Все туры', payload: stopPayload.list() }]
  : [{ text: '‹ Все туры', payload: stopPayload.list() }]);

export async function stopSalesPress(opts: {
  partnerId: string;
  userId: string | null;
  payload: string;
  via: 'max' | 'telegram';
  /** Личный диалог с ботом: записи только в нём. */
  dialog: boolean;
  nowMs?: number;
}): Promise<StopReply | null> {
  const p = parseStopPress(opts.payload);
  if (p === null) return null;
  if (p.step === 'no') return { text: 'Хорошо, даты не трогал.', rows: [back()] };
  if (!opts.dialog && (p.step === 'close' || p.step === 'open')) {
    return { text: 'Стоп-продажи меняются только в личном чате с ботом. Ничего не записал.', rows: [] };
  }
  const today = kamchatkaDate(new Date(opts.nowMs ?? Date.now()));
  try {
    if (p.step === 'list') {
      const { rows } = await pool.query<OwnTour & { stopped: number | string }>(
        `SELECT t.id::text AS id, t.title,
                (SELECT count(*) FROM tour_availability ta
                  WHERE ta.operator_tour_id = t.id AND ta.deleted_at IS NULL AND ta.date >= $2::date
                    AND ta.is_cancelled = TRUE AND ta.cancellation_reason = $3)::int AS stopped
           FROM operator_tours t
          WHERE t.operator_id = $1::uuid AND t.deleted_at IS NULL AND COALESCE(t.is_active, FALSE)
          ORDER BY t.title, t.id LIMIT 20`,
        [opts.partnerId, today, STOP_REASON],
      );
      if (rows.length === 0) return { text: '<b>Стоп-продажи</b>\nДействующих туров нет — закрывать нечего.', rows: [] };
      const lines = ['<b>Стоп-продажи</b>', 'Выберите тур: закрыть продажу на неделю, 2 недели или месяц — или снять стоп.'];
      for (const r of rows) if (Number(r.stopped) > 0) lines.push(`• ${escapeHtml(r.title)} — стоп на ${r.stopped} дат`);
      return {
        text: lines.join('\n'),
        rows: rows.map((r) => [{ text: `${Number(r.stopped) > 0 ? '⛔ ' : ''}${r.title}`.slice(0, 40), payload: stopPayload.tour(r.id) }]),
      };
    }
    const tour = await ownTour(opts.partnerId, p.tourId);
    if (!tour) return { text: 'Этого тура среди ваших нет. Ничего не записал.', rows: [back()] };
    const title = escapeHtml(tour.title);

    if (p.step === 'tour') {
      const stopped = await stoppedDays(tour.id, today);
      const lines = [`<b>${title}</b> — стоп-продажи`];
      lines.push(stopped.length > 0 ? `Сейчас закрыто стоп-продажей: ${listDates(stopped)}.` : 'Стоп-продажи сейчас нет.');
      lines.push('Закрыть продажу от сегодня — на сколько? Спрошу «Да» и покажу, какие даты закроются.');
      const rows: Btn[][] = [STOP_PERIODS.map((d) => ({ text: PERIOD_WORD[d], payload: `ss:a:${tour.id}:${d}` }))];
      if (stopped.length > 0) rows.push([{ text: 'Снять стоп', payload: `ss:u:${tour.id}` }]);
      rows.push(back());
      return { text: lines.join('\n'), rows };
    }

    if (p.step === 'ask_close' || p.step === 'close') {
      const to = shiftDate(today, p.days - 1);
      const period = `с ${fmt(today)} по ${fmt(to)}`;
      const { free, booked } = await openDays(tour.id, today, to);
      const keptLine = booked.length > 0 ? `Даты с бронями остаются открытыми: ${listDates(booked)}.` : null;
      if (free.length === 0) {
        return {
          text: [`<b>${title}</b>: ${period} закрывать нечего — открытых дат без броней нет.${p.step === 'close' ? ' Ничего не менял.' : ''}`, keptLine]
            .filter(Boolean).join('\n'),
          rows: [back(tour.id)],
        };
      }
      if (p.step === 'ask_close') {
        return {
          text: [
            `Закрыть продажу «${title}» ${period}?`,
            `Закроются ${free.length} дат: ${listDates(free)}.`,
            keptLine,
            'Сайт и Кузьмич эти даты предлагать перестанут. Брони не отменяются. Снять — кнопкой «Снять стоп».',
          ].filter(Boolean).join('\n'),
          rows: [...confirmRow(`ss:y:${tour.id}:${p.days}`), back(tour.id)],
        };
      }
      const closed = await writeStop({
        partnerId: opts.partnerId, tourId: tour.id, from: today, to, dates: free, keptBooked: booked,
        userId: opts.userId, via: opts.via, action: 'close',
      });
      if (closed.length === 0) return { text: 'Эти даты уже закрыты. Ничего не менял.', rows: [back(tour.id)] };
      return {
        text: [`Стоп-продажа: «${title}» закрыт ${period} — ${closed.length} дат: ${listDates(closed)}.`, keptLine, 'Брони не отменены.']
          .filter(Boolean).join('\n'),
        rows: [[{ text: 'Снять стоп', payload: `ss:u:${tour.id}` }], back()],
      };
    }

    // Снять стоп: только даты, закрытые стоп-продажей, от сегодня.
    const stopped = await stoppedDays(tour.id, today);
    if (stopped.length === 0) return { text: `У «${title}» стоп-продажи нет. Ничего не менял.`, rows: [back(tour.id)] };
    if (p.step === 'ask_open') {
      return {
        text: `Снять стоп-продажу «${title}»? Снова откроются ${stopped.length} дат: ${listDates(stopped)} — сайт и Кузьмич начнут их предлагать.`,
        rows: [...confirmRow(`ss:v:${tour.id}`), back(tour.id)],
      };
    }
    const opened = await writeStop({
      partnerId: opts.partnerId, tourId: tour.id, from: stopped[0]!, to: stopped[stopped.length - 1]!, dates: stopped, keptBooked: [],
      userId: opts.userId, via: opts.via, action: 'open',
    });
    if (opened.length === 0) return { text: 'Стоп уже снят. Ничего не менял.', rows: [back(tour.id)] };
    return { text: `Стоп снят: «${title}» снова в продаже на ${opened.length} дат: ${listDates(opened)}.`, rows: [back()] };
  } catch (err) {
    console.error(`[stop-sales] отказ базы, SQLSTATE ${sqlstate(err)}`);
    return { text: 'База не ответила. Даты не менял.', rows: [back()] };
  }
}

/**
 * Закрыть или снова открыть даты одним UPDATE и записать аудит — в одной
 * транзакции. Возвращает даты, которые действительно сменились (повтор — пусто).
 */
async function writeStop(w: {
  partnerId: string; tourId: string; from: string; to: string; dates: string[]; keptBooked: string[];
  userId: string | null; via: 'max' | 'telegram'; action: 'close' | 'open';
}): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sql = w.action === 'close'
      ? `UPDATE tour_availability ta SET is_cancelled = TRUE, cancellation_reason = $4, updated_at = NOW()
           FROM operator_tours t
          WHERE t.id = ta.operator_tour_id AND t.operator_id = $1::uuid AND t.deleted_at IS NULL
            AND ta.operator_tour_id = $2::bigint AND ta.date = ANY($3::date[]) AND ta.deleted_at IS NULL
            AND COALESCE(ta.is_cancelled, FALSE) = FALSE
          RETURNING ta.date::text AS d`
      : `UPDATE tour_availability ta SET is_cancelled = FALSE, cancellation_reason = NULL, updated_at = NOW()
           FROM operator_tours t
          WHERE t.id = ta.operator_tour_id AND t.operator_id = $1::uuid AND t.deleted_at IS NULL
            AND ta.operator_tour_id = $2::bigint AND ta.date = ANY($3::date[]) AND ta.deleted_at IS NULL
            AND ta.is_cancelled = TRUE AND ta.cancellation_reason = $4
          RETURNING ta.date::text AS d`;
    const { rows } = await client.query<{ d: string }>(sql, [w.partnerId, w.tourId, w.dates, STOP_REASON]);
    const changed = rows.map((r) => r.d.slice(0, 10)).sort();
    if (changed.length > 0) {
      await client.query(
        `INSERT INTO tour_stop_sales (operator_id, tour_id, action, date_from, date_to, dates, kept_booked, by_user, via)
         VALUES ($1::uuid, $2::bigint, $3, $4::date, $5::date, $6::date[], $7::date[], $8::uuid, $9)`,
        [w.partnerId, w.tourId, w.action, w.from, w.to, changed, w.keptBooked, w.userId, w.via],
      );
    }
    await client.query('COMMIT');
    return changed;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
