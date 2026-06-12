import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query } from '@/lib/database';
import { verifyAuth } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const ReturnSchema = z.object({
  registration_id: z.string().uuid(),
  // Требуется для неавторизованных туристов — совпадение с leader_phone в регистрации.
  // Авторизованные пользователи верифицируются через JWT (user_id matching).
  leader_phone: z.string().max(30).optional(),
});

export async function POST(request: NextRequest) {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = ReturnSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.errors[0]?.message || 'Ошибка валидации' },
      { status: 400 },
    );
  }

  const { registration_id, leader_phone } = parsed.data;

  const auth = await verifyAuth(request).catch(() => ({ isAuthenticated: false, userId: null }));

  const existing = await query(
    `SELECT id, route_name, leader_name, leader_phone, user_id, end_date, completed_at
     FROM route_registrations WHERE id = $1`,
    [registration_id],
  );

  if (existing.rows.length === 0) {
    return NextResponse.json({ success: false, error: 'Маршрут не найден' }, { status: 404 });
  }

  const reg = existing.rows[0] as {
    id: string; route_name: string; leader_name: string;
    leader_phone: string; user_id: string | null;
    end_date: string; completed_at: string | null;
  };

  // Проверка владельца: JWT-пользователь ИЛИ совпадение номера телефона руководителя.
  // Если ни того ни другого — запрещаем (иначе любой, кто знает UUID, может закрыть чужую регистрацию).
  const authedOwner = auth.isAuthenticated && auth.userId && reg.user_id && auth.userId === reg.user_id;
  const phoneMatch = leader_phone && reg.leader_phone &&
    leader_phone.replace(/\D/g, '') === reg.leader_phone.replace(/\D/g, '');

  if (!authedOwner && !phoneMatch) {
    return NextResponse.json(
      { success: false, error: 'Для подтверждения возврата укажите номер телефона руководителя группы' },
      { status: 403 },
    );
  }

  if (reg.completed_at) {
    return NextResponse.json({ success: true, message: 'Возврат уже отмечен', already_completed: true });
  }

  await query(
    `UPDATE route_registrations SET completed_at = now() WHERE id = $1`,
    [registration_id],
  );

  return NextResponse.json({
    success: true,
    message: `С возвращением! Маршрут "${reg.route_name}" закрыт.`,
    route_name: reg.route_name,
  });
}

export async function GET(request: NextRequest) {
  const registrationId = request.nextUrl.searchParams.get('registration_id');
  if (!registrationId) {
    return NextResponse.json({ success: false, error: 'registration_id required' }, { status: 400 });
  }

  const result = await query(
    `SELECT id, route_name, leader_name, start_date, end_date, completed_at, mchs_status
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
      mchs_status: route.mchs_status,
    },
  });
}
