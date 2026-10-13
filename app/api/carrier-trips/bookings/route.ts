/**
 * GET /api/carrier-trips/bookings — мои заказы мест (заказчик: пользователь
 * либо его партнёрские профили). Для экрана витрины: статус решения
 * перевозчика и состояние оплаты по QR (миграция 928).
 *
 * Отказ базы — 503 с `searched: false`: экран обязан сказать «не смогли
 * проверить», а не показать пустой список как «заказов нет».
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/middleware';
import { query } from '@/lib/database';
import { listSeatBookingsForCustomer } from '@/lib/transfers/service';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  try {
    const partners = await query<{ id: string }>(`SELECT id FROM partners WHERE user_id = $1`, [auth.userId]);
    const bookings = await listSeatBookingsForCustomer({
      userId: auth.userId,
      partnerIds: partners.rows.map(r => r.id),
    });
    return NextResponse.json({ success: true, searched: true, count: bookings.length, bookings });
  } catch (err) {
    console.error('[carrier-trips/bookings] list:', err instanceof Error ? err.message : err);
    return NextResponse.json(
      { success: false, searched: false, error: 'Не удалось проверить заказы — попробуйте позже' },
      { status: 503 },
    );
  }
}
