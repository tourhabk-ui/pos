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
import { resolveControlTime } from '@/lib/safety/checkin-escalation';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  let rows: Array<Record<string, unknown>>;
  try {
    ({ rows } = await query(
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
    ));
  } catch (err) {
    // Отказ — не «регистраций нет» (§4.0): экран обязан сказать, что не знает.
    console.error('[tourist/safety-registrations] не прочитано:', err);
    return NextResponse.json(
      { success: false, error: 'Не удалось загрузить регистрации' },
      { status: 500 },
    );
  }

  // Контрольный срок считает СЕРВЕР той же функцией, что и эскалация: экран
  // обязан показывать то время, когда поднимется тревога. Клиент прежде
  // склеивал `${end_date}T23:59:00` к дате, которая приходит ISO-строкой, —
  // выходил Invalid Date, «Вернуться до: Invalid Date» и зелёный «Активен»
  // при просроченном сроке; и даже при удаче 23:59 расходилось с 20:00 сторожа.
  const data = rows.map(r => {
    const end = r.end_date instanceof Date ? r.end_date : new Date(String(r.end_date));
    const raw = r.expected_return_at;
    const exp = raw instanceof Date ? raw : raw ? new Date(String(raw)) : null;
    const control = Number.isNaN(end.getTime()) && !exp ? null : resolveControlTime(end, exp);
    return { ...r, control_at: control && !Number.isNaN(control.getTime()) ? control.toISOString() : null };
  });

  return NextResponse.json({ success: true, data });
}
