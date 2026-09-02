/**
 * Трансферы под заказ: парк, поездки и места в них.
 *
 * ── Предметная область ─────────────────────────────────────────────────────
 *
 * Расписаний нет: джипы и вахтовки ходят под заказ — «есть заказы, туда и
 * едут» (владелец, 01.09). У перевозчика есть ПАРК: машины с местами.
 * Заказывает чаще туроператор, который везёт группу, и направление задаёт он.
 *
 * Но машина не всегда уходит под одну группу целиком: если вахтовка идёт на
 * Горелый и места остались, их выставляют в витрину. Поэтому сущностей две —
 * ПОЕЗДКА и МЕСТА В НЕЙ, а не один «заказ».
 *
 * Схема — миграция 926. Прежний модуль (восемь таблиц, маршруты, расписания,
 * водители) не восстанавливался: перепись 01.09 показала, что на проде нет ни
 * одной его таблицы, а мёртвый `lib/database/transfer_schema.sql` неполон
 * относительно кода. Восстанавливать было нечего.
 *
 * ── Две гонки и как они закрыты ────────────────────────────────────────────
 *
 * 1. Две поездки одной машины на один день — запрещает частичный уникальный
 *    индекс. Поэтому создание поездки не спрашивает «свободна ли машина», а
 *    пытается и разбирает 23505: между вопросом и вставкой помещается чужая
 *    поездка.
 * 2. Продажа мест сверх вместимости — закрывается блокировкой строки поездки
 *    (`FOR UPDATE`) на время пересчёта остатка. Прецедент репозитория —
 *    createBookingWithLock; считать свободные места без блокировки значит
 *    продать одно место дважды.
 */
import { pool } from '@/lib/db-pool';
import type { PoolClient } from 'pg';

export type TransferVehicleKind = 'jeep' | 'vahtovka' | 'minibus' | 'other';
export type TransferTripStatus = 'planned' | 'confirmed' | 'cancelled' | 'completed';
export type SeatBookingStatus = 'requested' | 'confirmed' | 'declined' | 'cancelled';

export interface TransferVehicleRow {
  id: string;
  partner_id: string;
  kind: TransferVehicleKind;
  title: string;
  seats: number;
  notes: string | null;
  is_active: boolean;
}

export interface TransferTripRow {
  id: string;
  vehicle_id: string;
  trip_date: string;
  from_text: string;
  to_text: string;
  to_place_id: string | null;
  to_route_id: string | null;
  departure_note: string | null;
  seats_total: number;
  /** null — место поштучно не продаётся (поездка ушла под одну группу). */
  price_per_seat: string | null;
  is_published: boolean;
  status: TransferTripStatus;
  comment: string | null;
}

/** Поездка витрины: с перевозчиком, техникой и ЧЕСТНЫМ остатком мест. */
export interface PublishedTrip extends TransferTripRow {
  partner_id: string;
  partner_name: string;
  vehicle_kind: TransferVehicleKind;
  vehicle_title: string;
  seats_taken: number;
  seats_free: number;
}

export interface SeatBookingRow {
  id: string;
  trip_id: string;
  ordered_by_partner_id: string | null;
  ordered_by_user_id: string | null;
  seats: number;
  price: string | null;
  status: SeatBookingStatus;
  decline_reason: string | null;
  comment: string | null;
}

export type TransferResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: TransferFailure; message: string };

export type TransferFailure =
  | 'vehicle_not_found'
  | 'vehicle_inactive'
  | 'not_your_vehicle'
  | 'seats_over_capacity'
  | 'day_taken'
  | 'trip_not_found'
  | 'trip_not_open'
  | 'not_enough_seats'
  | 'booking_not_found'
  | 'wrong_status'
  | 'db_error';

const VEHICLE_FIELDS = 'id, partner_id, kind, title, seats, notes, is_active';

const TRIP_FIELDS = `id, vehicle_id, to_char(trip_date, 'YYYY-MM-DD') AS trip_date,
  from_text, to_text, to_place_id, to_route_id, departure_note, seats_total,
  price_per_seat::text AS price_per_seat, is_published, status, comment`;

const BOOKING_FIELDS = `id, trip_id, ordered_by_partner_id, ordered_by_user_id,
  seats, price::text AS price, status, decline_reason, comment`;

// ── Парк ────────────────────────────────────────────────────────────────────

export async function listVehicles(partnerId: string): Promise<TransferVehicleRow[]> {
  const { rows } = await pool.query<TransferVehicleRow>(
    `SELECT ${VEHICLE_FIELDS} FROM transfer_fleet_vehicles
      WHERE partner_id = $1
      ORDER BY is_active DESC, title`,
    [partnerId],
  );
  return rows;
}

