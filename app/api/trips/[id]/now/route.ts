/**
 * GET /api/trips/[id]/now — сохранённая поездка, перепроверенная сегодня.
 *
 * Слово владельца 19.11: «3394 начни с обновления плана ближе к датам».
 * Только владельцу поездки (вход и строка `user_trips` этого человека — то же
 * условие, что у GET /api/trips/[id]). Только чтение: план не меняется.
 *
 * Что изменилось с дня сохранения — строки безопасности дней (закрытия парков,
 * штормовые и паводковые, сводки МЧС), места туров на их даты для всей группы,
 * прогноз в пределах 16 суток. Правило — lib/trips/trip-now.
 *
 * Исходы: проверено; дат нет; поездка прошла; маршрут не найден (404); не
 * прочитался (500). Отказ базы — в лог с SQLSTATE, человеку — общие слова.
 */
import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { requireAuth } from '@/lib/auth/middleware';
import type { UserTripRow } from '@/lib/types/db-rows';
import { OWNED_TRIP_SQL } from '@/lib/trips/trip-write';
import { withCalendarDates } from '@/lib/trips/trip-dates';
import { checkTripNow } from '@/lib/trips/trip-now';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

type RouteContext = { params: Promise<{ id: string }> };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: NextRequest, ctx: RouteContext) {
  const authOrResponse = await requireAuth(request);
  if (authOrResponse instanceof NextResponse) return authOrResponse;

  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ success: false, error: 'Маршрут не найден' }, { status: 404 });
  }

  try {
    const { rows } = await pool.query<UserTripRow>(OWNED_TRIP_SQL, [id, authOrResponse.userId]);
    const row = rows[0];
    if (!row) return NextResponse.json({ success: false, error: 'Маршрут не найден' }, { status: 404 });
    const trip = withCalendarDates(row);
    const now = await checkTripNow({ arrival_date: trip.arrival_date, days: trip.days ?? [], party: trip.party });
    return NextResponse.json({ success: true, data: now });
  } catch (err) {
    const e = err as { code?: unknown; message?: unknown };
    console.error('[trips/now] перепроверка поездки не выполнилась:',
      typeof e?.code === 'string' ? e.code : 'нет SQLSTATE',
      typeof e?.message === 'string' ? e.message.slice(0, 300) : '');
    return NextResponse.json({ success: false, error: 'Проверить план сейчас не получилось — попробуйте чуть позже' }, { status: 500 });
  }
}
