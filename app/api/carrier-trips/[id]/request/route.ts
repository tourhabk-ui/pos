/**
 * POST /api/carrier-trips/[id]/request — запросить места в поездке.
 * Body: { seats: 1..60, contact_phone: string, comment?: string }.
 *
 * Запрос НИЧЕГО не держит — держит только подтверждение перевозчика
 * (confirmSeats под замком). Поэтому запрос не проверяет остаток: остаток
 * считается один раз, при подтверждении, под FOR UPDATE.
 *
 * ── Вход обязателен, и это решение схемы, а не удобства ──────────────────
 *
 * Миграция 926 требует у запроса ровно одного заказчика: партнёр ИЛИ
 * пользователь (CHECK num_nonnulls = 1). Гость с одним телефоном в эту
 * схему не ложится. Ослаблять CHECK молча под витрину нельзя — это смена
 * схемы (§5), и она названа в PR открытым вопросом владельцу. Пока —
 * requireAuth; Edge держит путь за JWT (в реестре только GET витрины).
 *
 * Партнёр-туроператор, заказывающий под группу, приходит той же дверью:
 * если у вошедшего есть партнёрский профиль оператора, запрос пишется от
 * партнёра, иначе — от пользователя.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth } from '@/lib/auth/middleware';
import { query } from '@/lib/database';
import { requestSeats } from '@/lib/transfers/service';
import { FAILURE_STATUS } from '@/lib/transfers/carrier-auth';
import { createRateLimiter } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

const limiter = createRateLimiter({ windowMs: 60_000, max: 10 });

const Schema = z.object({
  seats: z.number().int().min(1).max(60),
  contact_phone: z.string().trim().min(5, 'Телефон для связи обязателен').max(20),
  comment: z.string().trim().max(500).optional().nullable(),
});

async function operatorPartnerId(userId: string): Promise<string | null> {
  const r = await query<{ id: string }>(
    `SELECT id FROM partners WHERE user_id = $1 AND category = 'operator' LIMIT 1`,
    [userId],
  );
  return r.rows[0]?.id ?? null;
}

export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  if (!limiter.check(auth.userId)) {
    return NextResponse.json({ success: false, error: 'Слишком много запросов, попробуйте позже' }, { status: 429 });
  }

  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ success: false, error: 'Некорректный id поездки' }, { status: 400 });
  }
  const parsed = Schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' },
      { status: 400 },
    );
  }

  let partnerId: string | null = null;
  try {
    partnerId = await operatorPartnerId(auth.userId);
  } catch (err) {
    console.error('[carrier-trips/request] partner lookup:', err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: 'Не удалось определить заказчика — попробуйте позже' }, { status: 503 });
  }

  const result = await requestSeats({
    tripId: id,
    orderedByPartnerId: partnerId,
    orderedByUserId: partnerId ? null : auth.userId,
    seats: parsed.data.seats,
    comment: parsed.data.comment ?? null,
    contactPhone: parsed.data.contact_phone,
  });
  if (!result.ok) {
    return NextResponse.json(
      { success: false, code: result.code, error: result.message },
      { status: FAILURE_STATUS[result.code] ?? 500 },
    );
  }
  return NextResponse.json(
    { success: true, data: result.value, note: 'Запрос отправлен перевозчику; места займутся после его подтверждения' },
    { status: 201 },
  );
}
