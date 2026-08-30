/**
 * POST /api/safety/mchs-informed — «сообщили в МЧС о завершении маршрута».
 *
 * Отдельно от /api/safety/return (миграция 920): фактическое возвращение
 * группы и подтверждение территориальному органу МЧС о завершении — два
 * разных события с разными датами (человек мог дойти домой, а позвонить в
 * МЧС — позже, или наоборот, предупредить заранее). Смешивать их в одном
 * поле значило утверждать то, чего платформа не знает: /api/safety/return
 * раньше отвечал туристу «маршрут закрыт», хотя закрытие в терминах
 * реального журнала МЧС — это ДВА подтверждённых факта, а мы знали только
 * один.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query } from '@/lib/database';
import { verifyAuth } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const InformedSchema = z.object({
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

  const parsed = InformedSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message || 'Ошибка валидации' },
      { status: 400 },
    );
  }

  const { registration_id, leader_phone } = parsed.data;

  const auth = await verifyAuth(request).catch(() => ({ isAuthenticated: false, userId: null }));

  const existing = await query(
    `SELECT id, route_name, leader_phone, user_id, mchs_informed_at
     FROM route_registrations WHERE id = $1`,
    [registration_id],
  );

  if (existing.rows.length === 0) {
    return NextResponse.json({ success: false, error: 'Маршрут не найден' }, { status: 404 });
  }

  const reg = existing.rows[0] as {
    id: string; route_name: string; leader_phone: string;
    user_id: string | null; mchs_informed_at: string | null;
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

  if (reg.mchs_informed_at) {
    return NextResponse.json({
      success: true,
      message: 'Уже отмечено, что МЧС проинформирован',
      already_informed: true,
    });
  }

  await query(
    `UPDATE route_registrations SET mchs_informed_at = now() WHERE id = $1`,
    [registration_id],
  );

  return NextResponse.json({
    success: true,
    message: `Отмечено: МЧС проинформирован о завершении маршрута «${reg.route_name}».`,
    route_name: reg.route_name,
  });
}
