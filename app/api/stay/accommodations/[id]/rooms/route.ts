import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { requireAccommodationAccess } from '@/lib/auth/stay-helpers';
import { ROOM_TYPES } from '@/lib/stay/room-types';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const CreateRoomSchema = z.object({
  name:              z.string().min(1, 'Название номера обязательно').max(255),
  roomType:          z.enum(ROOM_TYPES),
  description:       z.string().max(2000).nullish(),
  sizeSqm:           z.number().int().positive().nullish(),
  maxGuests:         z.number().int().min(1, 'Вместимость: минимум 1 гость'),
  bedsConfiguration: z.record(z.string(), z.unknown()).nullish(),
  amenities:         z.array(z.string().max(100)).max(50).optional(),
  view:              z.string().max(50).nullish(),
  availableRooms:    z.number().int().min(0, 'Количество номеров не может быть отрицательным'),
  pricePerNight:     z.number().min(0, 'Цена не может быть отрицательной'),
});

// ─── GET /api/stay/accommodations/[id]/rooms ──────────────────────────────────
// Номера объекта для владельца (включая неактивные).

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const authOrResponse = await requireAccommodationAccess(request, id);
  if (authOrResponse instanceof NextResponse) return authOrResponse;

  try {
    const { rows } = await pool.query(
      `SELECT r.id, r.name, r.room_type, r.description, r.size_sqm, r.max_guests,
              r.beds_configuration, r.amenities, r.view, r.available_rooms,
              r.price_per_night, r.is_active, r.created_at, r.updated_at,
              (SELECT COUNT(*) FROM accommodation_bookings b
               WHERE b.room_id = r.id AND b.status IN ('pending', 'confirmed')
                 AND b.check_out_date > CURRENT_DATE)::int AS active_bookings
       FROM accommodation_rooms r
       WHERE r.accommodation_id = $1
       ORDER BY r.created_at ASC`,
      [id]
    );

    return NextResponse.json({
      success: true,
      data: {
        rooms: rows.map(r => ({
          id: r.id,
          name: r.name,
          roomType: r.room_type,
          description: r.description,
          sizeSqm: r.size_sqm,
          maxGuests: r.max_guests,
          bedsConfiguration: r.beds_configuration,
          amenities: r.amenities,
          view: r.view,
          availableRooms: r.available_rooms,
          pricePerNight: Number(r.price_per_night),
          isActive: r.is_active,
          activeBookings: r.active_bookings,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        })),
      },
    });
  } catch {
    return NextResponse.json({ success: false, error: 'Ошибка при получении номеров' }, { status: 500 });
  }
}

// ─── POST /api/stay/accommodations/[id]/rooms ─────────────────────────────────
// Создание номера владельцем.

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const authOrResponse = await requireAccommodationAccess(request, id);
  if (authOrResponse instanceof NextResponse) return authOrResponse;

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ success: false, error: 'Некорректный JSON' }, { status: 400 });
  }

  const parsed = CreateRoomSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' },
      { status: 400 }
    );
  }
  const d = parsed.data;

  try {
    const { rows } = await pool.query(
      `INSERT INTO accommodation_rooms (
         accommodation_id, name, room_type, description, size_sqm, max_guests,
         beds_configuration, amenities, view, available_rooms, price_per_night
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id, name, room_type, is_active`,
      [
        id, d.name, d.roomType, d.description ?? null, d.sizeSqm ?? null, d.maxGuests,
        d.bedsConfiguration ? JSON.stringify(d.bedsConfiguration) : null,
        JSON.stringify(d.amenities ?? []), d.view ?? null, d.availableRooms, d.pricePerNight,
      ]
    );

    return NextResponse.json(
      { success: true, data: rows[0], message: 'Номер создан' },
      { status: 201 }
    );
  } catch {
    return NextResponse.json({ success: false, error: 'Ошибка при создании номера' }, { status: 500 });
  }
}
