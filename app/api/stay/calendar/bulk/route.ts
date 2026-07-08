import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { requireAccommodationAccess } from '@/lib/auth/stay-helpers';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

/**
 * POST /api/stay/calendar/bulk — тариф/блокировка на диапазон дат одним
 * действием (сезонные цены, выходные): generate_series + upsert, вместо
 * кликов по каждому дню. Опциональный фильтр дней недели (0=вс..6=сб,
 * как EXTRACT(DOW)). Обновляются ТОЛЬКО переданные поля — семантика
 * как у поштучного POST /api/stay/calendar.
 */

const BulkRateSchema = z.object({
  accommodationId: z.string().uuid('accommodationId обязателен'),
  roomId:          z.string().uuid().nullish(),
  startDate:       z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'startDate: формат YYYY-MM-DD'),
  endDate:         z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'endDate: формат YYYY-MM-DD'),
  /** Дни недели по EXTRACT(DOW): 0=воскресенье … 6=суббота; пусто — все дни */
  weekdays:        z.array(z.number().int().min(0).max(6)).max(7).optional(),
  priceOverride:   z.number().min(0).nullish(),
  availableRooms:  z.number().int().min(0).nullish(),
  isBlocked:       z.boolean().optional(),
  blockReason:     z.string().max(500).nullish(),
});

const MAX_RANGE_DAYS = 366;

export async function POST(request: NextRequest) {
  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ success: false, error: 'Некорректный JSON' }, { status: 400 });
  }

  const parsed = BulkRateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' },
      { status: 400 }
    );
  }
  const { accommodationId, roomId, startDate, endDate, weekdays, priceOverride, availableRooms, isBlocked, blockReason } = parsed.data;

  if (endDate < startDate) {
    return NextResponse.json({ success: false, error: 'endDate раньше startDate' }, { status: 400 });
  }
  const rangeDays = (new Date(`${endDate}T00:00:00Z`).getTime() - new Date(`${startDate}T00:00:00Z`).getTime()) / 86_400_000 + 1;
  if (rangeDays > MAX_RANGE_DAYS) {
    return NextResponse.json({ success: false, error: 'Диапазон больше года — разбейте на части' }, { status: 400 });
  }

  const provided: [string, unknown][] = [];
  if (priceOverride !== undefined) provided.push(['price_override', priceOverride]);
  if (availableRooms !== undefined) provided.push(['available_rooms', availableRooms]);
  if (isBlocked !== undefined) provided.push(['is_blocked', isBlocked]);
  if (blockReason !== undefined) provided.push(['block_reason', blockReason]);
  if (provided.length === 0) {
    return NextResponse.json({ success: false, error: 'Нет полей для установки' }, { status: 400 });
  }

  const authOrResponse = await requireAccommodationAccess(request, accommodationId);
  if (authOrResponse instanceof NextResponse) return authOrResponse;

  if (roomId) {
    const { rows } = await pool.query(
      `SELECT 1 FROM accommodation_rooms WHERE id = $1 AND accommodation_id = $2`,
      [roomId, accommodationId]
    );
    if (rows.length === 0) {
      return NextResponse.json({ success: false, error: 'Номер не найден в этом объекте' }, { status: 404 });
    }
  }

  try {
    // Значения полей — параметрами; имена колонок — из фиксированного списка
    const params: unknown[] = [accommodationId, roomId ?? null, startDate, endDate];
    const insertCols = ['accommodation_id', 'room_id', 'date', ...provided.map(([c]) => c)];
    const valueExprs = ['$1', '$2', 'd.date::date', ...provided.map(([, v]) => {
      params.push(v);
      return `$${params.length}`;
    })];

    let weekdayFilter = '';
    if (weekdays && weekdays.length > 0 && weekdays.length < 7) {
      params.push(weekdays);
      weekdayFilter = `WHERE EXTRACT(DOW FROM d.date)::int = ANY($${params.length}::int[])`;
    }

    const conflictTarget = roomId
      ? 'ON CONFLICT (accommodation_id, room_id, date) WHERE room_id IS NOT NULL'
      : 'ON CONFLICT (accommodation_id, date) WHERE room_id IS NULL';
    const updates = [...provided.map(([c]) => `${c} = EXCLUDED.${c}`), 'updated_at = NOW()'].join(', ');

    const { rowCount } = await pool.query(
      `INSERT INTO accommodation_availability (${insertCols.join(', ')})
       SELECT ${valueExprs.join(', ')}
       FROM generate_series($3::date, $4::date, '1 day') AS d(date)
       ${weekdayFilter}
       ${conflictTarget}
       DO UPDATE SET ${updates}`,
      params
    );

    return NextResponse.json({
      success: true,
      data: { daysAffected: rowCount ?? 0 },
      message: `Тариф применён к ${rowCount ?? 0} дн.`,
    });
  } catch {
    return NextResponse.json({ success: false, error: 'Ошибка при массовом обновлении тарифов' }, { status: 500 });
  }
}
