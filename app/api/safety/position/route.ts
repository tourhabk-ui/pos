/**
 * POST /api/safety/position
 * Записывает последнюю GPS-позицию для активной регистрации маршрута.
 * Вызывается с телефона пока есть связь — чтобы сторож знал последнюю точку.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query } from '@/lib/database';
import { requireAuth } from '@/lib/auth/middleware';
import type { JWTPayload } from '@/lib/auth/jwt';

const BodySchema = z.object({
  registrationId: z.string().uuid(),
  lat: z.number().min(50).max(58),
  lng: z.number().min(155).max(165),
});

export async function POST(req: NextRequest) {
  const userOrRes = await requireAuth(req);
  if (!('id' in userOrRes)) return userOrRes;
  const user = userOrRes as JWTPayload;

  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: 'Неверный JSON' }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Нужны registrationId, lat, lng' }, { status: 400 });
  }

  const { registrationId, lat, lng } = parsed.data;

  const { rowCount } = await query(
    `UPDATE route_registrations
     SET last_position_lat = $1, last_position_lng = $2, last_position_at = now()
     WHERE id = $3 AND user_id = $4 AND completed_at IS NULL`,
    [lat, lng, registrationId, user.id],
  );

  if (!rowCount) {
    return NextResponse.json({ error: 'Регистрация не найдена или уже закрыта' }, { status: 404 });
  }

  return NextResponse.json({ success: true });
}
