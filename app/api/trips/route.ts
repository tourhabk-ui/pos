/**
 * GET  /api/trips          — список сохранённых маршрутов авторизованного пользователя
 * POST /api/trips          — создать новый сохранённый маршрут
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { requireAuth } from '@/lib/auth/middleware';
import { attachMcpAttribution, MCP_ATTRIBUTION } from '@/lib/mcp/handoff';
import type { UserTripListRow, UserTripRow } from '@/lib/types/db-rows';
import { CreateTripSchema, buildTripInsert } from '@/lib/trips/trip-write';
import { withCalendarDates } from '@/lib/trips/trip-dates';

export const dynamic = 'force-dynamic';

/**
 * Отказ базы — в лог с SQLSTATE, человеку — общие слова (аудит 07.11, H11):
 * до этого текст ошибки драйвера уходил наружу, а в лог не попадало ничего.
 */
function failed(what: string, err: unknown, message: string): NextResponse {
  const e = err as { code?: unknown; message?: unknown };
  console.error(`[trips] ${what}:`, typeof e?.code === 'string' ? e.code : 'нет SQLSTATE', typeof e?.message === 'string' ? e.message.slice(0, 300) : '');
  return NextResponse.json({ success: false, error: message }, { status: 500 });
}

// ─── GET — list ───────────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const authOrResponse = await requireAuth(request);
  if (authOrResponse instanceof NextResponse) return authOrResponse;

  const userId = authOrResponse.userId;

  try {
    const { rows } = await pool.query<UserTripListRow>(`
      SELECT
        id, title,
        arrival_date, departure_date,
        places, activities,
        jsonb_array_length(days) AS days_count,
        created_at, updated_at
      FROM user_trips
      WHERE user_id = $1
        AND deleted_at IS NULL
      ORDER BY updated_at DESC
      LIMIT 50
    `, [userId]);

    return NextResponse.json({ success: true, data: rows.map(withCalendarDates) });
  } catch (err) {
    return failed('список поездок не прочитан', err, 'Маршруты сейчас не загрузились — попробуйте чуть позже');
  }
}

// ─── POST — create ────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const authOrResponse = await requireAuth(request);
  if (authOrResponse instanceof NextResponse) return authOrResponse;

  const userId = authOrResponse.userId;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Неверный формат запроса' }, { status: 400 });
  }
  const parsed = CreateTripSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: 'Некорректные данные', details: parsed.error.issues },
      { status: 400 }
    );
  }

  try {
    // С ключом повтора (H12) тот же POST обновляет ту же поездку: ответ на
    // первое нажатие мог потеряться в сети, а второй поездки человек не просил.
    const { sql, values } = buildTripInsert(userId, parsed.data);
    const { rows } = await pool.query<UserTripRow & { inserted: boolean }>(sql, values);
    const { inserted, ...trip } = rows[0]!;

    // Атрибуция MCP-handoff (v2, #60): человек пришёл по ссылке агента и
    // сохранил план. В событие идёт только UUID handoff-а из проверенной
    // cookie — содержимого плана там нет. Повтор того же сохранения — не
    // второе событие.
    if (inserted) {
      await attachMcpAttribution(
        request.cookies.get(MCP_ATTRIBUTION.cookieName)?.value,
        'plan_saved',
      );
    }

    return NextResponse.json({ success: true, data: withCalendarDates(trip) }, { status: inserted ? 201 : 200 });
  } catch (err) {
    return failed('поездка не сохранена', err, 'Маршрут не сохранился — попробуйте ещё раз');
  }
}
