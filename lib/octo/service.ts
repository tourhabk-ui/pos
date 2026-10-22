/**
 * OCTO API — Service layer
 * SQL queries and transactions for OCTO endpoints.
 * Column names match actual DB schema (operator_tours, operator_bookings, tour_availability).
 */

import { occupiedOnDaySql } from '@/lib/bookings/occupancy';
import { tourDurationDays, tourEndDate } from '@/lib/bookings/duration';
import {
  assertDaysOpen, insertBookingRow, readTourDays, ReserveError, tourDurationOf,
} from '@/lib/bookings/reserve';
import { pool } from '@/lib/db-pool';
import { publicTourSql } from '@/lib/tours/public-visibility';
import { notifyOctoWebhooks } from '@/lib/octo/webhooks';
import { linkContactQuietly } from '@/lib/crm/contacts';
import { recordSourceEventQuietly, statusChangeTitle } from '@/lib/crm/events';

// isRealTour убрана 22.08.2026 (перепись).
//
// Проверяла «настоящность» тура: есть оператор, календарь, заполненные поля,
// фото. Не звалась, и витрина показывает что есть. Стандарт «настоящего тура»
// — правило продукта, и жить ему в одном месте с витриной, а не отдельной
// функцией, о которой витрина не знает.

// Каждый отбор тура здесь — для чужой площадки (реселлер OCTO), поэтому тур
// берётся шлюзом витрины (#2642), включая дверь холда под FOR UPDATE.
// Копии смотрели is_published и deleted_at без is_active: выключенный
// оператором тур продавался каналом, хотя кабинет говорил «Скрыт».

// --- Suppliers ---

export async function getSuppliers(operatorId?: string | null) {
  const params: unknown[] = [];
  let extra = '';
  if (operatorId) {
    params.push(operatorId);
    extra = `AND p.id = $${params.length}`;
  }

  const { rows } = await pool.query(
    `SELECT p.id, p.company_name AS name, p.slug, p.description, p.contacts
     FROM partners p
     WHERE p.is_public = true
       AND EXISTS (
         SELECT 1 FROM operator_tours ot
         WHERE ot.operator_id = p.id AND ${publicTourSql('ot')}
           AND ot.title IS NOT NULL AND ot.description IS NOT NULL
           AND ot.base_price > 0 AND ot.location_type IS NOT NULL
           AND ot.activity_type IS NOT NULL AND ot.max_participants > 0
           AND (ot.tour_image IS NOT NULL OR ot.photos IS NOT NULL)
           AND EXISTS (
             SELECT 1 FROM tour_availability ta
             WHERE ta.operator_tour_id = ot.id
               AND ta.available_slots > 0
               AND ta.is_cancelled = false
               AND ta.deleted_at IS NULL
           )
       )
       ${extra}
     ORDER BY p.company_name`,
    params
  );
  return rows;
}

export async function getSupplierById(supplierId: string) {
  const { rows } = await pool.query(
    `SELECT p.id, p.company_name AS name, p.slug, p.description, p.contacts
     FROM partners p
     WHERE p.id = $1 AND p.is_public = true`,
    [supplierId]
  );
  return rows[0] ?? null;
}

// --- Products ---

export async function getProducts(operatorId?: string | null) {
  const params: unknown[] = [];
  let extra = '';
  if (operatorId) {
    params.push(operatorId);
    extra = `AND ot.operator_id = $${params.length}`;
  }

  const { rows } = await pool.query(
    `SELECT ot.id, ot.title, ot.description, ot.location_type, ot.activity_type,
            ot.base_price, ot.duration_hours, ot.season_start, ot.season_end,
            ot.latitude, ot.longitude, ot.max_participants,
            p.company_name AS partner_name, p.id AS partner_id
     FROM operator_tours ot
     LEFT JOIN partners p ON p.id = ot.operator_id
     WHERE ${publicTourSql('ot')}
       AND ot.operator_id IS NOT NULL
       AND ot.title IS NOT NULL AND ot.description IS NOT NULL
       AND ot.base_price > 0 AND ot.location_type IS NOT NULL
       AND ot.activity_type IS NOT NULL AND ot.max_participants > 0
       AND (ot.tour_image IS NOT NULL OR ot.photos IS NOT NULL)
       AND EXISTS (
         SELECT 1 FROM tour_availability ta
         WHERE ta.operator_tour_id = ot.id
           AND ta.available_slots > 0
           AND ta.is_cancelled = false
           AND ta.deleted_at IS NULL
       )
       ${extra}
     ORDER BY ot.title`,
    params
  );
  return rows;
}

