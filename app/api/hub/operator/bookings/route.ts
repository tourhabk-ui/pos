/**
 * GET  /api/hub/operator/bookings — List bookings (paginated)
 * POST /api/hub/operator/bookings — Create booking (manual entry by operator)
 * Auth: operator role
 */

import { NextRequest, NextResponse } from 'next/server';
import { bookingTotal } from '@/lib/tours/booking-total';
import { requireOperator } from '@/lib/auth/middleware';
import { PaginationSchema } from '@/lib/api/operator-tours';
import { notifyNewBooking } from '@/lib/notifications/operator-booking';
import { query, transaction } from '@/lib/database';
import { insertBookingRow, type BookingRowValues } from '@/lib/bookings/reserve';
import { z } from 'zod';
import { linkContactQuietly } from '@/lib/crm/contacts';
import { leadOwnershipCond } from '@/lib/leads/ownership';
import {
  managerMay, operatorAccess, ownerOnlyDenied, permissionDenied, type OperatorAccessOk,
} from '@/lib/operators/team-access';
import { recordSourceEventQuietly, statusChangeTitle } from '@/lib/crm/events';

export const dynamic = 'force-dynamic';

const CreateBookingSchema = z.object({
  operator_tour_id: z.number().positive(),
  booking_date: z.string().date(),
  participants: z.number().int().positive().max(100),
  adult_count: z.number().int().nonnegative().optional(),
  child_count: z.number().int().nonnegative().optional(),
  tourist_name: z.string().max(255).optional(),
  tourist_phone: z.string().max(20).optional(),
  tourist_email: z.string().email().max(255).optional(),
  final_price: z.number().nonnegative().optional(),
  payment_method: z.enum(['cloudpayments', 'bank_transfer', 'cash']).optional(),
  payment_status: z.enum(['pending', 'paid']).default('pending'),
  booking_status: z.enum(['new', 'confirmed']).default('new'),
  special_requests: z.string().max(1000).optional(),
  created_via: z.enum(['website', 'direct_contact', 'api']).default('direct_contact'),
  /** Лид, из которого оператор заводит бронь (CRM фаза 2, миграция 1214). */
  lead_id: z.string().uuid().optional(),
});

/**
 * Кабинет вошедшего — свой или команды (CRM 2г): менеджер ведёт брони своего
 * оператора. null — не оператор; «не смогли проверить» — бросаем, роут
 * отвечает 500 с логом, а не «вы не оператор».
 */
async function getOperatorRow(userId: string) {
  const access = await operatorAccess(userId);
  if (access.kind === 'unavailable') throw new Error(`доступ к кабинету не проверен: ${access.reason}`);
  if (access.kind === 'none') return null;
  const result = await query<{ id: string; name: string; max_chat_id: string | null; telegram_chat_id: string | null }>(
    `SELECT p.id, p.name,
            p.max_chat_id::text AS max_chat_id,
            -- Колонка, а не contacts: её пишет привязка бота и её же читает
            -- reachForPartner. contacts->>'telegram_chat_id' не заполняет
            -- никто, и ручная бронь не доходила до Telegram оператора (25.09).
            p.telegram_chat_id::text AS telegram_chat_id
     FROM partners p WHERE p.id = $1::uuid`,
    [access.partnerId]
  );
  const row = result.rows[0];
  return row ? { ...row, access } : null;
}

