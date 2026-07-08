import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { requireAuth } from '@/lib/auth/middleware';
import { ROOM_TYPES } from '@/lib/stay/room-types';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const UpdateRoomSchema = z.object({
  name:              z.string().min(1).max(255).optional(),
  roomType:          z.enum(ROOM_TYPES).optional(),
  description:       z.string().max(2000).nullish(),
  sizeSqm:           z.number().int().positive().nullish(),
  maxGuests:         z.number().int().min(1).optional(),
  bedsConfiguration: z.record(z.string(), z.unknown()).nullish(),
  amenities:         z.array(z.string().max(100)).max(50).optional(),
  view:              z.string().max(50).nullish(),
  availableRooms:    z.number().int().min(0).optional(),
  pricePerNight:     z.number().min(0).optional(),
  isActive:          z.boolean().optional(),
});

// camelCase → колонка; значения через параметры, имена колонок из этой карты
const COLUMN_MAP: Record<string, string> = {
  name: 'name',
  roomType: 'room_type',
  description: 'description',
  sizeSqm: 'size_sqm',
  maxGuests: 'max_guests',
  bedsConfiguration: 'beds_configuration',
  amenities: 'amenities',
  view: 'view',
  availableRooms: 'available_rooms',
  pricePerNight: 'price_per_night',
  isActive: 'is_active',
};

/**
 * Владение номером: через объект → партнёр category='stay' → user.
 * admin — в обход. Возвращает roomRow или NextResponse с ошибкой.
 */
async function checkRoomAccess(request: NextRequest, roomId: string) {
  const authResult = await requireAuth(request);
  if (authResult instanceof NextResponse) return authResult;

  const { rows } = await pool.query(
    `SELECT r.id, r.accommodation_id, p.user_id
     FROM accommodation_rooms r
     JOIN accommodations a ON r.accommodation_id = a.id
     JOIN partners p ON a.partner_id = p.id AND p.category = 'stay'
     WHERE r.id = $1`,
    [roomId]
  );

  const room = rows[0];
  if (!room || (room.user_id !== authResult.userId && authResult.role !== 'admin')) {
    return NextResponse.json(
      { success: false, error: 'Номер не найден или нет прав' },
      { status: 404 }
    );
  }
  return { auth: authResult, room };
}

// ─── PATCH /api/stay/rooms/[id] ───────────────────────────────────────────────

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const accessOrResponse = await checkRoomAccess(request, id);
  if (accessOrResponse instanceof NextResponse) return accessOrResponse;

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ success: false, error: 'Некорректный JSON' }, { status: 400 });
  }

  const parsed = UpdateRoomSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' },
      { status: 400 }
    );
  }

  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(parsed.data)) {
    if (value === undefined) continue;
    const column = COLUMN_MAP[key];
    if (!column) continue;
    values.push(
      key === 'bedsConfiguration' || key === 'amenities'
        ? (value === null ? null : JSON.stringify(value))
        : value
    );
    sets.push(`${column} = $${values.length}`);
  }

  if (sets.length === 0) {
    return NextResponse.json({ success: false, error: 'Нет полей для обновления' }, { status: 400 });
  }

  values.push(id);

  try {
    const { rows } = await pool.query(
      `UPDATE accommodation_rooms
       SET ${sets.join(', ')}, updated_at = NOW()
       WHERE id = $${values.length}
       RETURNING id, name, room_type, is_active, price_per_night, available_rooms`,
      values
    );

    return NextResponse.json({ success: true, data: rows[0], message: 'Номер обновлён' });
  } catch {
    return NextResponse.json({ success: false, error: 'Ошибка при обновлении номера' }, { status: 500 });
  }
}

// ─── DELETE /api/stay/rooms/[id] ──────────────────────────────────────────────
// С активными бронями удалять нельзя — 409 с предложением деактивации
// (isActive=false через PATCH). Исторические брони сохраняют room_id.

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const accessOrResponse = await checkRoomAccess(request, id);
  if (accessOrResponse instanceof NextResponse) return accessOrResponse;

  try {
    const { rows: bookingRows } = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status IN ('pending', 'confirmed')
                            AND check_out_date > CURRENT_DATE)::int AS active,
         COUNT(*)::int AS total
       FROM accommodation_bookings
       WHERE room_id = $1`,
      [id]
    );

    if (bookingRows[0].active > 0) {
      return NextResponse.json(
        {
          success: false,
          error: `У номера ${bookingRows[0].active} активных броней — удаление невозможно. Снимите номер с продажи (деактивация) или дождитесь выезда гостей.`,
        },
        { status: 409 }
      );
    }

    // Любые брони (включая отменённые) ссылаются на номер по FK без
    // ON DELETE — удаление строки нарушило бы ссылку и рвало историю
    // броней, поэтому при наличии истории деактивируем
    if (bookingRows[0].total > 0) {
      await pool.query(
        `UPDATE accommodation_rooms SET is_active = false, updated_at = NOW() WHERE id = $1`,
        [id]
      );
      return NextResponse.json({
        success: true,
        data: { deactivated: true },
        message: 'У номера есть прошедшие брони — номер снят с продажи, история сохранена',
      });
    }

    await pool.query(`DELETE FROM accommodation_rooms WHERE id = $1`, [id]);
    return NextResponse.json({ success: true, data: { deleted: true }, message: 'Номер удалён' });
  } catch {
    return NextResponse.json({ success: false, error: 'Ошибка при удалении номера' }, { status: 500 });
  }
}
