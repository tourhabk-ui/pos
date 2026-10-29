/**
 * GET /api/agent/tours — туры, которые агент может продать.
 *
 * Цена отдаётся с единицей (`price_unit`): «за группу» и «за человека в
 * день» — разные цены, и агент, пересказывающий клиенту «12 000 ₽» без
 * единицы, называет не ту сумму (lib/tours/booking-total).
 *
 * Комиссия агента — `null`, а не `base_price × 0.10`, как было до 26.09.
 * Ставку вознаграждения назначает владелец платформы; число, выдуманное
 * здесь, агент принял бы за обещание (§4.0, §7).
 *
 * Порядок — правило 1в (слово владельца 29.10): сначала туры со свободной
 * датой по ближайшему выезду, остальные — жребием дня; до 29.10 — по
 * названию с потолком 200, который резал хвост алфавита молча.
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { requireAgent } from '@/lib/auth/middleware';
import { normalizePriceUnit } from '@/lib/tours/booking-total';
import { nearestFreeDateSql } from '@/lib/tours/nearest-free-date';
import { orderOffersBy } from '@/lib/tours/offer-order';

export const dynamic = 'force-dynamic';

interface TourRow {
  id: string;
  title: string;
  description: string | null;
  activity_type: string | null;
  duration_hours: string | null;
  multi_day_count: number | null;
  base_price: string;
  price_unit: string | null;
  max_participants: number | null;
  season_start: string | null;
  season_end: string | null;
  operator_name: string | null;
  nearest_free_date: string | null;
}

export async function GET(request: NextRequest) {
  const auth = await requireAgent(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const { rows } = await pool.query<TourRow>(
      `SELECT t.id::text AS id, t.title, t.description, t.activity_type,
              t.duration_hours::text AS duration_hours, t.multi_day_count,
              t.base_price::text AS base_price, t.price_unit, t.max_participants,
              t.season_start::text AS season_start, t.season_end::text AS season_end,
              COALESCE(p.company_name, p.name) AS operator_name,
              ${nearestFreeDateSql('t')} AS nearest_free_date
         FROM operator_tours t
         JOIN partners p ON t.operator_id = p.id
        WHERE t.is_published = true AND t.is_active = true AND t.deleted_at IS NULL`,
    );

    const ordered = orderOffersBy(rows, (r) => ({ id: r.id, nearestFreeDate: r.nearest_free_date ?? null }));
    const tours = ordered.map(row => ({
      id:            row.id,
      name:          row.title,
      description:   row.description,
      activityType:  row.activity_type,
      durationHours: row.duration_hours == null ? null : Number(row.duration_hours),
      multiDayCount: row.multi_day_count,
      price:         Number(row.base_price),
      priceUnit:     normalizePriceUnit(row.price_unit),
      maxGroupSize:  row.max_participants,
      seasonStart:   row.season_start,
      seasonEnd:     row.season_end,
      operatorName:  row.operator_name,
      nearestFreeDate: row.nearest_free_date ?? null,
      // Ставку назначает владелец платформы — здесь её нет, и выдумывать нельзя.
      commission:    null,
    }));

    return NextResponse.json({ success: true, data: { tours } });
  } catch (err) {
    const sqlstate = (err as { code?: string }).code ?? 'нет SQLSTATE';
    console.error(`[agent/tours] туры не прочитаны, SQLSTATE ${sqlstate}:`,
      err instanceof Error ? err.message : err);
    return NextResponse.json(
      { success: false, error: 'Не удалось загрузить туры. Попробуйте позже.' },
      { status: 500 },
    );
  }
}
