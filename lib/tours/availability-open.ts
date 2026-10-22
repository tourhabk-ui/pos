/**
 * Открыть даты тура — одна дверь для всех, кто ОТКРЫВАЕТ даты (22.10,
 * «Открой даты словами», этап B): кабинет (массово и в карточке тура),
 * помощник кабинета и, после этапа C, чат кабинета в MAX.
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
 *  1. Владение и блокировка — ОДНИМ запросом: тур этого оператора и не удалён,
 *     строка тура под `FOR NO KEY UPDATE`. Новая бронь берёт блокировку той же
 *     строки: гейт брони (`reserveBooking`, холд OCTO, перенос) — `FOR UPDATE`,
 *     ручная бронь оператора (`POST /api/hub/operator/bookings`) — `FOR SHARE`
 *     (гейта мест у неё нет, но и пройти мимо записи дат она не должна, ревью
 *     22.10). Обе конфликтуют с `NO KEY UPDATE`: между чтением занятости и
 *     записью мест новая бронь не пройдёт, а бронь, начатая раньше, будет
 *     видна. С `KEY SHARE` внешних ключей (строки календаря) `NO KEY UPDATE` не
 *     конфликтует — поэтому вставка брони БЕЗ своей блокировки тура прошла бы
 *     мимо, и такой двери быть не должно (сторож — tour-dates-open.pg).
 *     Правка уже заведённой брони (число людей, статус) запирает только строку
 *     брони: это оператор меняет своё, и гонку с записью дат она не держит.
 *  2. Занятость — `GREATEST(booked_slots, занятость по броням)`. Мест меньше
 *     занятых — отказ `refused_booked`, и для открытия, и для правки уже
 *     открытой даты, и для закрытой: ниже записанных места не опускаются.
 *  3. «Открыта» значит то же, что у витрины (`/api/tours/[id]/slots`): строка
 *     не снята, `is_cancelled = false`, мест больше нуля.
 *  4. Исход по КАЖДОЙ дате, а не «открыто N»: что открыто, что открыто снова,
 *     что переписано, что уже было открыто и почему остальное не тронуто.
 *
 * Настройки по вызывающему — правило одно, решения разные:
 *   - `inactiveTour` — скрытый тур (`is_active = false`: «Скрыть» в списке
 *     туров, снятый «Активен» в карточке или приостановка за отзывы).
 *     Кабинет пишет ему даты (`write`), как и до 22.10 писала карточка тура:
 *     на межсезонье тур скрыт, а даты следующего сезона готовятся заранее;
 *     туристы их не видят (`publicTourSql`), гейт брони скрытый тур не
 *     бронирует. Помощник и чат отказывают (`refuse`) — исходом
 *     `tour_inactive`, а не «тур не найден»: тур есть, он скрыт;
 *   - `skipExisting` — открытую дату не трогать (`already_open`) или переписать
 *     её места (`updated`, только кабинет);
 *   - `closedDates` — закрытую оператором дату (строка с причиной, например
 *     «Шторм») открыть снова, как кабинет (`reopen`), или не трогать
 *     (`keep`, чат и помощник: решение 22.10 — закрытое закрыл человек, и
 *     открыть его обратно может только он, в кабинете);
 *   - `today` — прошедшие даты (`refused_past`) и даты дальше года вперёд
 *     (`refused_horizon`, `horizonLastDate`: витрина отдаёт даты не дальше
 *     `CURRENT_DATE + INTERVAL '1 year'` — тот же день через год, а не через
 *     365 дней: год с 29 февраля длиннее; дату за горизонтом туристы не
 *     увидят). Кабинет `today` не передаёт: прошлую дату ему можно, как и раньше;
 *   - `enforceSeason` — дату вне окна сезона (`requestWindow`) не открывать
 *     (решение 22.10 для чата и помощника: сезон меняется в карточке тура).
 *     Строка календаря сильнее сезона: уже открытую дату правило не трогает.
 *
 * ── Другие писатели календаря ─────────────────────────────────────────────
 *
 * Не все пути записи идут через эту функцию, и это названо, а не обещано
 * обратное:
 *   - `POST /api/operator/calendar` — одна дата из календаря кабинета, ставит
 *     и места, и закрытие, и погоду одной формой; свой upsert, занятость не
 *     проверяет (спецификация 22.10, §11 — перевод отдельной задачей);
 *   - `POST /api/operator/calendar/block` — закрытие диапазона;
 *   - счётчики оплаты (`booked_slots`) — приёмники платежей.
 * Блокировку строки тура они не берут, и их запись может лечь между чтением
 * состояния дат здесь и upsert. Поэтому upsert не верит прочитанному слепо:
 * `DO UPDATE` с условием по режиму не трогает дату, которая к моменту записи
 * стала закрытой (`closedDates = 'keep'`) или открытой (`skipExisting`), — и
 * такая дата перечитывается и получает свой исход (`refused_closed`,
 * `already_open`), а не «открыто». Закрытие «Шторм», легшее в это окно, чат и
 * помощник не снимают.
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

/**
 * Последний день, который витрина покажет при этом «сегодня»: тот же
 * календарный день через год, как `$today::date + INTERVAL '1 year'` в
 * PostgreSQL (`/api/tours/[id]/slots`). 29 февраля через год — 28 февраля:
 * так считает и сервер. Не `+ 365 дней`: при 29 февраля впереди это на день
 * короче витрины, и помощник отказал бы в дате, которую туристы увидят.
 */
