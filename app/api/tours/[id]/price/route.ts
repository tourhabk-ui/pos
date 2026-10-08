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
import { PriceTierMissError } from '@/lib/tours/price-tiers';
import { honestTourPrice } from '@/lib/tours/honest-price';
import { publicTourSql } from '@/lib/tours/public-visibility';

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

  // Единица цены и длительность нужны, чтобы вернуть ИТОГ, а не только цену
  // за человека: до 27.09 этот эндпоинт отдавал цену единицы, а тур «за
  // группу» и «за день» превращает её в другую сумму
  // (lib/tours/booking-total.ts).
  //
  // Шлюз витрины общий (lib/tours/public-visibility) — он же добавляет
  // is_active: цену выключенного тура роут отдавал, хотя ни карточка, ни
  // бронь его уже не видят.
  const { rows } = await pool.query<{
    base_price: string; title: string; price_unit: string | null;
    multi_day_count: number | null; duration_hours: number | null;
  }>(
    `SELECT base_price, title, price_unit, multi_day_count, duration_hours
       FROM operator_tours
      WHERE id = $1 AND ${publicTourSql('')}`,
    [id]
  );

  if (rows.length === 0) {
    return NextResponse.json({ success: false, error: 'Тур не найден' }, { status: 404 });
  }

  const tour = rows[0];
  let price;
  try {
    price = await honestTourPrice({
      tourId: id,
      tourDate: date,
      baseUnitPrice: parseFloat(tour.base_price),
      priceUnit: tour.price_unit,
      participants: guests,
      duration: tour,
    });
  } catch (err) {
    // Размер группы вне ступеней цены: суммы нет. Это не 500 и не базовая цена.
    if (err instanceof PriceTierMissError) {
      return NextResponse.json(
        { success: false, code: 'price_unknown', error: err.message },
        { status: 422 },
      );
    }
    throw err;
  }

  return NextResponse.json({
    success:      true,
    tourId:       id,
    tourTitle:    tour.title,
    date,
    guests,
    // Прежние имена сохранены — их читают внешние вызовы; смысл тот же, цена
    // за единицу.
    basePrice:    price.baseUnitPrice,
    finalPrice:   price.finalUnitPrice,
    discount:     price.finalUnitPrice - price.baseUnitPrice,
    multiplier:   price.multiplier,
    appliedRules: price.appliedRules,
    // Новое: итог брони и подпись для экрана. Итог — ровно то, что запишет
    // бронь: обе двери считают одним правилом (lib/tours/honest-price.ts).
    baseTotal:    price.baseTotal,
    total:        price.total,
    changePercent: price.changePercent,
    label:        price.label,
  });
}
