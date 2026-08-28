/**
 * POST /api/safety/checkin — лёгкий чек-ин «я в порядке» (issue #1420).
 *
 * НЕ SOS. Не запускает ничью реакцию, ничего не эскалирует — это мягкий
 * необязательный сигнал с /safety, куда уже ведёт push из external_alerts
 * (lib/services/safety/push-copy.ts) и обновление статуса зоны
 * (lib/agents/agencies/danger-analyst-agency.ts). SOS остаётся единственным
 * каналом вызова — components/shared/EmergencyAction.tsx, отдельная кнопка.
 *
 * Анонимный: на /safety нет логина. Геолокация необязательна.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { pool } from '@/lib/db-pool';
import { createRateLimiter, getClientIp } from '@/lib/rate-limit';
import { ZONES } from '@/lib/agents/agencies/danger-analyst-agency';

export const dynamic = 'force-dynamic';

const limiter = createRateLimiter({ windowMs: 60_000, max: 5 });

const BodySchema = z.object({
  zone: z.enum(ZONES).nullable().optional(),
  lat: z.number().min(-90).max(90).nullable().optional(),
  lng: z.number().min(-180).max(180).nullable().optional(),
});

export async function POST(request: NextRequest) {
  if (!limiter.check(getClientIp(request.headers))) {
    return NextResponse.json({ success: false, error: 'Слишком часто — подождите минуту' }, { status: 429 });
  }

  let data: z.infer<typeof BodySchema>;
  try {
    data = BodySchema.parse(await request.json());
  } catch {
    return NextResponse.json({ success: false, error: 'Некорректные данные' }, { status: 400 });
  }

  const hasLat = typeof data.lat === 'number';
  const hasLng = typeof data.lng === 'number';
  if (hasLat !== hasLng) {
    return NextResponse.json({ success: false, error: 'Координата принимается парой' }, { status: 400 });
  }

  try {
    await pool.query(
      `INSERT INTO safety_checkins (zone, lat, lng) VALUES ($1, $2, $3)`,
      [data.zone ?? null, hasLat ? data.lat : null, hasLng ? data.lng : null],
    );
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[safety/checkin] запись не удалась:', err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: 'Не удалось сохранить отметку' }, { status: 502 });
  }
}
