/**
 * GET /api/cron/route-title-census — какие имена маршрутов не по стандарту.
 *
 * Стандарт и судья — lib/routes/title-standard.ts (решение владельца 20.08:
 * один формат, без поэзии). Перепись только судит: для каждого живого
 * маршрута с нарушениями — имя, признаки и привязанные места (материал для
 * ручного переименования: канон почти всегда собирается из объекта, через
 * который маршрут проходит). Ничего не переименовывает — новое имя сочиняет
 * смысл, это решение человека, партиями.
 *
 * READ-ONLY, Bearer CRON_SECRET. Параметры offset/limit — окно выдачи.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';
import { judgeRouteTitle } from '@/lib/routes/title-standard';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const sp = request.nextUrl.searchParams;
  const rawOffset = parseInt(sp.get('offset') ?? '0', 10);
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0;
  const rawLimit = parseInt(sp.get('limit') ?? '40', 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 40;

  try {
    const { rows } = await pool.query<{
      id: string; title: string; waypoint_names: string[] | null;
    }>(
      `SELECT r.id::text AS id, r.title,
              ARRAY(
                SELECT p.name FROM route_waypoints rw
                JOIN places p ON p.id = rw.place_id
                WHERE rw.route_id = r.id
                  AND p.is_visible = true AND p.merged_into_id IS NULL
                ORDER BY rw.position
              ) AS waypoint_names
       FROM kamchatka_routes r
       WHERE r.is_visible = true AND r.merged_into_id IS NULL
       ORDER BY r.title`,
    );

    const offenders = rows
      .map(r => ({ ...r, verdict: judgeRouteTitle(r.title) }))
      .filter(r => !r.verdict.ok)
      .map(r => ({
        id: r.id,
        title: r.title,
        violations: r.verdict.violations,
        places: r.waypoint_names ?? [],
      }));

    const byViolation: Record<string, number> = {};
    for (const o of offenders) {
      for (const v of o.violations) {
        const key = v.split(':')[0];
        byViolation[key] = (byViolation[key] ?? 0) + 1;
      }
    }

    return NextResponse.json({
      success: true,
      // v2 — маркер деплоя миграции 885 (слияние вариаций): код переписи не
      // менялся, пробе нужен признак сборки, при старте которой она прошла.
      probe: 'title_census_v2',
      live_total: rows.length,
      offenders_total: offenders.length,
      by_violation: byViolation,
      window: { offset, limit },
      items: offenders.slice(offset, offset + limit),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка переписи имён';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
