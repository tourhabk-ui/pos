import { NextRequest, NextResponse } from 'next/server';
import { ApiResponse } from '@/types';
import { verifyAuth } from '@/lib/auth';
import { listMyBookings } from '@/lib/tourist/cabinet';

export const dynamic = 'force-dynamic';

/**
 * GET /api/bookings/my — брони текущего пользователя.
 *
 * До 10.09 запрос джойнил `tour_assets ta ON t.id = ta.tour_id` — bigint с
 * uuid — и падал на КАЖДЫЙ вызов (42883), а дашборд на 500 показывал
 * «Бронирований пока нет» (issue #1770). SQL переехал в lib/tourist/cabinet и
 * гоняется на настоящем PostgreSQL. Отказ базы здесь — 500 с логом, а не
 * пустой список: «не смог» и «пусто» — разные ответы (§4.0).
 */
export async function GET(request: NextRequest) {
  const auth = await verifyAuth(request);
  if (!auth.isAuthenticated || !auth.userId) {
    return NextResponse.json({ success: false, error: 'Не авторизован' } as ApiResponse<null>, { status: 401 });
  }
  try {
    const bookings = await listMyBookings(auth.userId);
    return NextResponse.json({ success: true, data: { bookings } } as ApiResponse<unknown>);
  } catch (error) {
    const e = error as Error & { code?: string };
    console.error('[bookings/my] отказ базы', { sqlstate: e?.code, message: e?.message });
    return NextResponse.json(
      { success: false, error: 'Не удалось загрузить бронирования. Попробуйте обновить страницу.' } as ApiResponse<null>,
      { status: 500 },
    );
  }
}