export async function getProductById(productId: string) {
  const { rows } = await pool.query(
    `SELECT ot.id, ot.title, ot.description, ot.location_type, ot.activity_type,
            ot.base_price, ot.duration_hours, ot.season_start, ot.season_end,
            ot.latitude, ot.longitude, ot.max_participants,
            p.company_name AS partner_name, p.id AS partner_id
     FROM operator_tours ot
     LEFT JOIN partners p ON p.id = ot.operator_id
     WHERE ot.id = $1 AND ${publicTourSql('ot')}
       AND ot.operator_id IS NOT NULL
       AND ot.title IS NOT NULL AND ot.description IS NOT NULL
       AND ot.base_price > 0 AND ot.location_type IS NOT NULL
       AND ot.activity_type IS NOT NULL AND ot.max_participants > 0
       AND (ot.tour_image IS NOT NULL OR ot.photos IS NOT NULL)
       AND EXISTS (
         SELECT 1 FROM tour_availability ta
         WHERE ta.operator_tour_id = ot.id
           AND ta.available_slots > 0
           AND ta.is_cancelled = false
           AND ta.deleted_at IS NULL
       )`,
    [productId]
  );
  return rows[0] ?? null;
}

export async function getProductOptions(productId: string) {
  const { rows } = await pool.query(
    `SELECT id, internal_name, is_default, price_adult, price_child, price_youth,
            max_units, min_units, restrictions
     FROM tour_options
     WHERE operator_tour_id = $1 AND is_active = true
     ORDER BY is_default DESC, id`,
    [productId]
  );
  return rows;
}

// --- Availability ---

export async function checkAvailability(
  productId: string,
  optionId: string,
  dateStart: string,
  dateEnd: string
) {
  // Get explicit calendar slots. Занятость (booked_slots для мапперов) —
  // из реальных броней, не из счётчика: счётчик пишет только payment-webhook
  // («оплаченные»), и OCTO-канал отдавал бы резселлерам завышенные остатки.
  const { rows: slots } = await pool.query(
    `SELECT ta.id, ta.date::text AS date, ta.available_slots, occ.taken AS booked_slots,
            ta.base_price_override, ot.base_price
     FROM tour_availability ta
     JOIN operator_tours ot ON ot.id = ta.operator_tour_id
     CROSS JOIN LATERAL (
       ${occupiedOnDaySql({ booking: 'ob', day: 'ta.date', tourId: 'ta.operator_tour_id' })}
     ) occ
     WHERE ta.operator_tour_id = $1
       AND ta.date BETWEEN $2 AND $3
       AND ta.is_cancelled = false
       AND (ta.deleted_at IS NULL)
     ORDER BY ta.date`,
    [productId, dateStart, dateEnd]
  );

  if (slots.length > 0) {
    return { mode: 'calendar' as const, slots };
  }

  // FREESALE: no calendar entries — return all dates in range as available
  const { rows: tourRows } = await pool.query(
    `SELECT base_price, season_start, season_end, max_participants, duration_hours
     FROM operator_tours
     WHERE id = $1 AND ${publicTourSql('')}`,
    [productId]
  );

  if (tourRows.length === 0) return { mode: 'empty' as const, slots: [] };

  const tour = tourRows[0];
  return {
    mode: 'freesale' as const,
    basePrice: tour.base_price,
    seasonStart: tour.season_start,
    seasonEnd: tour.season_end,
    maxParticipants: tour.max_participants,
    durationHours: tour.duration_hours,
  };
}

// --- Bookings ---

