import { NextRequest, NextResponse } from 'next/server';
import { query, transaction } from '@/lib/database';
import { ApiResponse } from '@/types';
import { requireOperator } from '@/lib/auth/middleware';
import { getOperatorPartnerId } from '@/lib/auth/operator-helpers';
import { z } from 'zod';
import { releaseSlotsForCancelledBooking } from '@/lib/payments/slot-counter';

const UpdateBookingSchema = z.object({
  status: z.enum(['pending', 'confirmed', 'completed', 'cancelled'], { message: 'Неверный статус бронирования' }).optional(),
  paymentStatus: z.enum(['pending', 'paid', 'refunded'], { message: 'Неверный статус оплаты' }).optional(),
  notes: z.string().optional(),
}).refine(
  (data) => data.status !== undefined || data.paymentStatus !== undefined || data.notes !== undefined,
  { message: 'Укажите хотя бы одно поле для обновления' }
);

export const dynamic = 'force-dynamic';

/**
 * PUT /api/operator/bookings/[id]
 * Update booking status with ownership verification
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const operatorOrResponse = await requireOperator(request);
    if (operatorOrResponse instanceof NextResponse) {
      return operatorOrResponse;
    }
    const userId = operatorOrResponse.userId;
    const operatorId = await getOperatorPartnerId(userId);
    if (!operatorId) {
      return NextResponse.json({
        success: false,
        error: 'Партнёрский профиль оператора не найден'
      } as ApiResponse<null>, { status: 404 });
    }

    const { id } = await params;

    const body = await request.json();
    const parsed = UpdateBookingSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ success: false, error: parsed.error.issues[0]?.message || 'Некорректные данные' }, { status: 400 });
    }
    const { status, paymentStatus, notes } = parsed.data;

    // Build update query
    const updateFields: string[] = [];
    const updateValues: unknown[] = [];
    let paramIndex = 1;

    if (status) {
      updateFields.push(`booking_status = $${paramIndex++}`);
      updateValues.push(status);
      // Отметка времени отмены ставилась здесь НЕ везде, а тревога о
      // придержанных деньгах считает срок именно от неё (Watchdog,
      // checkHeldForCancelled). Без отметки платёж отменённой брони попадал
      // бы в счёт по `updated_at` — то есть по последнему любому изменению.
      if (status === 'cancelled') updateFields.push('cancelled_at = NOW()');
    }

    if (paymentStatus) {
      updateFields.push(`payment_status = $${paramIndex++}`);
      updateValues.push(paymentStatus);
    }

    if (notes !== undefined) {
      updateFields.push(`special_requests = $${paramIndex++}`);
      updateValues.push(notes);
    }

    if (updateFields.length === 0) {
      return NextResponse.json({
        success: false,
        error: 'Нет полей для обновления'
      } as ApiResponse<null>, { status: 400 });
    }

    const bookingIdParamIndex = paramIndex++;
    const operatorIdParamIndex = paramIndex;
    updateValues.push(id);
    updateValues.push(operatorId);

    // Запись и возврат мест — в ОДНОЙ транзакции под блокировкой строки.
    // Раньше здесь был одиночный `query()`: отмена меняла статус и не
    // возвращала место, а счётчик `booked_slots` умеет только расти — одного
    // цикла «выкупили — отменили» хватало, чтобы дата тура больше не приняла
    // оплату (#1816).
    //
    // Прежний статус читается ПОД блокировкой, а не условием в самом UPDATE,
    // и это не стилистика. Условие вида «поменяй, если статус другой» на
    // повторном PATCH не меняет ни одной строки — и роут ниже ответил бы 404
    // «Бронирование не найдено» у существующей брони. Одна выдуманная
    // причина вместо другой; блокировка даёт настоящую (§4.0).
    const result = await transaction(async (client) => {
      const locked = await client.query<{ booking_status: string }>(
        `SELECT ob.booking_status
           FROM operator_bookings ob
           JOIN operator_tours t ON t.id = ob.operator_tour_id
          WHERE ob.id = $1 AND t.operator_id = $2 AND t.deleted_at IS NULL
          FOR UPDATE OF ob`,
        [id, operatorId]
      );
      if (locked.rows.length === 0) return { rows: [] as Record<string, unknown>[] };
      const prevStatus = locked.rows[0].booking_status;

      const upd = await client.query(
        `UPDATE operator_bookings
         SET ${updateFields.join(', ')}
         FROM operator_tours t
         WHERE operator_bookings.id = $${bookingIdParamIndex}
           AND operator_bookings.operator_tour_id = t.id
           AND t.operator_id = $${operatorIdParamIndex}
           AND t.deleted_at IS NULL
         RETURNING *`,
        updateValues
      );

      // Вычитание — только на НАСТОЯЩЕМ переходе в отменённое. Сам
      // `releaseSlots...` фильтрует по `payment_status = 'paid'`, поэтому у
      // неоплаченной брони это холостой ход.
      if (status === 'cancelled' && prevStatus !== 'cancelled' && upd.rows.length > 0) {
        await releaseSlotsForCancelledBooking(client, id);
      }
      return upd;
    });

    if (result.rows.length === 0) {
      return NextResponse.json({
        success: false,
        error: 'Бронирование не найдено'
      } as ApiResponse<null>, { status: 404 });
    }

    // Create notification for status change
    if (status) {
      const booking = result.rows[0];
      await query(
        `INSERT INTO notifications (user_id, type, title, message, priority, action_url)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          booking.user_id,
          'booking_status_changed',
          'Статус бронирования изменён',
          `Статус вашего бронирования изменён на: ${status}`,
          status === 'cancelled' ? 'high' : 'normal',
          `/hub/tourist/bookings/${id}`
        ]
      );
    }

    return NextResponse.json({
      success: true,
      data: result.rows[0],
      message: 'Бронирование успешно обновлено'
    } as ApiResponse<unknown>);

  } catch (error) {
    // Причина отказа не терялась молча: этот роут меняет статус брони и
    // возвращает места, и «Ошибка при обновлении» без SQLSTATE отправляет
    // искать наугад (§4.0).
    const { id: failedId } = await params.catch(() => ({ id: 'неизвестен' }));
    const e = error as { code?: string; message?: string };
    console.error(
      '[operator/bookings/[id]] PUT отказ:',
      `booking=${failedId}`,
      `sqlstate=${e?.code ?? 'нет'}`,
      e?.message ?? String(error),
    );
    return NextResponse.json({
      success: false,
      error: 'Ошибка при обновлении бронирования'
    } as ApiResponse<null>, { status: 500 });
  }
}
