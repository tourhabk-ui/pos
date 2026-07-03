/**
 * GET /api/admin/health/booking-funnel-stages
 *
 * Health-метрика (issue #273): срез стадий воронки броней за окно дней.
 * Возвращает распределение operator_bookings по booking_status и показатели
 * предложения (опубликованные туры / операторы), чтобы отличить 'нет спроса'
 * от 'нет предложения' при простое воронки.
 *
 * Query: ?days= (целое 1..365, по умолчанию 7).
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/middleware';
import { getBookingFunnelStages } from '@/lib/services/booking-funnel-stages';

export const dynamic = 'force-dynamic';

const QuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(7),
});

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const { searchParams } = new URL(request.url);
  const parsed = QuerySchema.safeParse({ days: searchParams.get('days') ?? undefined });
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Некорректный параметр days: ожидается целое число от 1 до 365' },
      { status: 400 },
    );
  }

  const stages = await getBookingFunnelStages(parsed.data.days);
  return NextResponse.json(stages);
}
