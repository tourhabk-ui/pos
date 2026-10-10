/**
 * GET /api/admin/stay-requests — заявки гостей хозяевам жилья (1206, 1213).
 *
 * Повод — 10.10: владелец отправил тестовую заявку в «Кутху» через Claude и
 * не нашёл её нигде, кроме заглушки в Telegram. Заявки писались в базу, но
 * не читались ни одним экраном. Здесь — последние заявки целиком: объект,
 * даты, гости, имя и телефон гостя (администратору они положены — он
 * подхватывает заявку, которая хозяину не дошла), откуда пришла и куда дошла.
 *
 * Отказ базы — 503 с причиной в логе, а не пустой список (§4.0).
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { logStayFailure } from '@/lib/stay/db-failure';

export const dynamic = 'force-dynamic';

const QuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

interface StayRequestRow {
  id: string;
  created_at: Date;
  accommodation_id: string;
  accommodation_name: string;
  partner_id: string | null;
  partner_name: string | null;
  owner_on_max: boolean;
  owner_on_telegram: boolean;
  check_in_date: string;
  check_out_date: string;
  guests: number;
  guest_name: string;
  guest_phone: string;
  comment: string | null;
  door: string | null;
  owner_channel: string | null;
  owner_reason: string | null;
  platform_channel: string | null;
  platform_reason: string | null;
  delivery_recorded_at: Date | null;
}

export async function GET(request: NextRequest) {
  const authOrResponse = await requireAdmin(request);
  if (authOrResponse instanceof NextResponse) return authOrResponse;

  const parsed = QuerySchema.safeParse({ limit: request.nextUrl.searchParams.get('limit') ?? undefined });
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: 'Неверные параметры запроса' }, { status: 400 });
  }

  try {
    const [list, total] = await Promise.all([
      pool.query<StayRequestRow>(
        `SELECT r.id, r.created_at, r.accommodation_id, a.name AS accommodation_name,
                p.id AS partner_id, p.name AS partner_name,
                (p.max_chat_id IS NOT NULL) AS owner_on_max,
                (p.telegram_chat_id IS NOT NULL) AS owner_on_telegram,
                to_char(r.check_in_date, 'YYYY-MM-DD') AS check_in_date,
                to_char(r.check_out_date, 'YYYY-MM-DD') AS check_out_date,
                r.guests, r.guest_name, r.guest_phone, r.comment, r.door,
                r.owner_channel, r.owner_reason, r.platform_channel, r.platform_reason,
                r.delivery_recorded_at
           FROM stay_requests r
           JOIN accommodations a ON a.id = r.accommodation_id
           LEFT JOIN partners p ON p.id = a.partner_id
          ORDER BY r.created_at DESC
          LIMIT $1`,
        [parsed.data.limit],
      ),
      pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM stay_requests`),
    ]);

    return NextResponse.json({
      success: true,
      data: {
        total: Number(total.rows[0]?.n ?? 0),
        requests: list.rows.map((r) => ({
          id: r.id,
          createdAt: r.created_at.toISOString(),
          accommodationId: r.accommodation_id,
          accommodationName: r.accommodation_name,
          partnerId: r.partner_id,
          partnerName: r.partner_name,
          ownerOnMax: r.owner_on_max === true,
          ownerOnTelegram: r.owner_on_telegram === true,
          checkIn: r.check_in_date,
          checkOut: r.check_out_date,
          guests: r.guests,
          guestName: r.guest_name,
          guestPhone: r.guest_phone,
          comment: r.comment,
          door: r.door,
          ownerChannel: r.owner_channel,
          ownerReason: r.owner_reason,
          platformChannel: r.platform_channel,
          platformReason: r.platform_reason,
          deliveryRecordedAt: r.delivery_recorded_at ? r.delivery_recorded_at.toISOString() : null,
        })),
      },
    });
  } catch (err) {
    logStayFailure('admin stay-requests', err);
    return NextResponse.json(
      { success: false, error: 'Заявки не загружены: база не ответила. Причина — в логе сервера.' },
      { status: 503 },
    );
  }
}
