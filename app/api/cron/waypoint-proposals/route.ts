/**
 * GET /api/cron/waypoint-proposals?secret=<CRON_SECRET>[&limit=N]
 *
 * Кого из мест линия маршрута действительно проходит.
 *
 * Перепись геометрии 17.08 нашла 154 маршрута с линией и без единой путевой
 * точки — больше половины всех линий. У них есть то, чего нет у остальных:
 * сама линия. Значит точки можно не угадывать по названию, а измерить: место
 * в полусотне метров от линии эта линия проходит, место в трёх километрах —
 * нет, как бы ни совпадали названия.
 *
 * READ-ONLY, под CRON_SECRET. Ничего не пишет в route_waypoints: сначала
 * измерение. Записать по непроверенному правилу значит добавить к пустым
 * маршрутам неверно размеченные, а неверная точка хуже отсутствующей — по
 * ней пойдут.
 */

import { NextRequest, NextResponse } from 'next/server';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { proposeWaypoints } from '@/lib/routes/waypoint-proposals';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const raw = request.nextUrl.searchParams.get('limit');
  const parsed = raw === null ? NaN : parseInt(raw, 10);
  const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;

  try {
    const report = await proposeWaypoints(limit);
    return NextResponse.json({ success: true, ...report });
  } catch (err) {
    // Пустой отчёт читался бы как «привязывать нечего» — то есть как ответ.
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Разбор не выполнен' },
      { status: 500 },
    );
  }
}