export function horizonLastDate(today: string): string {
  if (!isCalendarDate(today)) throw new TypeError(`horizonLastDate: не дата: ${today}`);
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  // День 0 следующего месяца — последний день этого: в феврале невисокосного
  // года 29-е превращается в 28-е, а не перекатывается в 1 марта.
  const lastOfMonth = new Date(Date.UTC(y + 1, m, 0)).getUTCDate();
  return new Date(Date.UTC(y + 1, m - 1, Math.min(d, lastOfMonth))).toISOString().slice(0, 10);
}
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
  /** Дата дальше `horizonLastDate(today)`: туристы её не увидят. */
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
   * дата получает NULL (цена тура). С ним цена даты меняется на ПЕРЕДАННУЮ;
   * строка без цены (`price` null) цену существующей даты не трогает.
   */
  mayPrice: boolean;
  /**
   * Скрытый тур (`is_active = false`): писать даты (`write`, кабинет) или
   * отказать исходом `tour_inactive` (`refuse`, помощник и чат). Без
   * умолчания: каждый вызывающий решает сам.
   */
  inactiveTour: 'write' | 'refuse';
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
  /** Тур не скрыт (`is_active`). Скрытому туристы даты не видят. */
  isActive: boolean;
}

export type OpenDatesOutcome =
  | { ok: true; tour: OpenedTour; perDate: DateOpenResult[]; written: number }
  /** Тура нет, он не этого оператора или удалён — ничего не записано. */
  | { ok: false; reason: 'tour_not_found' }
  /** Тур есть и этого оператора, но скрыт, а вызывающий скрытому не пишет. */
  | { ok: false; reason: 'tour_inactive'; title: string };

