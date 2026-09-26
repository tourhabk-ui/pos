/**
 * GET /api/admin/accommodations — очередь модерации объектов жилья.
 *
 * Решение владельца 26.09: объект выходит на витрину только после одобрения
 * администратором (миграция 1027). Здесь — список по статусу проверки и
 * счётчики для вкладок. Решение — PATCH /api/admin/accommodations/[id].
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { logStayFailure } from '@/lib/stay/db-failure';

export const dynamic = 'force-dynamic';

const QuerySchema = z.object({
  status: z.enum(['all', 'pending', 'approved', 'rejected']).default('pending'),
  limit:  z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

interface AdminAccommodationRow {
  id: string;
  name: string;
  type: string;
  short_description: string | null;
  description: string | null;
  address: string | null;
  coordinates: unknown;
  total_rooms: number | null;
  price_per_night_from: string | null;
  is_active: boolean;
  is_verified: boolean;
  moderation_status: string;
  moderation_reason: string | null;
  planner_zone: string | null;
  moderated_at: string | null;
  created_at: string;
  partner_name: string | null;
  owner_email: string | null;
  rooms_count: number;
  photos_count: number;
}

export async function GET(request: NextRequest) {
  const authOrResponse = await requireAdmin(request);
  if (authOrResponse instanceof NextResponse) return authOrResponse;

  const sp = request.nextUrl.searchParams;
  const parsed = QuerySchema.safeParse({
    status: sp.get('status') ?? undefined,
    limit:  sp.get('limit') ?? undefined,
    offset: sp.get('offset') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: 'Неверные параметры запроса' }, { status: 400 });
  }
  const { status, limit, offset } = parsed.data;

  try {
    const { rows } = await pool.query<AdminAccommodationRow>(
      `SELECT a.id, a.name, a.type, a.short_description, a.description, a.address,
              a.coordinates, a.total_rooms, a.price_per_night_from,
              a.is_active, a.is_verified,
              a.moderation_status, a.moderation_reason, a.moderated_at, a.created_at,
              a.planner_zone,
              p.name AS partner_name,
              u.email AS owner_email,
              (SELECT COUNT(*)::int FROM accommodation_rooms r WHERE r.accommodation_id = a.id AND r.is_active = true) AS rooms_count,
              (SELECT COUNT(*)::int FROM accommodation_assets aa WHERE aa.accommodation_id = a.id) AS photos_count
         FROM accommodations a
         LEFT JOIN partners p ON p.id = a.partner_id
         LEFT JOIN users u ON u.id = p.user_id
        WHERE ($1::text = 'all' OR a.moderation_status = $1::text)
        ORDER BY a.created_at DESC
        LIMIT $2 OFFSET $3`,
      [status, limit, offset]
    );

    const counts = await pool.query<{ moderation_status: string; n: number }>(
      `SELECT moderation_status, COUNT(*)::int AS n FROM accommodations GROUP BY moderation_status`
    );

    return NextResponse.json({
      success: true,
      data: {
        accommodations: rows.map(r => ({
          id: r.id,
          name: r.name,
          type: r.type,
          shortDescription: r.short_description,
          description: r.description,
          address: r.address,
          coordinates: r.coordinates,
          totalRooms: r.total_rooms,
          pricePerNightFrom: r.price_per_night_from === null ? null : Number(r.price_per_night_from),
          isActive: r.is_active,
          isVerified: r.is_verified,
          moderationStatus: r.moderation_status,
          moderationReason: r.moderation_reason,
          // null — зона не размечена: планер объект не предлагает (миграция 1031).
          plannerZone: r.planner_zone,
          moderatedAt: r.moderated_at,
          createdAt: r.created_at,
          partnerName: r.partner_name,
          ownerEmail: r.owner_email,
          roomsCount: r.rooms_count,
          photosCount: r.photos_count,
        })),
        counts: Object.fromEntries(counts.rows.map(c => [c.moderation_status, c.n])),
      },
    });
  } catch (error) {
    logStayFailure('GET /api/admin/accommodations', error);
    return NextResponse.json(
      { success: false, error: 'Не удалось загрузить очередь объектов жилья' },
      { status: 500 }
    );
  }
}