export async function addVehicle(input: {
  partnerId: string;
  kind: TransferVehicleKind;
  title: string;
  seats: number;
  notes?: string | null;
}): Promise<TransferVehicleRow> {
  const { rows } = await pool.query<TransferVehicleRow>(
    `INSERT INTO transfer_fleet_vehicles (partner_id, kind, title, seats, notes)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${VEHICLE_FIELDS}`,
    [input.partnerId, input.kind, input.title, input.seats, input.notes ?? null],
  );
  return rows[0]!;
}

// ── Поездки ─────────────────────────────────────────────────────────────────

export interface CreateTripInput {
  partnerId: string;
  vehicleId: string;
  tripDate: string;
  fromText: string;
  toText: string;
  toPlaceId?: string | null;
  toRouteId?: string | null;
  departureNote?: string | null;
  /** Сколько мест выставляется. Не больше вместимости машины. */
  seatsTotal: number;
  pricePerSeat?: number | null;
  isPublished?: boolean;
  comment?: string | null;
}

export async function createTrip(input: CreateTripInput): Promise<TransferResult<TransferTripRow>> {
  const vehicle = await pool.query<{ seats: number; is_active: boolean; partner_id: string }>(
    `SELECT seats, is_active, partner_id FROM transfer_fleet_vehicles WHERE id = $1`,
    [input.vehicleId],
  );
  if (vehicle.rows.length === 0) {
    return { ok: false, code: 'vehicle_not_found', message: 'Машина не найдена' };
  }
  const v = vehicle.rows[0]!;
  if (v.partner_id !== input.partnerId) {
    return { ok: false, code: 'not_your_vehicle', message: 'Машина принадлежит другому перевозчику' };
  }
  if (!v.is_active) {
    return { ok: false, code: 'vehicle_inactive', message: 'Машина снята с линии' };
  }
  // Ограничение связывает две таблицы и в CHECK не выражается. Сообщение
  // называет обе цифры: иначе перевозчик не знает, уменьшать выставленное или
  // менять машину.
  if (input.seatsTotal > v.seats) {
    return {
      ok: false,
      code: 'seats_over_capacity',
      message: `В машине ${v.seats} мест, выставлено ${input.seatsTotal}`,
    };
  }

  try {
    const { rows } = await pool.query<TransferTripRow>(
      `INSERT INTO transfer_trips
         (vehicle_id, trip_date, from_text, to_text, to_place_id, to_route_id,
          departure_note, seats_total, price_per_seat, is_published, comment)
       VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING ${TRIP_FIELDS}`,
      [
        input.vehicleId,
        input.tripDate,
        input.fromText,
        input.toText,
        input.toPlaceId ?? null,
        input.toRouteId ?? null,
        input.departureNote ?? null,
        input.seatsTotal,
        input.pricePerSeat ?? null,
        input.isPublished ?? false,
        input.comment ?? null,
      ],
    );
    return { ok: true, value: rows[0]! };
  } catch (err) {
    const e = err as { code?: string };
    // 23505 — уникальный индекс «одна живая поездка машины на дату». Это
    // названный исход, а не сбой: машина уже занята в этот день.
    if (e.code === '23505') {
      return {
        ok: false,
        code: 'day_taken',
        message: 'У этой машины уже есть поездка на выбранную дату',
      };
    }
    return failure(err, 'поездка не создана');
  }
}

/**
 * Витрина: что едет в заданные дни и сколько мест осталось.
 *
 * ── Долг будущему экрану (перенесён 01.09 из удалённого сторожа) ───────────
 *
 * У прежнего виджета трансферов был сторож `transfer-empty-state`, заведённый
 * 02.08 по жалобе туриста: поиск давал ноль расписаний, и экран молча
 * показывал пустоту, будто платформа сломана. Починка была в различении «ещё
 * не искали» и «искали, нашли ноль» — и во втором случае в предложении пути
 * (другая дата, планировщик), а не в тупике.
 *
 * Виджет удалён вместе с мёртвым модулем, сторож ушёл за предметом. Урок —
 * нет: он тот же §4.0, только на поверхности интерфейса. Функция возвращает
 * пустой массив в обоих случаях и различить их НЕ МОЖЕТ по построению — это
 * работа экрана, и он обязан её сделать, когда появится.
 *
 * Остаток считается по ПОДТВЕРЖДЁННЫМ местам. Запросы («хочу три места»)
 * ничего не держат: иначе забытая заявка блокировала бы витрину, и вахтовка
 * ехала бы полупустой при живом спросе.
 */
