/**
 * PATCH /api/hub/operator/bookings/[id] — Update booking status
 * GET  /api/hub/operator/bookings/[id] — Get booking details
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireOperator } from '@/lib/auth/middleware';
import { query, transaction } from '@/lib/database';
import { z } from 'zod';
import { loyaltySystem } from '@/lib/loyalty/loyalty-system';
import { emailService } from '@/lib/notifications/email-service';
import { sendPushToUser } from '@/lib/notifications/web-push';
import { getOperatorPartnerId } from '@/lib/auth/operator-helpers';

export const dynamic = 'force-dynamic';

const PatchSchema = z.object({
  booking_status: z.enum(['new', 'confirmed', 'cancelled', 'completed', 'no_show']).optional(),
  cancellation_reason: z.string().max(255).optional(),
  notes: z.string().max(1000).optional(),
});

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const authOrResponse = await requireOperator(request);
    if (authOrResponse instanceof NextResponse) return authOrResponse;

    const operator_id = await getOperatorPartnerId(authOrResponse.userId);
    if (!operator_id) return NextResponse.json({ error: 'Not an operator' }, { status: 403 });

    const result = await query(
      `SELECT b.*,
              t.title as tour_title,
              t.location_name,
              t.base_price as tour_base_price
       FROM operator_bookings b
       JOIN operator_tours t ON b.operator_tour_id = t.id
       WHERE b.id = $1 AND t.operator_id = $2 AND b.deleted_at IS NULL LIMIT 1`,
      [BigInt(params.id), operator_id]
    );

    if (result.rows.length === 0) {
      return NextResponse.json({ error: 'Booking not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true, data: result.rows[0] });
  } catch (error) {
    const e = error as { code?: string; message?: string };
    console.error('[hub/operator/bookings/[id]] GET отказ:', `sqlstate=${e?.code ?? 'нет'}`, e?.message ?? String(error));
    return NextResponse.json({ error: 'Failed to fetch booking' }, { status: 500 });
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const authOrResponse = await requireOperator(request);
    if (authOrResponse instanceof NextResponse) return authOrResponse;

    const operator_id = await getOperatorPartnerId(authOrResponse.userId);
    if (!operator_id) return NextResponse.json({ error: 'Not an operator' }, { status: 403 });

    const body = await request.json();
    const input = PatchSchema.parse(body);

    // Владение, чтение прежнего статуса и запись — в ОДНОЙ транзакции под
    // блокировкой строки (FOR UPDATE). Раньше владение проверялось отдельным
    // запросом ДО записи: два параллельных PATCH (двойной клик «Завершить»)
    // оба читали «ещё не завершено» и оба начисляли лояльность/total_spent —
    // тот же класс гонки, что уже закрыт для оплаты в payments/webhook.
    // Здесь закрывается ровно эта дыра для перехода в 'completed'.
    const txResult = await transaction(async (client) => {
      const locked = await client.query(
        `SELECT b.id, b.booking_status FROM operator_bookings b
         JOIN operator_tours t ON b.operator_tour_id = t.id
         WHERE b.id = $1 AND t.operator_id = $2 AND b.deleted_at IS NULL
         FOR UPDATE OF b`,
        [BigInt(params.id), operator_id]
      );
      if (locked.rows.length === 0) {
        return { row: undefined, alreadyWasCompleted: false };
      }
      const prevStatus = (locked.rows[0] as { booking_status: string }).booking_status;

      const sets: string[] = ['updated_at = NOW()'];
      const values: unknown[] = [];
      let idx = 1;

      if (input.booking_status) {
        sets.push(`booking_status = $${idx++}`);
        values.push(input.booking_status);
        if (input.booking_status === 'cancelled') {
          sets.push(`cancelled_at = NOW()`);
        }
      }
      if (input.cancellation_reason !== undefined) {
        sets.push(`cancellation_reason = $${idx++}`);
        values.push(input.cancellation_reason);
      }
      if (input.notes !== undefined) {
        sets.push(`notes = $${idx++}`);
        values.push(input.notes);
      }

      values.push(BigInt(params.id));

      const result = await client.query(
        `UPDATE operator_bookings SET ${sets.join(', ')}
         WHERE id = $${idx}
         RETURNING id, booking_status, updated_at, tourist_email, tourist_name, final_price,
                   (SELECT title FROM operator_tours WHERE id = operator_tour_id) AS tour_title`,
        values
      );

      return { row: result.rows[0], alreadyWasCompleted: prevStatus === 'completed' };
    });

    if (!txResult.row) {
      return NextResponse.json({ error: 'Booking not found' }, { status: 404 });
    }

    const row = txResult.row as {
      tourist_email?: string; tourist_name?: string;
      final_price?: string; tour_title?: string; booking_status?: string;
    };

    // Notify tourist by email when status changes to confirmed or cancelled
    if (row.tourist_email && input.booking_status && ['confirmed', 'cancelled'].includes(input.booking_status)) {
      const isConfirmed = input.booking_status === 'confirmed';
      const subject = isConfirmed
        ? `Бронирование подтверждено: ${row.tour_title ?? 'тур'}`
        : `Бронирование отменено: ${row.tour_title ?? 'тур'}`;
      const html = isConfirmed
        ? `<h2>Ваше бронирование подтверждено!</h2>
           <p><strong>Тур:</strong> ${row.tour_title ?? ''}</p>
           <p><strong>Стоимость:</strong> ${parseFloat(row.final_price ?? '0').toLocaleString('ru-RU')} ₽</p>
           <p>Оператор свяжется с вами для уточнения деталей.</p>`
        : `<h2>Бронирование отменено</h2>
           <p><strong>Тур:</strong> ${row.tour_title ?? ''}</p>
           ${input.cancellation_reason ? `<p><strong>Причина:</strong> ${input.cancellation_reason}</p>` : ''}
           <p>Свяжитесь с оператором или выберите другой тур на <a href="https://vedarai.ru/marketplace">vedarai.ru</a>.</p>`;
      emailService.sendEmail({ to: row.tourist_email, subject, html }).catch(() => {});

      // Push notification to tourist
      const touristRes = await query<{ id: string }>(
        'SELECT id FROM users WHERE email = $1 LIMIT 1',
        [row.tourist_email],
      );
      if (touristRes.rows[0]) {
        sendPushToUser(touristRes.rows[0].id, {
          title: isConfirmed ? 'Бронирование подтверждено' : 'Бронирование отменено',
          body: isConfirmed
            ? `${row.tour_title ?? 'Тур'} — оператор подтвердил. Проверьте детали.`
            : `${row.tour_title ?? 'Тур'} — бронирование отменено.`,
          url: '/hub/tourist/bookings',
        }, {
          // Следствие действия оператора, не рассылка. Даже если push
          // подавлен настройкой, письмо выше уходит безусловно — человек
          // узнает об отмене брони в любом случае.
          kind: 'transactional',
          type: isConfirmed ? 'booking_confirmed' : 'booking_cancelled',
        }).catch(() => {});
      }
    }

    // Earn loyalty points when booking is completed — но только один раз:
    // если строка уже была 'completed' до этого PATCH (гонка/повторный
    // запрос), начисление пропускается.
    if (
      input.booking_status === 'completed' &&
      !txResult.alreadyWasCompleted &&
      row.tourist_email &&
      row.final_price
    ) {
      const userResult = await query<{ id: string }>(
        'SELECT id FROM users WHERE email = $1',
        [row.tourist_email]
      );
      if (userResult.rows[0]) {
        const uid = userResult.rows[0].id;
        const price = parseFloat(row.final_price);
        await query('UPDATE users SET total_spent = COALESCE(total_spent, 0) + $1 WHERE id = $2', [price, uid]);
        loyaltySystem.earnPoints(uid, params.id, price, 'booking').catch(() => {});
        loyaltySystem.earnActivityPoints(uid, 'first_booking', params.id).catch(() => {});
        loyaltySystem.completeReferral(uid).catch(() => {});
      }
    }

    return NextResponse.json({ success: true, data: txResult.row });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }
    const e = error as { code?: string; message?: string };
    console.error('[hub/operator/bookings/[id]] PATCH отказ:', `sqlstate=${e?.code ?? 'нет'}`, e?.message ?? String(error));
    return NextResponse.json({ error: 'Failed to update booking' }, { status: 500 });
  }
}
