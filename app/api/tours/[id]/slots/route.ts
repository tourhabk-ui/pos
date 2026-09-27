/**
 * GET /api/tours/[id]/slots
 * Публичный. Возвращает ближайшие доступные даты из tour_availability для
 * operator_tour_id — но только если сам тур на витрине (`publicTourSql`);
 * иначе 404, а не пустой список.
 *
 * Занятость считается из operator_bookings (та же логика, что у гейткипера
 * /api/hub/bookings/create), а НЕ из счётчика booked_slots: счётчик
 * инкрементится только при оплате, поэтому не видит созданные-но-неоплаченные
 * брони — показывал места, по которым бронь была бы отклонена.
 */

import { occupiedOnDaySql } from '@/lib/bookings/occupancy';
import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { publicTourSql } from '@/lib/tours/public-visibility';

export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Next 15: params — Promise; синхронное чтение предупреждает сейчас и
    // ломается в следующей мажорной (#1780).
    const { id } = await params;
    const tourId = parseInt(id, 10);
    if (!tourId) return NextResponse.json({ success: false, error: 'Invalid id' }, { status: 400 });

    // Сам тур обязан быть на витрине. До этой правки даты отдавались по ЛЮБОМУ
    // id — черновик оператора, снятый с витрины тур, удалённый, — и календарь
    // обещал свободные места там, где тура для туриста нет. Шлюз витрины один
    // на все публичные чтения туров (lib/tours/public-visibility.ts).
    //
    // Отдельным запросом, а не условием в JOIN, намеренно: пустой список дат
    // значит «свободных дат нет», и подменять им «такого тура нет» — выдавать
    // одно состояние за другое (§4.0). Разные ответы — разные исходы.
    const visible = await pool.query(
      `SELECT 1 FROM operator_tours ot WHERE ot.id = $1 AND ${publicTourSql('ot')}`,
      [tourId],
    );
    if (visible.rowCount === 0) {
      return NextResponse.json({ success: false, error: 'Тур не найден' }, { status: 404 });
    }

    const { rows } = await pool.query(
      `SELECT
         ta.date::text AS date,
         ta.available_slots,
         occ.taken AS booked_slots,
         GREATEST(0, LEAST(ta.available_slots, COALESCE(ot.max_participants, ta.available_slots)) - occ.taken) AS free_slots
       FROM tour_availability ta
       JOIN operator_tours ot ON ot.id = ta.operator_tour_id
       CROSS JOIN LATERAL (
         ${occupiedOnDaySql({ booking: 'ob', day: 'ta.date', tourId: 'ta.operator_tour_id' })}
       ) occ
       WHERE ta.operator_tour_id = $1
         AND ta.date >= CURRENT_DATE
         AND ta.is_cancelled = false
         AND ta.deleted_at IS NULL
         AND ta.date <= CURRENT_DATE + INTERVAL '1 year'
         AND GREATEST(0, LEAST(ta.available_slots, COALESCE(ot.max_participants, ta.available_slots)) - occ.taken) > 0
       ORDER BY ta.date ASC
       -- Было LIMIT 30 — ровно 30 ДАТ, а не 30 дней. Календарь строит по этому
       -- ответу целые месяцы: при сезоне Июн—Сен сентябрь просто не доезжал, и
       -- сетка честно рисовала «мест нет» там, где места есть. Ограничение
       -- нужно (запрос публичный), но по сезону, а не по горстке дат: год
       -- вперёд с запасом покрывает любой сезон, оставаясь конечным.
       LIMIT 400`,
      [tourId]
    );

    return NextResponse.json({ success: true, slots: rows });
  } catch {
    return NextResponse.json({ success: false, error: 'Ошибка загрузки дат' }, { status: 500 });
  }
}
