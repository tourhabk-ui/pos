/**
 * GET  /api/hub/agent/referral — список реф. ссылок агента + статистика
 * POST /api/hub/agent/referral — создать новую реф. ссылку
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAgent } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { z } from 'zod';
import { randomBytes } from 'crypto';

export const dynamic = 'force-dynamic';

const CreateSchema = z.object({
  tourId:         z.coerce.number().int().positive().optional(),
  commissionRate: z.number().min(1).max(30).default(10),
  expiresAt:      z.string().datetime().optional(),
});

export async function GET(request: NextRequest) {
  const auth = await requireAgent(request);
  if (auth instanceof NextResponse) return auth;

  // Конверсии и заработок считаем ЖИВО из источника истины
  // operator_bookings.referral_link_id (миграция 727), а не из сломанного
  // прежде join к agent_bookings (UUID vs BIGINT). rl.conversions — легаси-кэш.
  // conversions — все атрибутированные брони (воронка); earned_total — только
  // оплаченные (payment_status='paid'), чтобы отменённые/неоплаченные не раздували заработок.
  const { rows } = await pool.query(
    `SELECT
       rl.id, rl.code, rl.tour_id, rl.clicks,
       rl.commission_rate, rl.expires_at, rl.is_active, rl.created_at,
       ot.title AS tour_title,
       (SELECT COUNT(*) FROM operator_bookings ob WHERE ob.referral_link_id = rl.id)::int AS conversions,
       COALESCE(
         (SELECT SUM(ob.final_price) FROM operator_bookings ob
           WHERE ob.referral_link_id = rl.id AND ob.payment_status = 'paid'), 0
       ) * rl.commission_rate / 100 AS earned_total
     FROM agent_referral_links rl
     LEFT JOIN operator_tours ot ON ot.id = rl.tour_id
     WHERE rl.agent_id = $1
     ORDER BY rl.created_at DESC`,
    [auth.userId]
  );

  const stats = {
    totalClicks:      rows.reduce((s, r) => s + Number(r.clicks), 0),
    totalConversions: rows.reduce((s, r) => s + Number(r.conversions), 0),
    totalEarned:      rows.reduce((s, r) => s + Number(r.earned_total), 0),
  };

  return NextResponse.json({ success: true, data: rows, stats });
}

export async function POST(request: NextRequest) {
  const auth = await requireAgent(request);
  if (auth instanceof NextResponse) return auth;

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ success: false, error: 'Некорректный JSON' }, { status: 400 });
  }

  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message },
      { status: 400 }
    );
  }

  const { tourId, commissionRate, expiresAt } = parsed.data;

  // Генерируем код: KH-AGT-XXXX
  const code = `KH-AGT-${randomBytes(3).toString('hex').toUpperCase()}`;

  const { rows } = await pool.query(
    `INSERT INTO agent_referral_links
       (agent_id, tour_id, code, commission_rate, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, code, tour_id, commission_rate, expires_at, created_at`,
    [auth.userId, tourId ?? null, code, commissionRate, expiresAt ?? null]
  );

  return NextResponse.json({ success: true, data: rows[0] }, { status: 201 });
}
