/**
 * Открыть даты тура — одна дверь на все пути записи (22.10, «Открой даты
 * словами», этап B).
 *
 * ── Зачем одна функция ────────────────────────────────────────────────────
 *
 * Даты тура открывали три писателя, и правила у них были разные:
 *   - кабинет, массовое открытие (`POST /api/operator/calendar/bulk-open`) —
 *     SQL прямо в роуте; «открытой» считал строку без проверки `deleted_at`, а
 *     upsert не снимал ни `deleted_at`, ни причину закрытия;
 *   - кабинет, даты тура (`addAvailability`, `/api/hub/operator/tours/[id]/
 *     availability`) — свой upsert, владение без проверки `is_active`;
 *   - помощник кабинета (`OperatorAgency.addSlots`, «открой даты» в веб-чате)
 *     — `ON CONFLICT DO NOTHING`, без числа мест ставил 10 (выдуманное число,
 *     §4.0), активность тура не смотрел.
 *
 * И ни один не смотрел, сколько человек УЖЕ записано. Счётчик `booked_slots`
 * растёт только при оплате, а приём оплаты выключен с 05.10 — настоящая
 * занятость считается по броням (`occupiedOnDaySql`, как у гейта брони
 * `readTourDays`): все, кроме отменённых и отклонённых, многодневная бронь
 * занимает все свои дни, и бронь бывает на дате БЕЗ строки календаря (заявка в
 * сезон без расписания, `lib/tours/request-window`). Кабинет мог поставить на
 * дату 8 мест, когда записано уже 9.
 *
 * ── Что держит функция ────────────────────────────────────────────────────
 *
 *  1. Владение и блокировка — ОДНИМ запросом: тур этого оператора, включён и не
 *     удалён, строка тура под `FOR NO KEY UPDATE`. Гейт брони (`reserveBooking`)
 *     берёт `FOR UPDATE` на той же строке, и эти блокировки конфликтуют: между
 *     чтением занятости и записью мест бронь не пройдёт, а бронь, начатая
 *     раньше, будет видна. С `KEY SHARE` внешних ключей (вставка брони, строки
 *     календаря) `NO KEY UPDATE` не конфликтует.
 *  2. Занятость — `GREATEST(booked_slots, занятость по броням)`. Мест меньше
 *     занятых — отказ `refused_booked`, и для открытия, и для правки уже
 *     открытой даты, и для закрытой: ниже записанных места не опускаются.
 *  3. «Открыта» значит то же, что у витрины (`/api/tours/[id]/slots`): строка
 *     не снята, `is_cancelled = false`, мест больше нуля.
 *  4. Исход по КАЖДОЙ дате, а не «открыто N»: что открыто, что открыто снова,
 *     что переписано, что уже было открыто и почему остальное не тронуто.
 *
 * Настройки по вызывающему — правило одно, решения разные:
 *   - `skipExisting` — открытую дату не трогать (`already_open`) или переписать
 *     её места (`updated`, только кабинет);
 *   - `closedDates` — закрытую оператором дату (строка с причиной, например
 *     «Шторм») открыть снова, как кабинет (`reopen`), или не трогать
 *     (`keep`, чат и помощник: решение 22.10 — закрытое закрыл человек, и
 *     открыть его обратно может только он, в кабинете);
 *   - `today` — прошедшие даты (`refused_past`) и даты дальше года вперёд
 *     (`refused_horizon`, `OPEN_DATES_HORIZON_DAYS`: витрина отдаёт даты не
 *     дальше `CURRENT_DATE + 1 year`, и дату за ним туристы не увидят).
 *     Кабинет `today` не передаёт: прошлую дату ему можно, как и раньше;
 *   - `enforceSeason` — дату вне окна сезона (`requestWindow`) не открывать
 *     (решение 22.10 для чата и помощника: сезон меняется в карточке тура).
 *     Строка календаря сильнее сезона: уже открытую дату правило не трогает.
 *
 * ── Отказ ─────────────────────────────────────────────────────────────────
 *
 * Запись атомарна: одна транзакция, один upsert. Поэтому исхода «эта дата не
 * записалась» нет: либо записано всё, что разрешено, либо ничего, и тогда
 * `openTourDates` отвечает `{ ok: false, reason: 'failed', sqlstate }`, а в
 * лог уходит имя проверки и SQLSTATE. `openTourDatesTx` — для вызывающего со
 * своей транзакцией (чат: захват предложения и запись дат — одна транзакция):
 * ошибку базы он БРОСАЕТ, потому что после неё транзакция в 25P02 и решать,
 * что дальше, должен её владелец.
 *
 * Сторож — на настоящем PostgreSQL: tests/integration/tour-dates-open.pg.test.ts.
 */

