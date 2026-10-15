import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { transaction } from '@/lib/database';
import { ApiResponse } from '@/types';
import { requireAuth } from '@/lib/auth/middleware';
import { verifyGearRentalOwnership } from '@/lib/auth/gear-helpers';
import { recordSourceEventQuietly, statusChangeTitle } from '@/lib/crm/events';
import { gearPeakSql, GEAR_PENDING_HOLD_HOURS } from '@/lib/gear/availability';
import { logSwallowedFailure } from '@/lib/observability/swallowed';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid('Некорректный ID аренды') });

const UpdateRentalStatusSchema = z.object({
  status: z.enum(['confirmed', 'active', 'completed', 'cancelled', 'overdue'], {
    message: 'Некорректный статус',
  }),
});

// Жизненный цикл аренды: заявка → подтверждение → выдача → возврат.
// completed и cancelled — терминальные, из них переходов нет.
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['active', 'cancelled'],
  active: ['completed', 'overdue'],
  overdue: ['completed'],
  completed: [],
  cancelled: [],
};

/**
 * PATCH /api/gear/rentals/[id] - Смена статуса аренды (владелец снаряжения или admin)
 *
 * Инвентарные эффекты:
 *   → active: available_quantity уменьшается, rental_count растёт (снаряжение выдано)
 *   → completed: available_quantity возвращается, total_revenue растёт (снаряжение возвращено)
 *
 * Подтверждение заявки перепроверяет занятость (аудит 15.10, A13): заявка
 * держит единицу только 48 часов (lib/gear/availability), и за это время
 * единицу могла занять чужая заявка. Перепроверка — под тем же ключом
 * позиции, что и новая заявка (POST /api/gear/rentals), иначе подтверждение
 * и новая заявка разошлись бы на последней единице.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authResult = await requireAuth(request);
    if (authResult instanceof NextResponse) return authResult;
    const userId = authResult.userId;
    const isAdmin = authResult.role === 'admin';

    const parsedParams = paramsSchema.safeParse(await params);
    if (!parsedParams.success) {
      return NextResponse.json(
        { success: false, error: 'Некорректный ID аренды' } as ApiResponse<null>,
        { status: 400 }
      );
    }
    const rentalId = parsedParams.data.id;

    if (!isAdmin) {
      const owns = await verifyGearRentalOwnership(userId, rentalId);
      if (!owns) {
        return NextResponse.json(
          { success: false, error: 'Аренда не найдена' } as ApiResponse<null>,
          { status: 404 }
        );
      }
    }

    const body = await request.json();
    const parsed = UpdateRentalStatusSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: parsed.error.issues[0]?.message || 'Некорректные данные' } as ApiResponse<null>,
        { status: 400 }
      );
    }
    const nextStatus = parsed.data.status;

    const outcome = await transaction(async (client) => {
      const rentalResult = await client.query(
        `SELECT id, gear_id, quantity, total_price, status,
                start_date::text AS start_date, end_date::text AS end_date
         FROM gear_rentals
         WHERE id = $1
         FOR UPDATE`,
        [rentalId]
      );

      if (rentalResult.rows.length === 0) {
        return { code: 404 as const };
      }

      const rental = rentalResult.rows[0] as {
        id: string; gear_id: string; quantity: number;
        total_price: string; status: string;
        start_date: string; end_date: string;
      };

      const allowed = ALLOWED_TRANSITIONS[rental.status] ?? [];
      if (!allowed.includes(nextStatus)) {
        return { code: 422 as const, currentStatus: rental.status };
      }

      if (rental.status === 'pending' && nextStatus === 'confirmed') {
        await client.query(`SELECT pg_advisory_xact_lock(hashtext($1::text))`, [rental.gear_id]);
        const stock = await client.query<{ quantity: number }>(
          `SELECT quantity FROM gear_items WHERE id = $1`,
          [rental.gear_id]
        );
        const peak = await client.query<{ peak_rented: string }>(
          gearPeakSql({ gear: '$1', start: '$2::date', endExclusive: '$3::date', excludeRental: '$4' }),
          [rental.gear_id, rental.start_date, rental.end_date, rental.id]
        );
        const peakRented = parseInt(peak.rows[0]?.peak_rented ?? '0', 10);
        const total = Number(stock.rows[0]?.quantity ?? 0);
        if (peakRented + Number(rental.quantity) > total) {
          return { code: 409 as const, free: Math.max(0, total - peakRented) };
        }
      }

      const updated = await client.query(
        `UPDATE gear_rentals SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
        [nextStatus, rentalId]
      );

      if (nextStatus === 'active') {
        await client.query(
          `UPDATE gear_items
           SET available_quantity = GREATEST(0, available_quantity - $1),
               rental_count = rental_count + 1,
               updated_at = NOW()
           WHERE id = $2`,
          [rental.quantity, rental.gear_id]
        );
      } else if (nextStatus === 'completed') {
        await client.query(
          `UPDATE gear_items
           SET available_quantity = LEAST(quantity, available_quantity + $1),
               total_revenue = total_revenue + $2,
               updated_at = NOW()
           WHERE id = $3`,
          [rental.quantity, rental.total_price, rental.gear_id]
        );
      }

      return { code: 200 as const, rental: updated.rows[0], prevStatus: rental.status };
    });

    if (outcome.code === 404) {
      return NextResponse.json(
        { success: false, error: 'Аренда не найдена' } as ApiResponse<null>,
        { status: 404 }
      );
    }

    if (outcome.code === 409) {
      return NextResponse.json(
        {
          success: false,
          error: (outcome.free > 0
            ? `На даты этой заявки свободно только ${outcome.free} шт. — подтвердить её целиком нельзя. `
            : 'На даты этой заявки снаряжение уже занято — подтвердить её нельзя. ')
            + `Заявка без ответа держит снаряжение ${GEAR_PENDING_HOLD_HOURS} часов, потом его могут взять другие.`,
        } as ApiResponse<null>,
        { status: 409 }
      );
    }

    if (outcome.code === 422) {
      return NextResponse.json(
        {
          success: false,
          error: `Переход из статуса «${outcome.currentStatus}» в «${nextStatus}» невозможен`
        } as ApiResponse<null>,
        { status: 422 }
      );
    }

    await recordSourceEventQuietly({
      kind: 'status_change', sourceKind: 'gear_rental', sourceId: rentalId,
      actorKind: 'partner_user', actorUserId: authResult.userId,
      title: statusChangeTitle('gear_rental', outcome.prevStatus, nextStatus),
      payload: { from: outcome.prevStatus, to: nextStatus },
    });

    return NextResponse.json({
      success: true,
      data: outcome.rental,
      message: 'Статус аренды обновлён'
    } as ApiResponse<unknown>);

  } catch (error) {
    logSwallowedFailure('gear-rentals', 'смена статуса аренды', error);
    return NextResponse.json(
      { success: false, error: 'Ошибка при обновлении статуса аренды' } as ApiResponse<null>,
      { status: 500 }
    );
  }
}
