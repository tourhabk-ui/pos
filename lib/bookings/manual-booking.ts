/**
 * Ручная бронь тем, кто продаёт тур, — одно правило на две двери (#3211):
 * кабинет оператора (`POST /api/hub/operator/bookings`) и раздел «Свои туры»
 * гида-продавца (`POST /api/guide/own/bookings`, слово владельца 10.11).
 *
 * Кто вправе — решает дверь: оператор — команда и права (своя цена, отметка
 * «оплачено»), гид — владелец своей карточки. Скоуп заявки тоже даёт дверь:
 * оператору — свои и ничейные, гиду — только адресованные ему. Здесь — что
 * происходит с бронью, одинаково для обоих:
 *
 *  - тур только свой (`operator_tours.operator_id`), удалённый — не тур;
 *  - цена — `bookingTotal` тура, своя цена — по праву двери;
 *  - строка брони — общей вставкой `insertBookingRow` (конец многодневной,
 *    длительность), без гейта мест: продавец записывает то, о чём уже
 *    договорился, и отказ потерял бы бронь, которая всё равно состоится;
 *  - строка тура `FOR SHARE` до вставки: запись дат не ставит месту меньше
 *    занятого, пока идёт ручная бронь (ревью 22.10);
 *  - бронь из заявки: бронь помнит `lead_id`, заявка становится «Сделкой»
 *    («Договорились») ТОЙ ЖЕ транзакцией и уходит из «Входящих»; событие —
 *    в ленту клиента, только при настоящей смене;
 *  - клиент — в CRM продавца (`linkContactQuietly`).
 *
 * Вторая вставка брони разошлась бы с первой поведением — так уже было с
 * длительностью брони (аудит 15.10, P2-01).
 */
import { query, transaction } from '@/lib/database';
import { bookingTotal } from '@/lib/tours/booking-total';
import { insertBookingRow, type BookingRowValues } from '@/lib/bookings/reserve';
import { linkContactQuietly } from '@/lib/crm/contacts';
import { recordSourceEventQuietly, statusChangeTitle } from '@/lib/crm/events';

/** Что продавец записывает. Поля — те же, что у формы оператора. */
export interface ManualBookingInput {
  operator_tour_id: number;
  booking_date: string;
  participants: number;
  adult_count?: number;
  child_count?: number;
  tourist_name?: string;
  tourist_phone?: string;
  tourist_email?: string;
  final_price?: number;
  payment_method?: 'cloudpayments' | 'bank_transfer' | 'cash';
  payment_status: 'pending' | 'paid';
  booking_status: 'new' | 'confirmed';
  special_requests?: string;
  created_via: 'website' | 'direct_contact' | 'api';
  lead_id?: string;
}

/** Продавец тура и то, что ему разрешила дверь. */
export interface ManualBookingSeller {
  /** Карточка продавца: туры с `operator_id` = она. */
  partnerId: string;
  /** Кто нажал — в ленту клиента. */
  actorUserId: string;
  /** Своя цена брони (не цена тура). */
  mayEditPrice: boolean;
  /** Отметка «оплачено» — деньги. */
  mayMarkPaid: boolean;
  /**
   * Условие владения заявкой — SQL-хвост с нумерацией параметров с `$2`
   * (`leadScopeCond(..., 2)`). Колонка — `operator_id` таблицы leads.
   * Спрашивается только у брони из заявки: скоуп оператора читает его
   * кабинет, и бронь без заявки от этого не зависит.
   */
  leadScope: () => Promise<{ cond: string; vals: unknown[] }>;
}

/** Ответ двери — те же пять полей, что отдавал кабинет оператора. */
export interface ManualBookingRow {
  id: string | number;
  booking_date: string;
  participants: number;
  final_price: number | string;
  booking_status: string;
}

export type ManualBookingResult =
  | { kind: 'tour_not_found' }
  | { kind: 'price_denied' }
  | { kind: 'paid_denied' }
  | { kind: 'lead_not_found' }
  | { kind: 'ok'; booking: ManualBookingRow; tourTitle: string; finalPrice: number; leadId: string | null };

/**
 * Заводит ручную бронь своего тура. Отказ базы — исключение: дверь отвечает
 * «не записано» с SQLSTATE в логе, а не пустым успехом (§4.0).
 */
