/**
 * GET    /api/trips/[id]   — загрузить один сохранённый маршрут
 * PATCH  /api/trips/[id]   — обновить маршрут
 * DELETE /api/trips/[id]   — мягкое удаление
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { requireAuth } from '@/lib/auth/middleware';
import type { UserTripRow } from '@/lib/types/db-rows';
import { TRIP_SELECT, UpdateTripSchema, buildTripUpdate } from '@/lib/trips/trip-write';
import { withCalendarDates } from '@/lib/trips/trip-dates';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function getTripOwned(tripId: string, userId: string): Promise<UserTripRow | null> {
  const { rows } = await pool.query<UserTripRow>(
    `SELECT ${TRIP_SELECT}
     FROM user_trips WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [tripId, userId]
  );
  return rows[0] ?? null;
}

/** Отказ базы — в лог с SQLSTATE, человеку — общие слова (аудит 07.11, H11). */
function failed(what: string, err: unknown, message: string): NextResponse {
  const e = err as { code?: unknown; message?: unknown };
  console.error(`[trips/id] ${what}:`, typeof e?.code === 'string' ? e.code : 'нет SQLSTATE', typeof e?.message === 'string' ? e.message.slice(0, 300) : '');
  return NextResponse.json({ success: false, error: message }, { status: 500 });
}

// ─── GET ──────────────────────────────────────────────────────────────────────

export async function GET(request: NextRequest, ctx: RouteContext) {
  const authOrResponse = await requireAuth(request);
  if (authOrResponse instanceof NextResponse) return authOrResponse;

  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ success: false, error: 'Маршрут не найден' }, { status: 404 });
  }
  let trip: UserTripRow | null;
  try {
    trip = await getTripOwned(id, authOrResponse.userId);
  } catch (err) {
    return failed('поездка не прочитана', err, 'Маршрут сейчас не загрузился — попробуйте чуть позже');
  }

  if (!trip) {
    return NextResponse.json({ success: false, error: 'Маршрут не найден' }, { status: 404 });
  }

  return NextResponse.json({ success: true, data: withCalendarDates(trip) });
}

// ─── PATCH ────────────────────────────────────────────────────────────────────

export async function PATCH(request: NextRequest, ctx: RouteContext) {
  const authOrResponse = await requireAuth(request);
  if (authOrResponse instanceof NextResponse) return authOrResponse;

  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ success: false, error: 'Маршрут не найден' }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Неверный формат запроса' }, { status: 400 });
  }
  const parsed = UpdateTripSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: 'Некорректные данные', details: parsed.error.issues },
      { status: 400 }
    );
  }

  try {
    // Только присланные поля; null — стереть (аудит 07.11, H9). До этого
    // каждое поле шло через COALESCE, и убранный рейс оставался в поездке.
    const { sets, values } = buildTripUpdate(parsed.data, 3);
    if (sets.length === 0) {
      const trip = await getTripOwned(id, authOrResponse.userId);
      if (!trip) return NextResponse.json({ success: false, error: 'Маршрут не найден' }, { status: 404 });
      return NextResponse.json({ success: true, data: withCalendarDates(trip) });
    }
    const { rows } = await pool.query<UserTripRow>(
      `UPDATE user_trips SET ${sets.join(', ')}
        WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
        RETURNING ${TRIP_SELECT}`,
      [id, authOrResponse.userId, ...values],
    );
    if (rows.length === 0) {
      return NextResponse.json({ success: false, error: 'Маршрут не найден' }, { status: 404 });
    }
    return NextResponse.json({ success: true, data: withCalendarDates(rows[0]) });
  } catch (err) {
    return failed('поездка не обновлена', err, 'Маршрут не сохранился — попробуйте ещё раз');
  }
}

// ─── DELETE ───────────────────────────────────────────────────────────────────

export async function DELETE(request: NextRequest, ctx: RouteContext) {
  const authOrResponse = await requireAuth(request);
  if (authOrResponse instanceof NextResponse) return authOrResponse;

  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ success: false, error: 'Маршрут не найден' }, { status: 404 });
  }
  const existing = await getTripOwned(id, authOrResponse.userId);

  if (!existing) {
    return NextResponse.json({ success: false, error: 'Маршрут не найден' }, { status: 404 });
  }

  // Режим «я в поездке» гасим В ОДНОЙ транзакции с удалением.
  //
  // Внешний ключ users.active_trip_id объявлен ON DELETE SET NULL, но здесь
  // удаление МЯГКОЕ — строка остаётся, только проставляется deleted_at. Значит
  // каскад не сработает никогда, и ссылка на скрытую поездку останется висеть.
  // Получился бы «призрачный» режим: поездки в списке уже нет, а главная
  // показывает маршрут, и выключить его штатно нельзя — переключатель отвергает
  // удалённую поездку. Каскад остаётся страховкой на случай физического
  // удаления (чистки, миграции), но рабочий путь — этот.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Только если активна ИМЕННО эта поездка: во второй вкладке человек мог
    // сделать активной другую, и её гасить нельзя.
    await client.query(
      `UPDATE users
          SET active_trip_id = NULL, active_trip_since = NULL, updated_at = NOW()
        WHERE id = $1 AND active_trip_id = $2`,
      [authOrResponse.userId, id],
    );

    await client.query(
      `UPDATE user_trips SET deleted_at = NOW()
        WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [id, authOrResponse.userId],
    );

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  return NextResponse.json({ success: true });
}
