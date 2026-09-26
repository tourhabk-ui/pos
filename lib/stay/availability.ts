/**
 * lib/stay/availability.ts — одна формула занятости жилья для всех дверей.
 *
 * До 26.09 занятость считалась четырьмя способами, и все четыре расходились:
 * - `blocked-dates` закрывал ВЕСЬ объект, если занят хоть один номер: у базы
 *   с пятью номерами и одной бронью гость видел закрытый календарь;
 * - `availability` делил на `total_rooms || 10` — число, которого никто не
 *   объявлял, — и считал брони всех номеров против него;
 * - `book` считал брони, пересекающие окно ГДЕ-НИБУДЬ, а не по ночам: две
 *   брони на разные ночи занимали «два номера» на всё окно;
 * - число владельца на дату (`accommodation_availability.available_rooms`)
 *   хранилось и не читалось никем.
 *
 * Теперь ответ на вопрос «сколько свободно у номера в эту ночь» даёт один
 * SQL-фрагмент, и его зовут бронь, публичная доступность, календарь гостя и
 * поиск каталога.
 *
 * ПРАВИЛО НОЧИ (для номера r и ночи d):
 *   фонд      = r.available_rooms (сколько таких номеров в объекте)
 *   число дня = accommodation_availability.available_rooms номера на дату —
 *               сколько таких номеров владелец продаёт в эту ночь ВСЕГО
 *               (включая уже занятые); не задано — фонд
 *   свободно  = min(фонд, число дня) − занято этим номером
 *   и не больше, чем (число дня уровня объекта − занято по объекту), если
 *   владелец задал число на весь объект.
 *   Закрыто   = блок уровня объекта ИЛИ блок уровня номера.
 *
 * КТО ДЕРЖИТ НОМЕР. Подтверждённая и завершённая бронь (гость может жить,
 * пока отмечен заезд), а заявка `pending` — только первые
 * PENDING_HOLD_HOURS часов. Без срока заявки держали бы номер вечно:
 * бронь не стоит денег (оплата на месте, решение владельца 26.09), и десяток
 * заявок закрывал бы объект целиком. Сторож Watchdog будит владельца о
 * заявке через 24 ч; через 72 ч заявка перестаёт держать номер, но НЕ
 * отменяется — подтвердить её можно, если номер ещё свободен (PATCH
 * перепроверяет занятость под той же блокировкой, что и бронь).
 */

/** Сколько часов заявка без подтверждения держит номер. */
export const PENDING_HOLD_HOURS = 72;

/**
 * Тот же срок литералом для SQL. Литерал, а не подстановка: сторож
 * `sql-interval-not-concatenated` запрещает склейку внутрь интервала, а
 * совпадение с числом выше держит тест `stay-availability`.
 */
export const PENDING_HOLD_INTERVAL_SQL = `INTERVAL '72 hours'`;

/**
 * Сколько одновременно действующих заявок один гость может держать на одном
 * объекте. Три — семья или маленькая группа, берущая несколько номеров; больше
 * — уже не бронь, а занятие чужого фонда. Считаются только заявки, которые
 * ещё держат номер (моложе PENDING_HOLD_HOURS).
 */
export const MAX_HOLDING_PENDING_PER_PROPERTY = 3;

/** Условие «бронь с алиасом b держит номер». */
export function holdsRoomSql(b: string): string {
  return `(${b}.status IN ('confirmed', 'completed') OR (${b}.status = 'pending' AND ${b}.created_at > NOW() - ${PENDING_HOLD_INTERVAL_SQL}))`;
}

export interface RoomNightsSqlOptions {
  /** SQL-выражение id объекта: плейсхолдер (`$1`) или колонка (`a.id`). */
  accommodation: string;
  /** Первая ночь — SQL-выражение типа date. */
  start: string;
  /** Ночь ПОСЛЕ последней (дата выезда) — SQL-выражение типа date. */
  endExclusive: string;
  /** Плейсхолдер id номера — только этот номер. */
  room?: string;
  /** Плейсхолдер id брони, которую не считать (перепроверка при подтверждении). */
  excludeBooking?: string;
}

/**
 * Строка на каждую пару (активный номер, ночь):
 *   room_id, night (text), blocked (bool), free_units (int ≥ 0),
 *   object_free (int | null — остаток по числу владельца на весь объект),
 *   price (numeric — номер > объект > базовая цена номера).
 */
export function roomNightsSql(o: RoomNightsSqlOptions): string {
  const roomFilter = o.room ? `AND r.id = ${o.room}::uuid` : '';
  const exclude = o.excludeBooking ? `AND b.id <> ${o.excludeBooking}::uuid` : '';
  return `
    SELECT r.id::text AS room_id,
           d.night::date::text AS night,
           (COALESCE(ao.is_blocked, false) OR COALESCE(ar.is_blocked, false)) AS blocked,
           GREATEST(0, LEAST(
             LEAST(r.available_rooms, COALESCE(ar.available_rooms, r.available_rooms)) - rb.booked,
             ao.available_rooms - ob.booked
           ))::int AS free_units,
           (ao.available_rooms - ob.booked)::int AS object_free,
           COALESCE(ar.price_override, ao.price_override, r.price_per_night) AS price
      FROM accommodation_rooms r
      CROSS JOIN generate_series(${o.start}, ${o.endExclusive} - 1, INTERVAL '1 day') AS d(night)
      LEFT JOIN accommodation_availability ao
        ON ao.accommodation_id = r.accommodation_id AND ao.room_id IS NULL AND ao.date = d.night::date
      LEFT JOIN accommodation_availability ar
        ON ar.accommodation_id = r.accommodation_id AND ar.room_id = r.id AND ar.date = d.night::date
      CROSS JOIN LATERAL (
        SELECT COUNT(*)::int AS booked FROM accommodation_bookings b
         WHERE b.room_id = r.id AND ${holdsRoomSql('b')}
           AND b.check_in_date <= d.night::date AND b.check_out_date > d.night::date
           ${exclude}
      ) rb
      CROSS JOIN LATERAL (
        SELECT COUNT(*)::int AS booked FROM accommodation_bookings b
         WHERE b.accommodation_id = r.accommodation_id AND ${holdsRoomSql('b')}
           AND b.check_in_date <= d.night::date AND b.check_out_date > d.night::date
           ${exclude}
      ) ob
     WHERE r.accommodation_id = ${o.accommodation} AND r.is_active = true
       ${roomFilter}`;
}

export interface RoomNightRow {
  room_id: string;
  night: string;
  blocked: boolean;
  free_units: number;
  object_free: number | null;
  price: string | null;
}

/** Первая ночь, на которую номер продать нельзя, и почему; null — продать можно все. */
export function firstUnsellableNight(
  rows: Pick<RoomNightRow, 'night' | 'blocked' | 'free_units'>[],
): { night: string; reason: 'blocked' | 'full' } | null {
  const sorted = [...rows].sort((a, b) => a.night.localeCompare(b.night));
  for (const r of sorted) {
    if (r.blocked) return { night: r.night, reason: 'blocked' };
    if (Number(r.free_units) < 1) return { night: r.night, reason: 'full' };
  }
  return null;
}

/** Сегодняшняя дата на Камчатке — SQL-выражение. */
export const KAMCHATKA_TODAY_SQL = `(NOW() AT TIME ZONE 'Asia/Kamchatka')::date`;