export async function createManualBooking(seller: ManualBookingSeller, input: ManualBookingInput): Promise<ManualBookingResult> {
  const tourId = BigInt(input.operator_tour_id);

  // Тур только свой.
  const tourResult = await query(
    `SELECT id, title, base_price, price_unit, multi_day_count, duration_hours FROM operator_tours
     WHERE id = $1 AND operator_id = $2 AND deleted_at IS NULL LIMIT 1`,
    [tourId, seller.partnerId]
  );
  if (tourResult.rows.length === 0) return { kind: 'tour_not_found' };
  const tour = tourResult.rows[0];
  const tourTitle = tour.title as string;
  const basePrice = Number(tour.base_price);
  const duration = {
    multi_day_count: tour.multi_day_count == null ? null : Number(tour.multi_day_count),
    duration_hours: tour.duration_hours == null ? null : Number(tour.duration_hours),
  };
  const computedTotal = bookingTotal({
    basePrice,
    priceUnit: tour.price_unit as string | null,
    participants: input.participants,
    duration,
  });
  const finalPrice = input.final_price ?? computedTotal;

  // Своя цена брони и «оплачено» — по праву двери. Цена тура без правки — любому.
  if (input.final_price !== undefined && input.final_price !== computedTotal && !seller.mayEditPrice) {
    return { kind: 'price_denied' };
  }
  if (input.payment_status === 'paid' && !seller.mayMarkPaid) {
    return { kind: 'paid_denied' };
  }

  // Бронь из заявки: заявка должна быть в скоупе двери. Чужая неотличима от
  // несуществующей (404).
  let lead: { id: string; status: string } | null = null;
  if (input.lead_id) {
    const scope = await seller.leadScope();
    const leadRes = await query<{ id: string; status: string }>(
      `SELECT id::text AS id, status FROM leads WHERE id = $1::uuid${scope.cond} LIMIT 1`,
      [input.lead_id, ...scope.vals],
    );
    lead = leadRes.rows[0] ?? null;
    if (!lead) return { kind: 'lead_not_found' };
  }

  const row: BookingRowValues = {
    operator_tour_id: input.operator_tour_id,
    tourist_name: input.tourist_name || null,
    tourist_phone: input.tourist_phone || null,
    tourist_email: input.tourist_email || null,
    booking_date: input.booking_date,
    participants: input.participants,
    adult_count: input.adult_count || null,
    child_count: input.child_count || null,
    base_total_price: computedTotal,
    final_price: finalPrice,
    payment_status: input.payment_status,
    payment_method: input.payment_method || null,
    booking_status: input.booking_status,
    special_requests: input.special_requests || null,
    created_via: input.created_via,
    // Без заявки колонка lead_id не упоминается вовсе: ручная бронь не
    // зависит от миграции 1214.
    ...(lead ? { lead_id: lead.id } : {}),
  };

  const booking = await transaction(async (client) => {
    await client.query('SELECT 1 FROM operator_tours WHERE id = $1 FOR SHARE', [tourId]);
    const created = await insertBookingRow(client, row, duration);
    if (lead) {
      await client.query(
        `UPDATE leads
            SET status = 'converted', operator_id = COALESCE(operator_id, $2::uuid), updated_at = NOW()
          WHERE id = $1::uuid`,
        [lead.id, seller.partnerId],
      );
    }
    return {
      id: created.id,
      booking_date: created.booking_date,
      participants: created.participants,
      final_price: created.final_price,
      booking_status: created.booking_status,
    } as ManualBookingRow;
  });

  if (lead && lead.status !== 'converted') {
    await recordSourceEventQuietly({
      kind: 'status_change', sourceKind: 'lead', sourceId: lead.id,
      actorKind: 'partner_user', actorUserId: seller.actorUserId,
      title: statusChangeTitle('lead', lead.status, 'converted'),
      payload: { from: lead.status, to: 'converted', booking_id: String(booking.id) },
    });
  }

  // Клиент продавца в CRM (#2325): бронь, заведённая по звонку, — тоже клиент.
  await linkContactQuietly('operator_booking', booking.id as string | number);

  return { kind: 'ok', booking, tourTitle, finalPrice, leadId: lead?.id ?? null };
}