import type { PoolClient } from 'pg';
import { pool } from '@/lib/db-pool';
import { occupiedOnDaySql } from '@/lib/bookings/occupancy';
import { requestWindow, dateInWindow } from './request-window';

/** Даты дальше этого числа дней от сегодня витрина не показывает (`+ 1 year`). */
export const OPEN_DATES_HORIZON_DAYS = 365;
/** Мест на дату — как у кабинета (`slots` в bulk-open). */
export const MAX_SLOTS_PER_DATE = 500;

/**
 * Даты диапазона с фильтром по дням недели (0 = пн … 6 = вс). Перенесено из
 * роута bulk-open как есть: пустой ответ — диапазон перевёрнут или длиннее
 * 366 дней.
 */
export function datesInRange(start: string, end: string, weekdayFilter?: number[]): string[] {
  const result: string[] = [];
  const cur = new Date(start + 'T00:00:00Z');
  const fin = new Date(end   + 'T00:00:00Z');
  if (fin < cur || (fin.getTime() - cur.getTime()) > 366 * 86_400_000) return result;

  while (cur <= fin) {
    // JS getUTCDay(): 0=вс,1=пн,...,6=сб → конвертируем в 0=пн,...,6=вс
    const jsDay    = cur.getUTCDay();
    const weekday  = jsDay === 0 ? 6 : jsDay - 1;
    if (!weekdayFilter || weekdayFilter.length === 0 || weekdayFilter.includes(weekday)) {
      result.push(cur.toISOString().slice(0, 10));
    }
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return result;
}

/** Исход по одной дате. */
export type DateOpenResult =
  /** Строки не было — дата открыта. */
  | { date: string; result: 'opened' }
  /** Дата была закрыта (причина — слово оператора), снята или без отметки — открыта снова. */
  | { date: string; result: 'reopened'; reason: string | null }
  /** Дата была открыта, места переписаны (только при `skipExisting = false`). */
  | { date: string; result: 'updated'; from: number }
  /** Дата уже открыта и не тронута (`skipExisting = true`). */
  | { date: string; result: 'already_open'; slots: number }
  /** Записано больше, чем мест в запросе, — места ниже занятых не опускаются. */
  | { date: string; result: 'refused_booked'; taken: number }
  /** Дату закрыл оператор, а вызывающий закрытое не открывает (`closedDates = 'keep'`). */
  | { date: string; result: 'refused_closed'; reason: string | null }
  /** Дата раньше `today`. */
  | { date: string; result: 'refused_past' }
  /** Дата дальше `today + OPEN_DATES_HORIZON_DAYS`: туристы её не увидят. */
  | { date: string; result: 'refused_horizon'; lastDate: string }
  /** Дата вне окна сезона тура (`enforceSeason`): выезд с `from` по `to`. */
  | { date: string; result: 'refused_season'; seasonStart: string; seasonEnd: string; from: string; to: string };

export type DateOpenKind = DateOpenResult['result'];

/** Исходы, при которых дата записана. */
export const WRITTEN_RESULTS: ReadonlySet<DateOpenKind> = new Set(['opened', 'reopened', 'updated']);

export interface OpenDateRow {
  date: string;
  slots: number;
  /** Цена на дату; без права цен — только null. */
  price?: number | null;
}

export interface OpenDatesInput {
  /** `partners.id` кабинета, от имени которого пишутся даты. */
  operatorId: string;
  /** `operator_tours.id` (BIGINT из pg приходит строкой). */
  tourId: string | number;
  rows: OpenDateRow[];
  /**
   * Право ставить цену. Без него цена существующей даты не трогается, а новая
   * дата получает NULL (цена тура).
   */
  mayPrice: boolean;
  /** Открытую дату не трогать (`already_open`) — или переписать её места (`updated`). */
  skipExisting: boolean;
  /** Закрытую оператором дату открыть снова (`reopen`) или не трогать (`keep`). */
  closedDates: 'reopen' | 'keep';
  /** Сегодня по Камчатке: отказ прошедшим и дальше горизонта. Без него — не проверяется. */
  today?: string;
  /** Отказ датам вне сезона тура. Требует `today`. */
  enforceSeason?: boolean;
}

export interface OpenedTour {
  title: string;
  maxParticipants: number | null;
  isPublished: boolean;
}

export type OpenDatesOutcome =
  | { ok: true; tour: OpenedTour; perDate: DateOpenResult[]; written: number }
  /** Тура нет, он не этого оператора, выключен или удалён — ничего не записано. */
  | { ok: false; reason: 'tour_not_found' };

/** Ответ `openTourDates`: плюс отказ базы — ничего не записано. */
export type OpenDatesResult = OpenDatesOutcome | { ok: false; reason: 'failed'; sqlstate: string | null };

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Настоящая календарная дата YYYY-MM-DD: 2027-02-31 формой проходит, датой — нет. */
export function isCalendarDate(date: string): boolean {
  if (!ISO.test(date)) return false;
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Вход проверяется ДО базы: это ошибка вызывающего, а не отказ базы, и
 * выдавать её за «база не ответила» нельзя. Повтор даты — берётся последний
 * (так вёл себя прежний addAvailability).
 */
function normalize(input: OpenDatesInput): Map<string, { slots: number; price: number | null }> {
  if (input.enforceSeason && !input.today) {
    throw new TypeError('openTourDates: сезон проверяется только с today');
  }
  if (input.today !== undefined && !isCalendarDate(input.today)) {
    throw new TypeError(`openTourDates: today не дата: ${input.today}`);
  }
  const byDate = new Map<string, { slots: number; price: number | null }>();
  for (const row of input.rows) {
    if (!isCalendarDate(row.date)) throw new TypeError(`openTourDates: не дата: ${row.date}`);
    if (!Number.isInteger(row.slots) || row.slots < 1 || row.slots > MAX_SLOTS_PER_DATE) {
      throw new TypeError(`openTourDates: мест на ${row.date} — ${row.slots}, нужно целое от 1 до ${MAX_SLOTS_PER_DATE}`);
    }
    const price = row.price ?? null;
    // Чат и помощник цену не меняют ни при каких правах; кабинет без права цен
    // получает 403 раньше. Цена здесь без права — ошибка вызывающего.
    if (price !== null && !input.mayPrice) {
      throw new TypeError('openTourDates: цена на дату без права цен');
    }
    byDate.delete(row.date);
    byDate.set(row.date, { slots: row.slots, price });
  }
  if (byDate.size === 0) throw new TypeError('openTourDates: нет дат');
  return byDate;
}

interface TourRow {
  title: string;
  max_participants: number | null;
  is_published: boolean | null;
  season_start: string | null;
  season_end: string | null;
  duration_type: string | null;
  multi_day_count: number | null;
  duration_hours: number | null;
}

interface StateRow {
  date: string;
  has_row: boolean;
  deleted: boolean;
  available_slots: number | null;
  is_cancelled: boolean | null;
  cancellation_reason: string | null;
  taken: number;
}

/**
 * Записать даты в транзакции вызывающего. Клиент УЖЕ в транзакции; ошибку
 * базы функция бросает — откат и слова человеку решает владелец транзакции.
 */
export async function openTourDatesTx(client: Pick<PoolClient, 'query'>, input: OpenDatesInput): Promise<OpenDatesOutcome> {
  const byDate = normalize(input);
  const dates = [...byDate.keys()].sort();

  // Владение, активность и блокировка — одним запросом (см. шапку, п. 1).
  const tourRes = await client.query<TourRow>(
    `SELECT title, max_participants, is_published,
            season_start::text AS season_start, season_end::text AS season_end,
            duration_type, multi_day_count, duration_hours
       FROM operator_tours WHERE id = $1 AND operator_id = $2
        AND is_active = true AND deleted_at IS NULL
     FOR NO KEY UPDATE`,
    [String(input.tourId), input.operatorId],
  );
  const tour = tourRes.rows[0];
  if (!tour) return { ok: false, reason: 'tour_not_found' };

  // Состояние каждой даты под той же блокировкой: строка календаря и занятость
  // по броням — тем же правилом, что у гейта брони.
  const stateRes = await client.query<StateRow>(
    `SELECT d.date::text AS date,
            (ta.id IS NOT NULL)                                AS has_row,
            (ta.deleted_at IS NOT NULL)                        AS deleted,
            ta.available_slots,
            ta.is_cancelled,
            ta.cancellation_reason,
            GREATEST(COALESCE(ta.booked_slots, 0), occ.taken)::int AS taken
       FROM unnest($2::date[]) AS d(date)
       LEFT JOIN tour_availability ta
              ON ta.operator_tour_id = $1::bigint AND ta.date = d.date
       CROSS JOIN LATERAL (
         ${occupiedOnDaySql({ booking: 'b', day: 'd.date', tourId: '$1::bigint' })}
       ) occ`,
    [String(input.tourId), dates],
  );
  const state = new Map(stateRes.rows.map((r) => [r.date, r]));

  const window = input.enforceSeason && input.today ? requestWindow(tour, input.today) : null;
  const lastDate = input.today ? addDays(input.today, OPEN_DATES_HORIZON_DAYS) : null;

  const perDate: DateOpenResult[] = [];
  const toWrite: Array<{ date: string; slots: number; price: number | null }> = [];
  for (const date of dates) {
    const want = byDate.get(date)!;
    const s = state.get(date);
    // Строки состояния нет — запрос ответил не на то, что спрашивали. Считать
    // такую дату свободной значило бы открыть её вслепую (§4.0).
    if (!s) throw new Error(`openTourDates: состояние даты ${date} не прочитано`);

    const live = s.has_row && !s.deleted;
    const open = live && s.is_cancelled === false && (s.available_slots ?? 0) > 0;
    const closed = live && s.is_cancelled === true;

    if (input.today && date < input.today) { perDate.push({ date, result: 'refused_past' }); continue; }
    if (lastDate && date > lastDate) { perDate.push({ date, result: 'refused_horizon', lastDate }); continue; }
    if (open && input.skipExisting) {
      perDate.push({ date, result: 'already_open', slots: s.available_slots ?? 0 });
      continue;
    }
    if (closed && input.closedDates === 'keep') {
      perDate.push({ date, result: 'refused_closed', reason: s.cancellation_reason });
      continue;
    }
    // Строка календаря сильнее сезона: окно судит только дату, которая сейчас
    // не открыта.
    if (window && window.kind === 'season' && !open && !dateInWindow(window, date)) {
      perDate.push({
        date, result: 'refused_season',
        seasonStart: window.seasonStart, seasonEnd: window.seasonEnd, from: window.from, to: window.to,
      });
      continue;
    }
    if (s.taken > want.slots) { perDate.push({ date, result: 'refused_booked', taken: s.taken }); continue; }

    if (!s.has_row) perDate.push({ date, result: 'opened' });
    else if (open) perDate.push({ date, result: 'updated', from: s.available_slots ?? 0 });
    else perDate.push({ date, result: 'reopened', reason: closed ? s.cancellation_reason : null });
    toWrite.push({ date, slots: want.slots, price: want.price });
  }

  if (toWrite.length > 0) {
    // Без права цен повторное открытие цену даты не трогает ($5 = false), иначе
    // сбросило бы цену владельца на базовую. Снятая строка и причина закрытия
    // снимаются: открытая дата открыта и туристу (/api/tours/[id]/slots).
    const upsert = await client.query(
      `INSERT INTO tour_availability (operator_tour_id, date, day_of_week, available_slots, base_price_override)
       SELECT $1::bigint, d.date, EXTRACT(DOW FROM d.date)::int, d.slots, d.price
         FROM unnest($2::date[], $3::int[], $4::numeric[]) AS d(date, slots, price)
       ON CONFLICT (operator_tour_id, date) DO UPDATE SET
         available_slots     = EXCLUDED.available_slots,
         base_price_override = CASE WHEN $5::boolean THEN EXCLUDED.base_price_override ELSE tour_availability.base_price_override END,
         is_cancelled        = FALSE,
         cancellation_reason = NULL,
         deleted_at          = NULL,
         updated_at          = NOW()`,
      [
        String(input.tourId),
        toWrite.map((r) => r.date),
        toWrite.map((r) => r.slots),
        toWrite.map((r) => r.price),
        input.mayPrice,
      ],
    );
    // Каждая разрешённая дата — ровно одна строка (вставка или правка). Иное
    // число — запись не та, что разрешена, и выдавать её за успех нельзя.
    if (upsert.rowCount !== toWrite.length) {
      throw new Error(`openTourDates: записано ${upsert.rowCount ?? 'неизвестно'} строк из ${toWrite.length}`);
    }
  }

  return {
    ok: true,
    tour: {
      title: tour.title,
      maxParticipants: tour.max_participants,
      isPublished: tour.is_published === true,
    },
    perDate,
    written: toWrite.length,
  };
}

/**
 * Записать даты своей транзакцией. Отказ базы — `{ ok: false, reason:
 * 'failed' }`: транзакция откачена, не записано ничего; в лог — проверка и
 * SQLSTATE. Ошибка входа (не дата, места вне 1…500, цена без права) бросается
 * до базы.
 */
export async function openTourDates(input: OpenDatesInput): Promise<OpenDatesResult> {
  normalize(input);
  let client: PoolClient | null = null;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const outcome = await openTourDatesTx(client, input);
    await client.query(outcome.ok ? 'COMMIT' : 'ROLLBACK');
    client.release();
    client = null;
    return outcome;
  } catch (err) {
    const sqlstate = (err as { code?: string } | null)?.code ?? null;
    console.error(
      '[tours/availability-open] даты тура не открыты, тур', String(input.tourId),
      'SQLSTATE', sqlstate ?? 'нет SQLSTATE', err instanceof Error ? err.message : String(err),
    );
    if (client) {
      try {
        await client.query('ROLLBACK');
        client.release();
      } catch (rollbackErr) {
        // Откат не прошёл — соединение не возвращается в пул как годное.
        console.error('[tours/availability-open] откат не выполнен, соединение закрыто:',
          rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr));
        client.release(rollbackErr instanceof Error ? rollbackErr : true);
      }
    }
    return { ok: false, reason: 'failed', sqlstate };
  }
}

/** Счёт исходов — для ответа роута и строк помощника. */
export function countResults(perDate: DateOpenResult[]): Record<DateOpenKind, number> {
  const out: Record<DateOpenKind, number> = {
    opened: 0, reopened: 0, updated: 0, already_open: 0,
    refused_booked: 0, refused_closed: 0, refused_past: 0, refused_horizon: 0, refused_season: 0,
  };
  for (const r of perDate) out[r.result] += 1;
  return out;
}