/** Ответ `openTourDates`: плюс отказ базы — ничего не записано. */
export type OpenDatesResult = OpenDatesOutcome | { ok: false; reason: 'failed'; sqlstate: string | null };

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Настоящая календарная дата YYYY-MM-DD: 2027-02-31 формой проходит, датой — нет. */
export function isCalendarDate(date: string): boolean {
  if (!ISO.test(date)) return false;
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
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
  is_active: boolean | null;
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

  // Владение и блокировка — одним запросом (см. шапку, п. 1). Скрытость
  // читается, а не отсекается: «скрыт» и «не найден» — разные ответы.
  const tourRes = await client.query<TourRow>(
    `SELECT title, max_participants, is_published, is_active,
            season_start::text AS season_start, season_end::text AS season_end,
            duration_type, multi_day_count, duration_hours
       FROM operator_tours WHERE id = $1 AND operator_id = $2
        AND deleted_at IS NULL
     FOR NO KEY UPDATE`,
    [String(input.tourId), input.operatorId],
  );
  const tour = tourRes.rows[0];
  if (!tour) return { ok: false, reason: 'tour_not_found' };
  const isActive = tour.is_active === true;
  if (!isActive && input.inactiveTour === 'refuse') return { ok: false, reason: 'tour_inactive', title: tour.title };

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
  const lastDate = input.today ? horizonLastDate(input.today) : null;

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

  let written = 0;
  if (toWrite.length > 0) {
    // Цена даты меняется, только если её ПЕРЕДАЛИ, и только с правом цен ($5):
    // иначе открытие мест без цены (поле «Цена» пустое, добавление даты в
    // карточке тура) сбросило бы цену владельца на базовую молча (ревью
    // 22.10). Сбросить цену даты — отдельное действие: форма даты в
    // календаре кабинета (POST /api/operator/calendar). Снятая строка и
    // причина закрытия снимаются: открытая дата открыта и туристу
    // (/api/tours/[id]/slots).
    //
    // Условие DO UPDATE — страховка от писателей без блокировки тура (см.
    // шапку, «Другие писатели»): дату, закрытую ($6) или открытую ($7) после
    // нашего чтения, upsert не трогает, и она не возвращается в RETURNING.
    const upsert = await client.query<{ date: string }>(
      `INSERT INTO tour_availability (operator_tour_id, date, day_of_week, available_slots, base_price_override)
       SELECT $1::bigint, d.date, EXTRACT(DOW FROM d.date)::int, d.slots, d.price
         FROM unnest($2::date[], $3::int[], $4::numeric[]) AS d(date, slots, price)
       ON CONFLICT (operator_tour_id, date) DO UPDATE SET
         available_slots     = EXCLUDED.available_slots,
         base_price_override = CASE WHEN $5::boolean AND EXCLUDED.base_price_override IS NOT NULL
                                    THEN EXCLUDED.base_price_override ELSE tour_availability.base_price_override END,
         is_cancelled        = FALSE,
         cancellation_reason = NULL,
         deleted_at          = NULL,
         updated_at          = NOW()
       WHERE NOT ($6::boolean AND tour_availability.deleted_at IS NULL AND tour_availability.is_cancelled IS TRUE)
         AND NOT ($7::boolean AND tour_availability.deleted_at IS NULL AND tour_availability.is_cancelled IS FALSE
                  AND tour_availability.available_slots > 0)
       RETURNING date::text AS date`,
      [
        String(input.tourId),
        toWrite.map((r) => r.date),
        toWrite.map((r) => r.slots),
        toWrite.map((r) => r.price),
        input.mayPrice,
        input.closedDates === 'keep',
        input.skipExisting,
      ],
    );
    const done = new Set(upsert.rows.map((r) => r.date));
    written = done.size;
    const changed = toWrite.map((r) => r.date).filter((d) => !done.has(d));
    if (changed.length > 0) await reclassifyChanged(client, input, changed, perDate);
  }

  return {
    ok: true,
    tour: {
      title: tour.title,
      maxParticipants: tour.max_participants,
      isPublished: tour.is_published === true,
      isActive,
    },
    perDate,
    written,
  };
}

/**
 * Даты, которые upsert не тронул: их состояние сменил писатель без блокировки
 * тура между нашим чтением и записью. Перечитываются и получают исход по
 * тому, что стоит сейчас. Иное состояние (строки нет, она снята) значит, что
 * запись не та, что разрешена, — ошибка, транзакция откатывается.
 */
async function reclassifyChanged(
  client: Pick<PoolClient, 'query'>,
  input: OpenDatesInput,
  changed: string[],
  perDate: DateOpenResult[],
): Promise<void> {
  const now = await client.query<{ date: string; available_slots: number | null; is_cancelled: boolean | null; cancellation_reason: string | null }>(
    `SELECT date::text AS date, available_slots, is_cancelled, cancellation_reason
       FROM tour_availability
      WHERE operator_tour_id = $1::bigint AND date = ANY($2::date[]) AND deleted_at IS NULL`,
    [String(input.tourId), changed],
  );
  const byDate = new Map(now.rows.map((r) => [r.date, r]));
  for (const date of changed) {
    const r = byDate.get(date);
    const i = perDate.findIndex((p) => p.date === date);
    if (r && i >= 0 && input.closedDates === 'keep' && r.is_cancelled === true) {
      perDate[i] = { date, result: 'refused_closed', reason: r.cancellation_reason };
    } else if (r && i >= 0 && input.skipExisting && r.is_cancelled === false && (r.available_slots ?? 0) > 0) {
      perDate[i] = { date, result: 'already_open', slots: r.available_slots ?? 0 };
    } else {
      throw new Error(`openTourDates: дата ${date} не записана, и её состояние не объясняет почему`);
    }
  }
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

/**
 * Отказ скрытому туру словами — один текст на кабинет и помощника. Тур есть и
 * виден оператору в списке, поэтому «не найден» здесь было бы неправдой.
 */
export function tourHiddenText(title: string): string {
  // Включение тура даты само не открывает: обещать «тогда откроются» значило
  // бы сказать то, чего система не сделает (ревью 22.10).
  return `Тур «${title}» скрыт — туристы его не видят, и даты ему не открыты. ` +
    'Включите его («Показать» в списке туров или «Активен» в карточке тура) и откройте даты ещё раз — ' +
    'сами при включении они не откроются.';
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
