/**
 * POST /api/safety/return — отметка о возвращении с маршрута (закрывает регистрацию).
 * GET  /api/safety/return?registration_id=… — карточка регистрации для страниц отметок.
 *
 * Право на отметку — общее для всех трёх отметок регистрации
 * (`lib/safety/registration-mark.ts`): аккаунт-владелец либо номер телефона
 * руководителя группы. Второй ключ обязателен потому, что тревога уходит
 * ЭКСТРЕННОМУ КОНТАКТУ, у которого нашего аккаунта нет.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query } from '@/lib/database';
import { createRateLimiter, getClientIp } from '@/lib/rate-limit';
import { openRegistrationForMark, markDenied } from '@/lib/safety/registration-mark';

export const dynamic = 'force-dynamic';

const limiter = createRateLimiter({ windowMs: 60_000, max: 10 });

const ReturnSchema = z.object({
  registration_id: z.string().uuid(),
  // Требуется для неавторизованных: совпадение с leader_phone в регистрации.
  // Авторизованный владелец проходит по JWT.
  leader_phone: z.string().max(30).optional(),
});

export async function POST(request: NextRequest) {
  if (!limiter.check(getClientIp(request.headers))) {
    return NextResponse.json({ success: false, error: 'Слишком часто — подождите минуту' }, { status: 429 });
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = ReturnSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message || 'Ошибка валидации' },
      { status: 400 },
    );
  }

  const { registration_id, leader_phone } = parsed.data;

  const access = await openRegistrationForMark(request, registration_id, leader_phone);
  if (!access.ok) return markDenied(access);

  const { reg } = access;

  if (reg.completed_at) {
    return NextResponse.json({ success: true, message: 'Возврат уже отмечен', already_completed: true });
  }

  await query(
    `UPDATE route_registrations SET completed_at = now() WHERE id = $1`,
    [registration_id],
  );

  return NextResponse.json({
    success: true,
    message: `С возвращением! Маршрут «${reg.route_name}» закрыт, напоминания остановлены.`,
    route_name: reg.route_name,
  });
}

export async function GET(request: NextRequest) {
  const registrationId = request.nextUrl.searchParams.get('registration_id');
  if (!registrationId) {
    return NextResponse.json({ success: false, error: 'registration_id required' }, { status: 400 });
  }

  const result = await query(
    `SELECT id, route_name, leader_name, start_date, end_date,
            completed_at, checkin_confirmed_at, mchs_informed_at, mchs_status
       FROM route_registrations WHERE id = $1`,
    [registrationId],
  );

  if (result.rows.length === 0) {
    return NextResponse.json({ success: false, error: 'Маршрут не найден' }, { status: 404 });
  }

  const route = result.rows[0];
  return NextResponse.json({
    success: true,
    route: {
      id: route.id,
      name: route.route_name,
      leader: route.leader_name,
      start_date: route.start_date,
      end_date: route.end_date,
      completed: !!route.completed_at,
      completed_at: route.completed_at,
      checkin_confirmed_at: route.checkin_confirmed_at,
      mchs_informed_at: route.mchs_informed_at,
      mchs_status: route.mchs_status,
    },
  });
}