export async function listPublishedTrips(params: {
  fromDate: string;
  toDate: string;
  minSeats?: number;
  placeId?: string | null;
}): Promise<PublishedTrip[]> {
  const { rows } = await pool.query<PublishedTrip>(
    `SELECT t.id, t.vehicle_id, to_char(t.trip_date, 'YYYY-MM-DD') AS trip_date,
            t.from_text, t.to_text, t.to_place_id, t.to_route_id, t.departure_note,
            t.seats_total, t.price_per_seat::text AS price_per_seat,
            t.is_published, t.status, t.comment,
            v.partner_id, v.kind AS vehicle_kind, v.title AS vehicle_title,
            p.name AS partner_name,
            COALESCE(b.taken, 0)::int AS seats_taken,
            (t.seats_total - COALESCE(b.taken, 0))::int AS seats_free
       FROM transfer_trips t
       JOIN transfer_fleet_vehicles v ON v.id = t.vehicle_id
       JOIN partners p ON p.id = v.partner_id
       LEFT JOIN LATERAL (
         SELECT SUM(sb.seats) AS taken
           FROM transfer_seat_bookings sb
          WHERE sb.trip_id = t.id AND sb.status = 'confirmed'
       ) b ON true
      WHERE t.is_published
        AND t.status IN ('planned', 'confirmed')
        AND t.trip_date BETWEEN $1::date AND $2::date
        AND ($4::uuid IS NULL OR t.to_place_id = $4)
        AND (t.seats_total - COALESCE(b.taken, 0)) >= $3
      ORDER BY t.trip_date, p.name`,
    [params.fromDate, params.toDate, params.minSeats ?? 1, params.placeId ?? null],
  );
  return rows;
}

export async function setTripPublished(params: {
  tripId: string;
  partnerId: string;
  published: boolean;
}): Promise<TransferResult<TransferTripRow>> {
  const { rows } = await pool.query<TransferTripRow>(
    `UPDATE transfer_trips t
        SET is_published = $3, updated_at = NOW()
       FROM transfer_fleet_vehicles v
      WHERE t.id = $1 AND t.vehicle_id = v.id AND v.partner_id = $2
    RETURNING t.id, t.vehicle_id, to_char(t.trip_date, 'YYYY-MM-DD') AS trip_date,
              t.from_text, t.to_text, t.to_place_id, t.to_route_id, t.departure_note,
              t.seats_total, t.price_per_seat::text AS price_per_seat,
              t.is_published, t.status, t.comment`,
    [params.tripId, params.partnerId, params.published],
  );
  if (rows.length === 0) {
    return { ok: false, code: 'trip_not_found', message: 'Поездка не найдена или принадлежит другому перевозчику' };
  }
  return { ok: true, value: rows[0]! };
}

// ── Места ───────────────────────────────────────────────────────────────────

/**
 * Запрос мест. Ничего не держит — держит только подтверждение перевозчика.
 */
export async function requestSeats(input: {
  tripId: string;
  orderedByPartnerId?: string | null;
  orderedByUserId?: string | null;
  seats: number;
  comment?: string | null;
  contactPhone?: string | null;
}): Promise<TransferResult<SeatBookingRow>> {
  const trip = await pool.query<{ status: TransferTripStatus }>(
    `SELECT status FROM transfer_trips WHERE id = $1`,
    [input.tripId],
  );
  if (trip.rows.length === 0) {
    return { ok: false, code: 'trip_not_found', message: 'Поездка не найдена' };
  }
  if (!['planned', 'confirmed'].includes(trip.rows[0]!.status)) {
    return {
      ok: false,
      code: 'trip_not_open',
      message: `Поездка в статусе «${trip.rows[0]!.status}» — места в неё не запрашивают`,
    };
  }

  try {
    const { rows } = await pool.query<SeatBookingRow>(
      `INSERT INTO transfer_seat_bookings
         (trip_id, ordered_by_partner_id, ordered_by_user_id, seats, comment, contact_phone)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${BOOKING_FIELDS}`,
      [
        input.tripId,
        input.orderedByPartnerId ?? null,
        input.orderedByUserId ?? null,
        input.seats,
        input.comment ?? null,
        input.contactPhone ?? null,
      ],
    );
    return { ok: true, value: rows[0]! };
  } catch (err) {
    return failure(err, 'запрос мест не создан');
  }
}

/**
 * Подтверждение мест перевозчиком — здесь места и занимаются.
 *
 * Строка поездки блокируется на время пересчёта: между «свободно три» и
 * вставкой помещается чужое подтверждение, и без блокировки одно место
 * продалось бы дважды. Считаем и пишем под одним замком, в одной транзакции.
 */