export async function GET(request: NextRequest) {
  try {
    const authOrResponse = await requireOperator(request);
    if (authOrResponse instanceof NextResponse) return authOrResponse;

    const operator = await getOperatorRow(authOrResponse.userId);
    if (!operator) {
      return NextResponse.json({ error: 'Not an operator' }, { status: 403 });
    }
    const operator_id = operator.id as string;

    const { searchParams } = new URL(request.url);
    const pagination = PaginationSchema.parse({
      limit: searchParams.get('limit'),
      offset: searchParams.get('offset'),
    });

    const status = searchParams.get('status');
    const payment = searchParams.get('payment');
    const tour_id = searchParams.get('tour_id');
    const date_from = searchParams.get('date_from');
    const date_to = searchParams.get('date_to');

    const conditions: string[] = ['t.operator_id = $1', 'b.deleted_at IS NULL'];
    const params: unknown[] = [operator_id];
    let idx = 2;

    if (status) { conditions.push(`b.booking_status = $${idx++}`); params.push(status); }
    if (payment) { conditions.push(`b.payment_status = $${idx++}`); params.push(payment); }
    if (tour_id) { conditions.push(`b.operator_tour_id = $${idx++}`); params.push(BigInt(tour_id)); }
    if (date_from) { conditions.push(`b.booking_date >= $${idx++}`); params.push(date_from); }
    if (date_to) { conditions.push(`b.booking_date <= $${idx++}`); params.push(date_to); }

    const where = conditions.join(' AND ');

    const [rows, countResult] = await Promise.all([
      query(
        `SELECT
          b.id, b.operator_tour_id, t.title as tour_title,
          b.tourist_name, b.tourist_email, b.tourist_phone,
          b.booking_date::text AS booking_date, b.participants,
          b.final_price, b.currency,
          b.payment_status, b.booking_status,
          b.weather_alert_triggered, b.created_at
        FROM operator_bookings b
        JOIN operator_tours t ON b.operator_tour_id = t.id
        WHERE ${where}
        ORDER BY b.booking_date DESC, b.created_at DESC
        LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, pagination.limit, pagination.offset]
      ),
      query(
        `SELECT COUNT(*) FROM operator_bookings b
         JOIN operator_tours t ON b.operator_tour_id = t.id
         WHERE ${where}`,
        params
      ),
    ]);

    const total = parseInt(String(countResult.rows[0]?.count ?? '0'), 10);

    return NextResponse.json({
      success: true,
      data: rows.rows,
      pagination: {
        total,
        limit: pagination.limit,
        offset: pagination.offset,
        has_more: pagination.offset + rows.rows.length < total,
      },
    });
  } catch (error) {
    /**
     * Отказ не глушится (CLAUDE.md §4.0).
     *
     * 27.09: список броней оператора отвечал 500 на запрос без `?limit=`, и
     * найти причину было НЕЧЕМ — этот `catch` не писал ни строки, в логе
     * стояло только «GET ... 500». Причина оказалась в `z.coerce.number()`:
     * `Number(null)` равен нулю, `.default(20)` срабатывает лишь на
     * `undefined`, и отсутствующий параметр падал на `.min(1)`. То есть
     * ошибка разбора параметров выдавалась за поломку сервера.
     *
     * Неверный параметр — это 400 и внятное сообщение, а не 500.
     */
    if (error instanceof z.ZodError) {
      console.warn(`[hub/operator/bookings] параметры не разобраны: ${error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
      return NextResponse.json({ error: 'Неверные параметры списка' }, { status: 400 });
    }
    const code = error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : '?';
    console.error(`[hub/operator/bookings] список не отдан (SQLSTATE ${code}): ${error instanceof Error ? error.message : String(error)}`);
    return NextResponse.json({ error: 'Failed to fetch bookings' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const authOrResponse = await requireOperator(request);
    if (authOrResponse instanceof NextResponse) return authOrResponse;

    const operator = await getOperatorRow(authOrResponse.userId);
    if (!operator) {
      return NextResponse.json({ error: 'Not an operator' }, { status: 403 });
    }
    const operator_id = operator.id as string;
    const operator_name = operator.name as string;
    const telegram_chat_id = operator.telegram_chat_id as string | undefined;
    // Контакты туриста уходят оператору в MAX; Telegram — только заглушка.
    const max_chat_id = operator.max_chat_id as string | null | undefined;

    const body = await request.json();
    const input = CreateBookingSchema.parse(body);
    const tourId = BigInt(input.operator_tour_id);

    // Verify tour belongs to this operator
    const tourResult = await query(
      `SELECT id, title, base_price, price_unit, multi_day_count, duration_hours FROM operator_tours
       WHERE id = $1 AND operator_id = $2 AND deleted_at IS NULL LIMIT 1`,
      [tourId, operator_id]
    );
    if (tourResult.rows.length === 0) {
      return NextResponse.json({ error: 'Tour not found' }, { status: 404 });
    }
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

    // CRM 2г: своя цена брони — по праву can_edit_prices; «оплачено» — деньги,
    // их отмечает только владелец кабинета. Цена тура без правки — любому.
    const access: OperatorAccessOk = operator.access;
    if (input.final_price !== undefined && input.final_price !== computedTotal
        && !managerMay(access, 'can_edit_prices')) {
      return permissionDenied('can_edit_prices');
    }
    if (input.payment_status === 'paid' && access.kind !== 'owner') {
      return ownerOnlyDenied();
    }

    // Бронь из лида: лид должен быть доступен этому оператору (свой или
    // ничейный — тот же скоуп, что у /api/leads). Чужой неотличим от
    // несуществующего (404).
    let lead: { id: string; status: string } | null = null;
    if (input.lead_id) {
      const scope = await leadOwnershipCond(authOrResponse, 2);
      const leadRes = await query<{ id: string; status: string }>(
        `SELECT id::text AS id, status FROM leads WHERE id = $1::uuid${scope.cond} LIMIT 1`,
        [input.lead_id, ...scope.vals],
      );
      lead = leadRes.rows[0] ?? null;
      if (!lead) {
        return NextResponse.json({ error: 'Лид не найден' }, { status: 404 });
      }
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
      // Без лида колонка lead_id не упоминается вовсе: ручная бронь не
      // зависит от миграции 1214.
      ...(lead ? { lead_id: lead.id } : {}),
    };

    /**
     * Строка брони — общей вставкой (lib/bookings/reserve.ts, аудит 15.10,
     * P2-01). Своя вставка не писала `end_date` и `duration_days`: группа на
     * пятидневном туре, заведённая по звонку, занимала для календарей, витрины
     * дат и гейта брони только день выезда, и дни 2..N продавались снова.
     *
     * Гейта календаря и мест здесь НЕТ намеренно: оператор записывает то, о
     * чём уже договорился сам, и отказ в записи потерял бы бронь, которая всё
     * равно состоится.
     *
     * Бронь из лида и «Сделка» лиду — одной транзакцией: ничейный лид
     * становится лидом этого оператора, как при первом действии над ним
     * (app/api/leads/[id]). Без брони лид «Сделкой» не становится.
     */
    const booking = await transaction(async (client) => {
      const created = await insertBookingRow(client, row, duration);
      if (lead) {
        await client.query(
          `UPDATE leads
              SET status = 'converted', operator_id = COALESCE(operator_id, $2::uuid), updated_at = NOW()
            WHERE id = $1::uuid`,
          [lead.id, operator_id],
        );
      }
      // Ответ кабинету — прежние пять полей.
      return {
        id: created.id,
        booking_date: created.booking_date,
        participants: created.participants,
        final_price: created.final_price,
        booking_status: created.booking_status,
      };
    });

    if (lead && lead.status !== 'converted') {
      await recordSourceEventQuietly({
        kind: 'status_change', sourceKind: 'lead', sourceId: lead.id,
        actorKind: 'partner_user', actorUserId: authOrResponse.userId,
        title: statusChangeTitle('lead', lead.status, 'converted'),
        payload: { from: lead.status, to: 'converted', booking_id: String(booking.id) },
      });
    }

    // Клиент оператора в CRM (#2325): бронь, заведённая по звонку, — тоже клиент.
    await linkContactQuietly('operator_booking', booking.id as string | number);

    // Fire-and-forget Telegram notification
    notifyNewBooking({
      booking_id: String(booking.id),
      tour_title: tourTitle,
      tourist_name: input.tourist_name,
      tourist_phone: input.tourist_phone,
      tourist_email: input.tourist_email,
      booking_date: input.booking_date,
      participants: input.participants,
      final_price: finalPrice,
      operator_name,
      operator_telegram_chat_id: telegram_chat_id,
      operator_max_chat_id: max_chat_id,
      via: input.created_via,
      operator_partner_id: operator_id,
    }).catch(() => undefined);

    return NextResponse.json(
      { success: true, data: booking, message: 'Booking created' },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }
    const code = error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : '?';
    console.error(`[hub/operator/bookings] ручная бронь не заведена (SQLSTATE ${code}): ${error instanceof Error ? error.message : String(error)}`);
    return NextResponse.json({ error: 'Failed to create booking' }, { status: 500 });
  }
}
