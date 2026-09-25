/**
 * GET /api/tours/[id]/price?date=YYYY-MM-DD&guests=2
 *
 * Возвращает динамическую цену тура на указанную дату.
 *
 * Клик по агентской ссылке здесь больше НЕ считается (26.09). Считал он
 * его вторым местом рядом с `/r/<код>`: переход по короткой ссылке уже дал
 * клик и увёл на карточку с `?ref=`, и любой экран, спросивший цену с тем же
 * `ref`, засчитал бы тот же переход дважды. Вдобавок счётчик здесь писал IP
 * туриста (ПД ради счётчика) и глушил отказ пустым `catch`. Клик теперь
 * считается в одном месте — `app/r/[code]/route.ts`.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { pool } from '@/lib/db-pool';
import { calculateDynamicPrice } from '@/lib/services/tours/dynamic-pricing';

export const dynamic = 'force-dynamic';

const QuerySchema = z.object({
  date:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Формат даты: YYYY-MM-DD'),
  guests: z.coerce.number().min(1).max(50).default(1),
});

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const sp = request.nextUrl.searchParams;

  const parsed = QuerySchema.safeParse({
    date:   sp.get('date'),
    guests: sp.get('guests'),
  });

  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message },
      { status: 400 }
    );
  }

  const { date, guests } = parsed.data;

  // Получаем базовую цену тура
  const { rows } = await pool.query<{ base_price: string; title: string }>(
    `SELECT base_price, title FROM operator_tours
     WHERE id = $1 AND is_published = TRUE AND deleted_at IS NULL`,
    [id]
  );

  if (rows.length === 0) {
    return NextResponse.json({ success: false, error: 'Тур не найден' }, { status: 404 });
  }

  const basePrice = parseFloat(rows[0].base_price);

  // Рассчитываем динамическую цену
  const priceResult = await calculateDynamicPrice({
    tourId:    id,
    tourDate:  date,
    guests,
    basePrice,
  });

  return NextResponse.json({
    success:      true,
    tourId:       id,
    tourTitle:    rows[0].title,
    date,
    guests,
    basePrice:    priceResult.basePrice,
    finalPrice:   priceResult.finalPrice,
    discount:     priceResult.discount,
    multiplier:   priceResult.multiplier,
    appliedRules: priceResult.appliedRules,
  });
}
