/**
 * PATCH /api/hub/operator/bookings/[id] — Update booking status
 * GET  /api/hub/operator/bookings/[id] — Get booking details
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireOperator } from '@/lib/auth/middleware';
import { z } from 'zod';
import { query } from '@/lib/database';
import { changeOwnerBookingStatus } from '@/lib/bookings/owner-status';
import { getOperatorPartnerId } from '@/lib/auth/operator-helpers';
import { requireTeamPermission } from '@/lib/operators/team-access';

export const dynamic = 'force-dynamic';

const PatchSchema = z.object({
  booking_status: z.enum(['new', 'confirmed', 'cancelled', 'completed', 'no_show']).optional(),
  cancellation_reason: z.string().max(255).optional(),
  notes: z.string().max(1000).optional(),
});

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const authOrResponse = await requireOperator(request);
    if (authOrResponse instanceof NextResponse) return authOrResponse;

    const operator_id = await getOperatorPartnerId(authOrResponse.userId);
    if (!operator_id) return NextResponse.json({ error: 'Not an operator' }, { status: 403 });

    const result = await query(
      `SELECT b.*,
              b.booking_date::text AS booking_date,
              t.title as tour_title,
              t.location_name,
              t.base_price as tour_base_price,
              g.name AS guide_name
       FROM operator_bookings b
       JOIN operator_tours t ON b.operator_tour_id = t.id
       LEFT JOIN partners g ON g.id = b.guide_partner_id
       WHERE b.id = $1 AND t.operator_id = $2 AND b.deleted_at IS NULL LIMIT 1`,
      [BigInt(id), operator_id]
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
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const authOrResponse = await requireOperator(request);
    if (authOrResponse instanceof NextResponse) return authOrResponse;

    const operator_id = await getOperatorPartnerId(authOrResponse.userId);
    if (!operator_id) return NextResponse.json({ error: 'Not an operator' }, { status: 403 });

    const body = await request.json();
    const input = PatchSchema.parse(body);

    // Отмена брони — «решение за партнёром» (владелец 11.10): менеджеру
    // команды только с правом can_cancel_bookings (CRM 2г).
    if (input.booking_status === 'cancelled') {
      const denied = await requireTeamPermission(authOrResponse.userId, 'can_cancel_bookings');
      if (denied) return denied;
    }

    // Что происходит с бронью — общее правило продавца тура
    // (lib/bookings/owner-status): владение, переход, места, возврат, письмо
    // и уведомления туриста, лояльность. Им же пользуется кабинет гида со
    // своими турами; здесь — только кто вправе.
    const outcome = await changeOwnerBookingStatus({
      ownerPartnerId: operator_id,
      actorUserId: authOrResponse.userId,
      bookingId: id,
      input,
    });

    if (outcome.kind === 'bad_transition') {
      return NextResponse.json(
        { error: `Из статуса «${outcome.from}» так перевести бронь нельзя` },
        { status: 409 },
      );
    }
    if (outcome.kind === 'not_found') {
      return NextResponse.json({ error: 'Booking not found' }, { status: 404 });
    }

    const touristNotice = outcome.touristNotice;
    return NextResponse.json({ success: true, data: outcome.data, tourist_notice: touristNotice });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }
    const e = error as { code?: string; message?: string };
    console.error('[hub/operator/bookings/[id]] PATCH отказ:', `sqlstate=${e?.code ?? 'нет'}`, e?.message ?? String(error));
    return NextResponse.json({ error: 'Failed to update booking' }, { status: 500 });
  }
}
