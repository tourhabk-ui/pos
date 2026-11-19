/**
 * POST /api/trips/[id]/replace-day — заменить день сохранённой поездки
 * новым черновиком. Тело: { day, interest }.
 *
 * Слово владельца 19.11: «3394 срез 2 делай» (#3347, рек. 2: «при новом
 * предупреждении — предложить замену дня как новый черновик»). Только
 * владельцу поездки — тем же условием, что у GET /api/trips/[id]. Сама
 * поездка не меняется: замена ложится новым черновиком плана и открывается на
 * /trip/<id>. Правило — lib/trips/trip-replace-day.
 *
 * Исходы (поле `state`): `drafted` — черновик есть; `refused` — заменить
 * нельзя, причина словами (каркас поездки, день прошёл, занятие нашлось только
 * в другой зоне…); `failed` — черновик не записался (503). Поездка не найдена
 * — 404; отказ базы — 500, в лог SQLSTATE.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { pool } from '@/lib/db-pool';
import { requireAuth } from '@/lib/auth/middleware';
import type { UserTripRow } from '@/lib/types/db-rows';
import { OWNED_TRIP_SQL } from '@/lib/trips/trip-write';
import { withCalendarDates } from '@/lib/trips/trip-dates';
import { REPLACE_INTERESTS, replaceTripDay } from '@/lib/trips/trip-replace-day';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type RouteContext = { params: Promise<{ id: string }> };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const BodySchema = z.object({
  day: z.number().int().min(1).max(60),
  interest: z.enum(REPLACE_INTERESTS),
});

export async function POST(request: NextRequest, ctx: RouteContext) {
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
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: 'Укажите день и занятие из списка' }, { status: 400 });
  }

  try {
    const { rows } = await pool.query<UserTripRow>(OWNED_TRIP_SQL, [id, authOrResponse.userId]);
    const row = rows[0];
    if (!row) return NextResponse.json({ success: false, error: 'Маршрут не найден' }, { status: 404 });
    const trip = withCalendarDates(row);
    const outcome = await replaceTripDay({
      arrival_date: trip.arrival_date,
      departure_date: trip.departure_date,
      activities: trip.activities,
      days: trip.days ?? [],
      party: trip.party,
    }, parsed.data.day, parsed.data.interest);
    return NextResponse.json({ success: true, data: outcome }, { status: outcome.state === 'failed' ? 503 : 200 });
  } catch (err) {
    const e = err as { code?: unknown; message?: unknown };
    console.error('[trips/replace-day] замена дня не выполнилась:',
      typeof e?.code === 'string' ? e.code : 'нет SQLSTATE',
      typeof e?.message === 'string' ? e.message.slice(0, 300) : '');
    return NextResponse.json({ success: false, error: 'Подобрать замену сейчас не получилось — попробуйте чуть позже' }, { status: 500 });
  }
}