export async function createBooking(data: {
  tourId: string;
  optionId: string;
  availabilityId: string;
  bookingDate: string;
  adultCount: number;
  childCount: number;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  notes?: string;
  apiKeyId: string;
  /** Оператор, под которого выдан ключ; NULL — ключ на всех операторов. */
  operatorId: string | null;
  resellerReference?: string;
}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Idempotency: resellerReference (если передан) или availabilityId + apiKeyId
    const idempotencyQuery = data.resellerReference
      ? `SELECT octo_uuid FROM operator_bookings
         WHERE reseller_reference = $1 AND octo_api_key_id = $2 AND deleted_at IS NULL`
      : `SELECT octo_uuid FROM operator_bookings
         WHERE availability_id = $1 AND octo_api_key_id = $2 AND deleted_at IS NULL`;
    const idempotencyParam = data.resellerReference ?? data.availabilityId;
    const { rows: existing } = await client.query(idempotencyQuery, [idempotencyParam, data.apiKeyId]);
    if (existing.length > 0) {
      await client.query('ROLLBACK');
      const full = await getBookingByUuid(existing[0].octo_uuid, data.apiKeyId);
      return { booking: full, idempotent: true };
    }

    // Тур есть — и строка тура под замком на всю транзакцию. Тот же лок
    // берёт reserveBooking: холд реселлера и бронь туриста с сайта на ту же
    // дату идут друг за другом, а не читают одну и ту же занятость (аудит
    // 15.10, P2-01).
    //
    // Ключ, выданный под оператора, видит в списке только его туры
    // (getProducts) — и холд ставит только на них. Без этого условия ключ
    // оператора А держал по 30 минут даты оператора Б: холд занимает места
    // наравне с бронью (аудит 22.10). Чужой тур — как несуществующий.
    const { rows: tourRows } = await client.query(
      `SELECT id, base_price, title, max_participants, multi_day_count, duration_hours
         FROM operator_tours
        WHERE id = $1 AND ${publicTourSql('')}
          AND ($2::uuid IS NULL OR operator_id = $2::uuid)
        FOR UPDATE`,
      [data.tourId, data.operatorId]
    );
    if (tourRows.length === 0) {
      await client.query('ROLLBACK');
      return { error: 'PRODUCT_NOT_FOUND' };
    }

    // Check option
    const { rows: optionRows } = await client.query(
      `SELECT id, price_adult, price_child FROM tour_options
       WHERE id = $1 AND operator_tour_id = $2 AND is_active = true`,
      [data.optionId, data.tourId]
    );
    if (optionRows.length === 0) {
      await client.query('ROLLBACK');
      return { error: 'OPTION_NOT_FOUND' };
    }

    const adultPrice = Number(optionRows[0].price_adult ?? tourRows[0].base_price);
    const childPrice = Number(optionRows[0].price_child ?? tourRows[0].base_price * 0.7);
    const totalPrice = adultPrice * data.adultCount + childPrice * data.childCount;
    const participants = data.adultCount + data.childCount;
    const holdExpiresAt = new Date(Date.now() + 30 * 60_000).toISOString();

    /**
     * Гейт — ОБЩИЙ с reserveBooking (аудит 15.10, P2-01): календарь и
     * занятость по каждому дню диапазона тура, интервалом.
     *
     * Здесь стоял свой счёт: `booking_date = $2` по одному дню и только если
     * у дня выезда есть строка календаря, взятая `FOR UPDATE SKIP LOCKED`.
     * Многодневный тур реселлер продавал поверх чужой группы на днях 2..N;
     * без строки календаря `max_participants` тура не проверялся вовсе; а
     * при гонке занятая строка ПРОПУСКАЛАСЬ, и проверки не было совсем.
     *
     * Занятость по-прежнему из реальных броней, а не из счётчика
     * `booked_slots`: его единственный писатель — payment-webhook
     * («оплаченные участники», #336), и холд его не трогает.
     *
     * Ответ реселлеру прежний: любой отказ гейта — AVAILABILITY_SOLD_OUT.
     */
    const duration = tourDurationOf(tourRows[0]);
    const durationDays = tourDurationDays(duration);
    const days = await readTourDays(
      client, data.tourId, data.bookingDate, tourEndDate(data.bookingDate, durationDays),
    );
    try {
      assertDaysOpen(days, {
        participants,
        maxParticipants: tourRows[0].max_participants == null ? null : Number(tourRows[0].max_participants),
        durationDays,
      });
    } catch (err) {
      if (!(err instanceof ReserveError)) throw err;
      await client.query('ROLLBACK');
      return { error: 'AVAILABILITY_SOLD_OUT' };
    }

    // Строка брони — общей вставкой: `end_date` и `duration_days` она выводит
    // сама. Своя вставка писала многодневный холд однодневным, и для всех
    // поверхностей занятости дни 2..N оставались свободными.
    const inserted = await insertBookingRow(client, {
      operator_tour_id: data.tourId,
      booking_date: data.bookingDate,
      participants,
      adult_count: data.adultCount,
      child_count: data.childCount,
      base_total_price: totalPrice,
      final_price: totalPrice,
      booking_status: 'new',
      tourist_name: data.contactName ?? null,
      tourist_email: data.contactEmail ?? null,
      tourist_phone: data.contactPhone ?? null,
      special_requests: data.notes ?? null,
      octo_api_key_id: data.apiKeyId,
      option_id: data.optionId,
      hold_expires_at: holdExpiresAt,
      availability_id: data.availabilityId,
      reseller_reference: data.resellerReference ?? null,
      created_via: 'api',
    }, duration);
    // Форма прежняя — те же четыре поля, что отдавал RETURNING своей вставки.
    const booking = {
      id: inserted.id,
      octo_uuid: inserted.octo_uuid,
      booking_status: inserted.booking_status,
      created_at: inserted.created_at,
    };

    // Audit log
    await client.query(
      `INSERT INTO octo_booking_log (booking_id, action, api_key_id, request_body)
       VALUES ($1, 'CREATE', $2, $3)`,
      [booking.id, data.apiKeyId, JSON.stringify(data)]
    );

    await client.query('COMMIT');

    // Клиент оператора в CRM (#2325): бронь реселлера — тоже клиент оператора.
    await linkContactQuietly('operator_booking', booking.id as string | number);

    // Webhook notification (fire-and-forget)
    const fullBooking = await getBookingByUuid(booking.octo_uuid, data.apiKeyId);
    notifyOctoWebhooks('booking:created', booking.id, fullBooking ?? {}).catch(() => {});

    return { booking };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Бронь глазами ключа, который её создал. Чужая — как несуществующая (404).
 *
 * `octo_uuid` проставляется умолчанием КАЖДОЙ строке operator_bookings (050),
 * включая брони туристов с сайта. Пока выборка шла по одному номеру, любой
 * действующий ключ читал по нему имя, почту и телефон туриста, а в соседних
 * функциях подтверждал, отменял и отмечал неявку — у чужой брони, у брони
 * другого реселлера и у брони с сайта, где ключа нет вовсе (аудит 22.10).
 * Номер — не пропуск: доступ даёт ключ, записанный в бронь при создании.
 */
export async function getBookingByUuid(octoUuid: string, apiKeyId: string) {
  const { rows } = await pool.query(
    `SELECT ob.id, ob.octo_uuid, ob.booking_status, ob.booking_date::text AS booking_date,
            ob.participants, ob.adult_count, ob.child_count,
            ob.final_price, ob.currency, ob.tourist_name, ob.tourist_email,
            ob.tourist_phone, ob.special_requests, ob.hold_expires_at::text AS hold_expires_at,
            ob.availability_id,
            ob.created_at::text AS created_at, ob.updated_at::text AS updated_at,
            ob.option_id, ob.operator_tour_id,
            ot.title AS tour_title, ot.duration_hours,
            topt.internal_name AS option_name
     FROM operator_bookings ob
     JOIN operator_tours ot ON ot.id = ob.operator_tour_id
     LEFT JOIN tour_options topt ON topt.id = ob.option_id
     WHERE ob.octo_uuid = $1 AND ob.octo_api_key_id = $2 AND ob.deleted_at IS NULL`,
    [octoUuid, apiKeyId]
  );
  return rows[0] ?? null;
}

export async function confirmBooking(octoUuid: string, apiKeyId: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Only confirm if ON_HOLD (new) and hold not yet expired.
    // Только бронь этого ключа — см. getBookingByUuid.
    const { rows } = await client.query(
      `UPDATE operator_bookings
       SET booking_status = 'confirmed', hold_expires_at = NULL, updated_at = NOW()
       WHERE octo_uuid = $1 AND octo_api_key_id = $2
         AND booking_status = 'new' AND deleted_at IS NULL
         AND (hold_expires_at IS NULL OR hold_expires_at > NOW())
       RETURNING id, octo_uuid`,
      [octoUuid, apiKeyId]
    );

    if (rows.length === 0) {
      await client.query('ROLLBACK');
      // Differentiate: expired hold vs not found vs already confirmed.
      // Чужая бронь — «не найдена»: её статус ключу не сообщается.
      const { rows: check } = await client.query(
        `SELECT booking_status, hold_expires_at
         FROM operator_bookings
         WHERE octo_uuid = $1 AND octo_api_key_id = $2 AND deleted_at IS NULL`,
        [octoUuid, apiKeyId]
      );
      if (check.length > 0 && check[0].booking_status === 'new') {
        return { error: 'HOLD_EXPIRED' as const };
      }
      if (check.length > 0 && check[0].booking_status === 'confirmed') {
        return { error: 'ALREADY_CONFIRMED' as const };
      }
      return null;
    }

    await client.query(
      `INSERT INTO octo_booking_log (booking_id, action, api_key_id)
       VALUES ($1, 'CONFIRM', $2)`,
      [rows[0].id, apiKeyId]
    );

    await client.query('COMMIT');

    await recordSourceEventQuietly({
      kind: 'status_change', sourceKind: 'operator_booking', sourceId: rows[0].id as string | number,
      actorKind: 'system', title: statusChangeTitle('operator_booking', 'new', 'confirmed'),
      payload: { from: 'new', to: 'confirmed', channel: 'octo' },
    });

    const confirmed = rows[0];
    const fullBooking = await getBookingByUuid(octoUuid, apiKeyId);
    notifyOctoWebhooks('booking:confirmed', confirmed.id, fullBooking ?? {}).catch(() => {});

    return confirmed;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function cancelBooking(octoUuid: string, apiKeyId: string, reason?: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Только бронь этого ключа — см. getBookingByUuid. Без условия по ключу
    // любой реселлер отменял по номеру и брони туристов с сайта.
    const { rows } = await client.query(
      `UPDATE operator_bookings
       SET booking_status = 'cancelled', cancellation_reason = $2,
           cancelled_at = NOW(), updated_at = NOW()
       WHERE octo_uuid = $1 AND octo_api_key_id = $3
         AND booking_status IN ('new', 'confirmed') AND deleted_at IS NULL
       RETURNING id, octo_uuid, operator_tour_id, booking_date, participants`,
      [octoUuid, reason ?? null, apiKeyId]
    );

    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }

    const booking = rows[0];

    // booked_slots НЕ трогаем — контракт канала, замороженный намеренно
    // (#336, сторож tests/unit/octo-no-counter-writes.test.ts): OCTO пишет
    // холды, а счётчик несёт смысл «оплаченные участники», и инкремент на
    // неоплаченном холде уже смешивал семантику и грозил переполнением CHECK
    // на смешанных каналах. Прежний декремент вдобавок выбирал ПРОИЗВОЛЬНЫЙ
    // слот (WHERE booked_slots > 0 LIMIT 1) и портил чужие дни.
    //
    // 11.09 я подключил сюда общее вычитание (#1816) и был неправ: оно
    // холостое по построению (`releaseSlotsForCancelledBooking` фильтрует по
    // payment_status = 'paid', а такие брони канал не создаёт), зато молча
    // переезжало чужое обдуманное решение. Посылка «эта бронь не могла быть
    // оплачена через наш вебхук» теперь не в моей памяти, а в реестре
    // tests/unit/cancel-releases-slots.test.ts — вместе с условием, при
    // котором её придётся пересмотреть.
    await client.query(
      `INSERT INTO octo_booking_log (booking_id, action, api_key_id, request_body)
       VALUES ($1, 'CANCEL', $2, $3)`,
      [booking.id, apiKeyId, reason ? JSON.stringify({ reason }) : null]
    );

    await client.query('COMMIT');

    await recordSourceEventQuietly({
      kind: 'status_change', sourceKind: 'operator_booking', sourceId: rows[0].id as string | number,
      actorKind: 'system', title: statusChangeTitle('operator_booking', null, 'cancelled'),
      payload: { to: 'cancelled', channel: 'octo', reason: reason ?? null },
    });

    const fullBooking = await getBookingByUuid(octoUuid, apiKeyId);
    notifyOctoWebhooks('booking:cancelled', booking.id, fullBooking ?? {}).catch(() => {});

    return booking;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
