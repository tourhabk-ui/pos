import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/database';
import { ApiResponse } from '@/types';
import { requireAuth } from '@/lib/auth/middleware';
import { getStayPartnerId } from '@/lib/auth/stay-helpers';
import { ensurePartnerForRole } from '@/lib/auth/partner-profile';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

// Форма — по образцу admin-create (app/api/accommodations/create), но без
// partnerId (владелец создаёт только себе) и без images (фото — позже)
const CreateAccommodationSchema = z.object({
  name: z.string().min(3, 'Название должно быть минимум 3 символа').max(255),
  description: z.string().min(10, 'Описание должно быть минимум 10 символов').max(5000),
  shortDescription: z.string().max(500).optional(),
  type: z.enum(['hotel', 'hostel', 'apartment', 'guesthouse', 'resort', 'camping', 'glamping', 'cottage'], {
    message: 'Выберите тип размещения',
  }),
  address: z.string().min(5, 'Укажите адрес').max(500),
  coordinates: z.object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
  }),
  totalRooms: z.number().int().min(1, 'Укажите количество номеров'),
  pricePerNightFrom: z.number().min(0, 'Цена не может быть отрицательной'),
  pricePerNightTo: z.number().min(0).optional(),
  checkInTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  checkOutTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  amenities: z.array(z.string().max(100)).max(50).optional(),
});

/**
 * GET /api/stay/accommodations - Объекты владельца жилья (включая снятые с публикации)
 */
export async function GET(request: NextRequest) {
  try {
    const authResult = await requireAuth(request);
    if (authResult instanceof NextResponse) return authResult;
    const userId = authResult.userId;

    const partnerId = await getStayPartnerId(userId);
    if (!partnerId) {
      return NextResponse.json(
        { success: false, error: 'Профиль владельца жилья не найден' } as ApiResponse<null>,
        { status: 404 }
      );
    }

    const result = await query(
      `SELECT
        a.id, a.name, a.type, a.description, a.short_description, a.address,
        a.location_zone, a.star_rating, a.total_rooms,
        a.check_in_time, a.check_out_time,
        a.price_per_night_from, a.price_per_night_to, a.currency,
        a.amenities, a.rating, a.review_count,
        a.is_active, a.is_verified, a.created_at, a.updated_at,
        (SELECT COUNT(*) FROM accommodation_rooms r WHERE r.accommodation_id = a.id AND r.is_active = true) AS rooms_count,
        (SELECT COUNT(*) FROM accommodation_bookings b WHERE b.accommodation_id = a.id AND b.status = 'pending') AS pending_bookings
      FROM accommodations a
      WHERE a.partner_id = $1
      ORDER BY a.created_at DESC`,
      [partnerId]
    );

    return NextResponse.json({
      success: true,
      data: { accommodations: result.rows }
    } as ApiResponse<unknown>);

  } catch (error) {
    return NextResponse.json(
      { success: false, error: 'Ошибка при получении объектов размещения' } as ApiResponse<null>,
      { status: 500 }
    );
  }
}

/**
 * POST /api/stay/accommodations — владелец создаёт свой объект.
 * Раньше объекты создавал только админ (/api/accommodations/create) —
 * разрыв после регистрации по ролям (PR #361). Профиль партнёра при
 * отсутствии создаётся автоматически (ensurePartnerForRole).
 * Новый объект is_verified=false — верификация за платформой.
 */
export async function POST(request: NextRequest) {
  const authResult = await requireAuth(request);
  if (authResult instanceof NextResponse) return authResult;

  if (authResult.role !== 'stay' && authResult.role !== 'admin') {
    return NextResponse.json(
      { success: false, error: 'Создание объектов доступно владельцам жилья' } as ApiResponse<null>,
      { status: 403 }
    );
  }

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ success: false, error: 'Некорректный JSON' } as ApiResponse<null>, { status: 400 });
  }

  const parsed = CreateAccommodationSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' } as ApiResponse<null>,
      { status: 400 }
    );
  }
  const d = parsed.data;

  try {
    let partnerId = await getStayPartnerId(authResult.userId);
    if (!partnerId && authResult.role === 'stay') {
      partnerId = await ensurePartnerForRole(authResult.userId, 'stay');
    }
    if (!partnerId) {
      return NextResponse.json(
        { success: false, error: 'Профиль владельца жилья не найден' } as ApiResponse<null>,
        { status: 404 }
      );
    }

    const result = await query<{ id: string }>(
      `INSERT INTO accommodations (
        partner_id, name, description, short_description, type, address, coordinates,
        total_rooms, price_per_night_from, price_per_night_to,
        check_in_time, check_out_time, amenities,
        is_active, is_verified, created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, true, false, NOW(), NOW())
      RETURNING id`,
      [
        partnerId,
        d.name,
        d.description,
        d.shortDescription ?? d.description.substring(0, 100),
        d.type,
        d.address,
        JSON.stringify(d.coordinates),
        d.totalRooms,
        d.pricePerNightFrom,
        d.pricePerNightTo ?? null,
        d.checkInTime ?? '14:00',
        d.checkOutTime ?? '12:00',
        JSON.stringify(d.amenities ?? []),
      ]
    );

    return NextResponse.json(
      {
        success: true,
        data: { accommodationId: result.rows[0].id, name: d.name },
        message: 'Объект создан. После проверки платформой он получит отметку «Проверено».',
      } as ApiResponse<unknown>,
      { status: 201 }
    );
  } catch {
    return NextResponse.json(
      { success: false, error: 'Ошибка при создании объекта' } as ApiResponse<null>,
      { status: 500 }
    );
  }
}
