import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { requireAuth } from '@/lib/auth/middleware';
import { verifyAccommodationOwnership } from '@/lib/auth/stay-helpers';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

// ─── Schema ───────────────────────────────────────────────────────────────────

const SetRateSchema = z.object({
  accommodationId: z.string().uuid('accommodationId обязателен'),
  date:            z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date: формат YYYY-MM-DD'),
  roomId:          z.string().uuid().nullish(),
  priceOverride:   z.number().min(0).nullish(),
  availableRooms:  z.number().int().min(0).nullish(),
  isBlocked:       z.boolean().optional(),
  blockReason:     z.string().max(500).nullish(),
  notes:           z.string().max(1000).nullish(),
});

async function checkAccess(request: NextRequest, accommodationId: string) {
  const authResult = await requireAuth(request);
  if (authResult instanceof NextResponse) return authResult;

  const isOwner = await verifyAccommodationOwnership(authResult.userId, accommodationId);
  if (!isOwner && authResult.role !== 'admin') {
    return NextResponse.json(
      { success: false, error: 'Объект не найден или нет прав' },
      { status: 404 }
    );
  }
  return authResult;
}

// ─── GET /api/stay/calendar ───────────────────────────────────────────────────
// Тарифный календарь объекта за диапазон дат: override/блокировки из
// accommodation_availability + реальная занятость из accommodation_bookings.

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const accommodationId = searchParams.get('accommodationId');
  if (!accommodationId || !/^[0-9a-f-]{36}$/i.test(accommodationId)) {
    return NextResponse.json({ success: false, error: 'accommodationId обязателен' }, { status: 400 });
  }

  const authOrResponse = await checkAccess(request, accommodationId);
  if (authOrResponse instanceof NextResponse) return authOrResponse;

  const startDate = searchParams.get('startDate') ?? new Date().toISOString().slice(0, 10);
  const endDate = searchParams.get('endDate') ??
    new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    return NextResponse.json({ success: false, error: 'Даты: формат YYYY-MM-DD' }, { status: 400 });
  }

  try {
    const [ratesResult, bookingsResult, baseResult] = await Promise.all([
      pool.query(
        `SELECT id::text, room_id::text, date::text, price_override,
                available_rooms, is_blocked, block_reason, notes
         FROM accommodation_availability
         WHERE accommodation_id = $1 AND date >= $2 AND date <= $3
         ORDER BY date ASC`,
        [accommodationId, startDate, endDate]
      ),
      // Занятость по дням: бронь занимает [check_in, check_out) — полуинтервал,
      // как в /api/accommodations/[id]/availability
      pool.query(
        `SELECT d.date::text, COUNT(b.id)::int AS booked
         FROM generate_series($2::date, $3::date, '1 day') AS d(date)
         LEFT JOIN accommodation_bookings b
           ON b.accommodation_id = $1
          AND b.status IN ('pending', 'confirmed')
          AND d.date >= b.check_in_date AND d.date < b.check_out_date
         GROUP BY d.date
         ORDER BY d.date`,
        [accommodationId, startDate, endDate]
      ),
      pool.query(
        `SELECT price_per_night_from, total_rooms FROM accommodations WHERE id = $1`,
        [accommodationId]
      ),
    ]);

    const base = baseResult.rows[0];
    return NextResponse.json({
      success: true,
      data: {
        basePrice: base ? Number(base.price_per_night_from) : null,
        totalRooms: base ? Number(base.total_rooms) : null,
        rates: ratesResult.rows.map(r => ({
          id: r.id,
          roomId: r.room_id,
          date: r.date,
          priceOverride: r.price_override != null ? Number(r.price_override) : null,
          availableRooms: r.available_rooms,
          isBlocked: r.is_blocked,
          blockReason: r.block_reason,
          notes: r.notes,
        })),
        occupancy: bookingsResult.rows.map(r => ({ date: r.date, booked: r.booked })),
      },
    });
  } catch {
    return NextResponse.json({ success: false, error: 'Ошибка при получении календаря' }, { status: 500 });
  }
}

// ─── POST /api/stay/calendar ──────────────────────────────────────────────────
// Upsert тарифа/блокировки на дату (объект или конкретный номер).

export async function POST(request: NextRequest) {
  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ success: false, error: 'Некорректный JSON' }, { status: 400 });
  }

  const parsed = SetRateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' },
      { status: 400 }
    );
  }
  const { accommodationId, date, roomId, priceOverride, availableRooms, isBlocked, blockReason, notes } = parsed.data;

  const authOrResponse = await checkAccess(request, accommodationId);
  if (authOrResponse instanceof NextResponse) return authOrResponse;

  // Номер должен принадлежать этому объекту
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
    // Два partial unique index (room_id IS NULL / IS NOT NULL) — ON CONFLICT
    // должен указывать соответствующий, поэтому две ветки
    const { rows } = roomId
      ? await pool.query(
          `INSERT INTO accommodation_availability (
             accommodation_id, room_id, date, price_override,
             available_rooms, is_blocked, block_reason, notes
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (accommodation_id, room_id, date) WHERE room_id IS NOT NULL
           DO UPDATE SET
             price_override  = EXCLUDED.price_override,
             available_rooms = EXCLUDED.available_rooms,
             is_blocked      = EXCLUDED.is_blocked,
             block_reason    = EXCLUDED.block_reason,
             notes           = EXCLUDED.notes,
             updated_at      = NOW()
           RETURNING id::text, date::text, room_id::text, price_override, is_blocked`,
          [accommodationId, roomId, date, priceOverride ?? null, availableRooms ?? null,
           isBlocked ?? false, blockReason ?? null, notes ?? null]
        )
      : await pool.query(
          `INSERT INTO accommodation_availability (
             accommodation_id, room_id, date, price_override,
             available_rooms, is_blocked, block_reason, notes
           ) VALUES ($1, NULL, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (accommodation_id, date) WHERE room_id IS NULL
           DO UPDATE SET
             price_override  = EXCLUDED.price_override,
             available_rooms = EXCLUDED.available_rooms,
             is_blocked      = EXCLUDED.is_blocked,
             block_reason    = EXCLUDED.block_reason,
             notes           = EXCLUDED.notes,
             updated_at      = NOW()
           RETURNING id::text, date::text, room_id::text, price_override, is_blocked`,
          [accommodationId, date, priceOverride ?? null, availableRooms ?? null,
           isBlocked ?? false, blockReason ?? null, notes ?? null]
        );

    return NextResponse.json({ success: true, data: rows[0], message: 'Тариф обновлён' });
  } catch {
    return NextResponse.json({ success: false, error: 'Ошибка при сохранении тарифа' }, { status: 500 });
  }
}
