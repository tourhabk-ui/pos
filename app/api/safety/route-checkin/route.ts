/**
 * POST /api/safety/route-checkin — «мы ещё на маршруте, всё в порядке».
 *
 * Отдельно от /api/safety/return: там человек подтверждает полный возврат,
 * здесь — что группа жива и на связи, но ещё не дошла. Это единственная
 * ступень лестницы эскалации (soft, lib/safety/checkin-escalation.ts), где
 * decideEscalation умеет гасить тревогу подтверждением без completed_at —
 * но до этого роута `checkin_confirmed_at` (миграция 680) не писал никто, и
 * ступень фактически не работала: единственным способом остановить эскалацию
 * было соврать «я вернулся».
 *
 * Гасит тревогу, только если подтверждение пришло ПОСЛЕ контрольного
 * времени — это логика decideEscalation, здесь мы просто пишем факт.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query } from '@/lib/database';
import { verifyAuth } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const CheckinSchema = z.object({
  registration_id: z.string().uuid(),
  leader_phone: z.string().max(30).optional(),
});

export async function POST(request: NextRequest) {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = CheckinSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message || 'Ошибка валидации' },
      { status: 400 },
    );
  }

  const { registration_id, leader_phone } = parsed.data;

  const auth = await verifyAuth(request).catch(() => ({ isAuthenticated: false, userId: null }));

  const existing = await query(
    `SELECT id, route_name, leader_phone, user_id, completed_at
     FROM route_registrations WHERE id = $1`,
    [registration_id],
  );

  if (existing.rows.length === 0) {
    return NextResponse.json({ success: false, error: 'Маршрут не найден' }, { status: 404 });
  }

  const reg = existing.rows[0] as {
    id: string; route_name: string; leader_phone: string;
    user_id: string | null; completed_at: string | null;
  };

  const authedOwner = auth.isAuthenticated && auth.userId && reg.user_id && auth.userId === reg.user_id;
  const phoneMatch = leader_phone && reg.leader_phone &&
    leader_phone.replace(/\D/g, '') === reg.leader_phone.replace(/\D/g, '');

  if (!authedOwner && !phoneMatch) {
    return NextResponse.json(
      { success: false, error: 'Для отметки укажите номер телефона руководителя группы' },
      { status: 403 },
    );
  }

  if (reg.completed_at) {
    return NextResponse.json({
      success: true,
      message: 'Возврат уже отмечен — дальше отмечать нечего',
      already_completed: true,
    });
  }

  await query(
    `UPDATE route_registrations SET checkin_confirmed_at = now() WHERE id = $1`,
    [registration_id],
  );

  return NextResponse.json({
    success: true,
    message: `Отметка принята: группа «${reg.route_name}» на связи. Не забудьте отметить возврат, когда дойдёте.`,
    route_name: reg.route_name,
  });
}

export async function GET(request: NextRequest) {
  const registrationId = request.nextUrl.searchParams.get('registration_id');
  if (!registrationId) {
    return NextResponse.json({ success: false, error: 'registration_id required' }, { status: 400 });
  }

  const result = await query(
    `SELECT id, route_name, leader_name, start_date, end_date, completed_at, checkin_confirmed_at
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
      checked_in: !!route.checkin_confirmed_at,
      checkin_confirmed_at: route.checkin_confirmed_at,
    },
  });
}