export async function confirmSeats(params: {
  bookingId: string;
  partnerId: string;
  price?: number | null;
}): Promise<TransferResult<SeatBookingRow>> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');

    const found = await client.query<{
      trip_id: string;
      seats: number;
      status: SeatBookingStatus;
      partner_id: string;
    }>(
      `SELECT sb.trip_id, sb.seats, sb.status, v.partner_id
         FROM transfer_seat_bookings sb
         JOIN transfer_trips t ON t.id = sb.trip_id
         JOIN transfer_fleet_vehicles v ON v.id = t.vehicle_id
        WHERE sb.id = $1`,
      [params.bookingId],
    );
    if (found.rows.length === 0) {
      await client.query('ROLLBACK');
      return { ok: false, code: 'booking_not_found', message: 'Запрос мест не найден' };
    }
    const b = found.rows[0]!;
    if (b.partner_id !== params.partnerId) {
      await client.query('ROLLBACK');
      return { ok: false, code: 'not_your_vehicle', message: 'Запрос относится к чужой поездке' };
    }
    if (b.status !== 'requested') {
      await client.query('ROLLBACK');
      return {
        ok: false,
        code: 'wrong_status',
        message: `Запрос уже в статусе «${b.status}» — обработать повторно нельзя`,
      };
    }

    // Замок на поездке: остаток считается и расходуется под ним.
    const trip = await client.query<{ seats_total: number }>(
      `SELECT seats_total FROM transfer_trips WHERE id = $1 FOR UPDATE`,
      [b.trip_id],
    );
    const taken = await client.query<{ taken: string }>(
      `SELECT COALESCE(SUM(seats), 0)::text AS taken
         FROM transfer_seat_bookings
        WHERE trip_id = $1 AND status = 'confirmed'`,
      [b.trip_id],
    );
    const free = trip.rows[0]!.seats_total - parseInt(taken.rows[0]!.taken, 10);
    if (b.seats > free) {
      await client.query('ROLLBACK');
      return {
        ok: false,
        code: 'not_enough_seats',
        message: `Свободно ${free} мест, запрошено ${b.seats}`,
      };
    }

    const { rows } = await client.query<SeatBookingRow>(
      `UPDATE transfer_seat_bookings
          SET status = 'confirmed', price = COALESCE($2, price), updated_at = NOW()
        WHERE id = $1
      RETURNING ${BOOKING_FIELDS}`,
      [params.bookingId, params.price ?? null],
    );
    await client.query('COMMIT');
    return { ok: true, value: rows[0]! };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    return failure(err, 'подтверждение мест не выполнено');
  } finally {
    client.release();
  }
}

export async function declineSeats(params: {
  bookingId: string;
  partnerId: string;
  reason: string;
}): Promise<TransferResult<SeatBookingRow>> {
  try {
    const { rows } = await pool.query<SeatBookingRow>(
      `UPDATE transfer_seat_bookings sb
          SET status = 'declined', decline_reason = $3, updated_at = NOW()
         FROM transfer_trips t, transfer_fleet_vehicles v
        WHERE sb.id = $1
          AND t.id = sb.trip_id AND v.id = t.vehicle_id
          AND v.partner_id = $2
          AND sb.status = 'requested'
      RETURNING sb.id, sb.trip_id, sb.ordered_by_partner_id, sb.ordered_by_user_id,
                sb.seats, sb.price::text AS price, sb.status, sb.decline_reason, sb.comment`,
      [params.bookingId, params.partnerId, params.reason],
    );
    if (rows.length === 0) {
      // Ноль строк — три разные беды. Различаем их отдельным вопросом, иначе
      // перевозчик получит «не получилось» и не узнает, что чинить.
      const { rows: why } = await pool.query<{ status: SeatBookingStatus; partner_id: string }>(
        `SELECT sb.status, v.partner_id
           FROM transfer_seat_bookings sb
           JOIN transfer_trips t ON t.id = sb.trip_id
           JOIN transfer_fleet_vehicles v ON v.id = t.vehicle_id
          WHERE sb.id = $1`,
        [params.bookingId],
      );
      if (why.length === 0) {
        return { ok: false, code: 'booking_not_found', message: 'Запрос мест не найден' };
      }
      if (why[0]!.partner_id !== params.partnerId) {
        return { ok: false, code: 'not_your_vehicle', message: 'Запрос относится к чужой поездке' };
      }
      return {
        ok: false,
        code: 'wrong_status',
        message: `Запрос уже в статусе «${why[0]!.status}» — обработать повторно нельзя`,
      };
    }
    return { ok: true, value: rows[0]! };
  } catch (err) {
    return failure(err, 'отказ по местам не записан');
  }
}

/** Отказ БД доходит до вызывающего с SQLSTATE: он и решает, чинить или ждать. */
function failure(err: unknown, what: string): TransferResult<never> {
  const e = err as { message?: string; code?: string };
  const reason = `${e.code ? `[${e.code}] ` : ''}${e.message ?? String(err)}`;
  console.error('[transfers]', what, reason);
  return { ok: false, code: 'db_error', message: `${what}: ${reason}` };
}
