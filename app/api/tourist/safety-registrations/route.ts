/**
 * GET /api/tourist/safety-registrations — регистрации маршрутов (контрольные
 * сроки) текущего туриста. JWT обязателен.
 *
 * Переиспользует существующий бэкенд безопасности (route_registrations +
 * watchdog эскалации). Раньше регистрация жила только на страницах маршрута/
 * карты/парка и на /register — в ЛК её не было видно. Этот эндпоинт даёт
 * туристу список своих активных контрольных сроков, чтобы отметить возвращение
 * прямо из кабинета.
 */

import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/database';
import { requireAuth } from '@/lib/auth/middleware';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  const { rows } = await query(
    `SELECT id, route_name, region, start_date, end_date,
            expected_return_at, checkin_confirmed_at, completed_at,
            group_size, leader_phone,
            emergency_contact_name, emergency_contact_phone
       FROM route_registrations
      WHERE user_id = $1
      ORDER BY (completed_at IS NULL) DESC,
               COALESCE(expected_return_at, end_date::timestamptz) DESC
      LIMIT 50`,
    [auth.userId],
  );

  return NextResponse.json({ success: true, data: rows });
}
