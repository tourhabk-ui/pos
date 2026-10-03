/**
 * POST /api/safety/watch-status — состояние контроля выхода для экстренного
 * контакта (страница /watch).
 *
 * Вход тот же, что у отметок (`openRegistrationForMark`): владелец аккаунта
 * либо номер телефона руководителя группы. Ссылки из тревоги мало — её можно
 * переслать, а последняя точка человека — персональные данные, которые идут
 * только тому, кого они спасают (docs/safety/WATCH_MANIFEST.md, правило 9).
 *
 * Только чтение. Что отдаётся и когда точки нет — lib/safety/watch-status.ts.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query } from '@/lib/database';
import { createRateLimiter, getClientIp } from '@/lib/rate-limit';
import { openRegistrationForMark, markDenied } from '@/lib/safety/registration-mark';
import { watchView, type WatchRow } from '@/lib/safety/watch-status';

export const dynamic = 'force-dynamic';

// Страница обновляется раз в минуту; запас — на ручные обновления и
// подбор номера (подбирать номер перебором и должно быть дорого).
const limiter = createRateLimiter({ windowMs: 60_000, max: 10 });

const Schema = z.object({
  registration_id: z.string().uuid('Неверная ссылка: номер контроля не распознан'),
  leader_phone: z.string().max(30, 'Слишком длинный номер').optional(),
});

export async function POST(request: NextRequest) {
  if (!limiter.check(getClientIp(request.headers))) {
    return NextResponse.json({ success: false, error: 'Слишком часто — подождите минуту' }, { status: 429 });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Неверный формат запроса' }, { status: 400 });
  }
  const parsed = Schema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message || 'Ошибка валидации' },
      { status: 400 },
    );
  }
  const { registration_id, leader_phone } = parsed.data;

  try {
    const access = await openRegistrationForMark(request, registration_id, leader_phone);
    if (!access.ok) return markDenied(access);

    const { rows } = await query<WatchRow>(
      `SELECT route_name, trip_kind, expected_return_at, completed_at, closed_reason,
              checkin_confirmed_at, mchs_informed_at,
              last_position_lat, last_position_lng, last_position_at, last_position_source
         FROM route_registrations
        WHERE id = $1`,
      [registration_id],
    );
    if (rows.length === 0) {
      return NextResponse.json({ success: false, error: 'Маршрут не найден', reason: 'not_found' }, { status: 404 });
    }
    return NextResponse.json({ success: true, watch: watchView(rows[0], new Date()) });
  } catch (e) {
    console.error('[watch-status] не удалось прочитать контроль:', e instanceof Error ? e.message : String(e));
    return NextResponse.json({ success: false, error: 'Не удалось получить состояние — попробуйте позже' }, { status: 500 });
  }
}
