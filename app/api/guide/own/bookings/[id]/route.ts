/**
 * PATCH /api/guide/own/bookings/[id] — гид подтверждает, отклоняет или
 * закрывает бронь своего тура. Правило то же, что у кабинета оператора
 * (lib/bookings/owner-status): владение по туру, разрешённый переход, места и
 * возврат при отмене, письмо и уведомления туриста. Команды у гида нет —
 * решает владелец карточки.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireRole } from '@/lib/auth/middleware';
import { getGuidePartnerId } from '@/lib/auth/guide-helpers';
import { changeOwnerBookingStatus } from '@/lib/bookings/owner-status';

export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  booking_status: z.enum(['confirmed', 'cancelled', 'completed', 'no_show']),
  cancellation_reason: z.string().trim().max(255).optional(),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!/^\d{1,18}$/.test(id)) {
    return NextResponse.json({ success: false, error: 'Неверный номер брони' }, { status: 400 });
  }
  const auth = await requireRole(request, ['guide']);
  if (auth instanceof NextResponse) return auth;

  const body = BodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ success: false, error: 'Статус — подтвердить, отменить, завершить или «не пришёл»' }, { status: 400 });
  }
  if (body.data.booking_status === 'cancelled' && !body.data.cancellation_reason) {
    return NextResponse.json({ success: false, error: 'Назовите причину отмены — её получит турист' }, { status: 400 });
  }

  const partnerId = await getGuidePartnerId(auth.userId);
  if (!partnerId) {
    return NextResponse.json({ success: false, error: 'Карточка гида не найдена' }, { status: 404 });
  }

  try {
    const outcome = await changeOwnerBookingStatus({
      ownerPartnerId: partnerId,
      actorUserId: auth.userId,
      bookingId: id,
      input: body.data,
    });
    if (outcome.kind === 'not_found') {
      return NextResponse.json({ success: false, error: 'Бронь не найдена среди ваших туров' }, { status: 404 });
    }
    if (outcome.kind === 'bad_transition') {
      return NextResponse.json(
        { success: false, error: `Из статуса «${outcome.from}» так перевести бронь нельзя` },
        { status: 409 },
      );
    }
    return NextResponse.json({ success: true, data: outcome.data, tourist_notice: outcome.touristNotice });
  } catch (e) {
    const err = e as { code?: string };
    console.error('[guide/own/bookings] смена статуса не записана:', `sqlstate=${err?.code ?? 'нет'}`);
    return NextResponse.json({ success: false, error: 'Не удалось записать — попробуйте ещё раз' }, { status: 503 });
  }
}
