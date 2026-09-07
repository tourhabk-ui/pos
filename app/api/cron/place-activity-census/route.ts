/**
 * GET /api/cron/place-activity-census — какие места на самом деле активности.
 *
 * Найдено 07.09: «Река Авача — рыбалка» лежала в `places` и попадала на
 * `/map` как обычное место, хотя это коммерческая активность (§9 CLAUDE.md:
 * «Точка = место. Тур = коммерция. Не смешивать»). Судья —
 * lib/places/activity-name-judge.ts. Перепись только НАЗЫВАЕТ подозрение по
 * слову в имени — ничего не скрывает и не удаляет: активность в имени и
 * настоящая ошибка выглядят по одному признаку, разбор — глазами человека
 * (тот же принцип, что у place-link-suggest, §4.1).
 *
 * READ-ONLY, Bearer CRON_SECRET. Параметры offset/limit — окно выдачи.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';
import { judgePlaceActivityName } from '@/lib/places/activity-name-judge';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

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
      id: string; name: string; location_type: string | null;
      lat: number | null; lng: number | null;
      description_head: string | null;
      route_titles: string[] | null;
    }>(
      `SELECT p.id::text AS id, p.name, p.location_type,
              p.lat::float8 AS lat, p.lng::float8 AS lng,
              LEFT(p.description, 240) AS description_head,
              -- Маршруты, к которым это «место» привязано waypoint'ом —
              -- если это реальный тур, привязка почти всегда через route_id
              -- operator_tours, не через route_waypoints; пустой список сам
              -- по себе подозрение не усиливает и не снимает.
              ARRAY(
                SELECT r.title FROM route_waypoints rw
                JOIN kamchatka_routes r ON r.id = rw.route_id
                WHERE rw.place_id = p.id AND r.is_visible = true AND r.merged_into_id IS NULL
                ORDER BY r.title
              ) AS route_titles
         FROM places p
        WHERE p.is_visible = true AND p.merged_into_id IS NULL
        ORDER BY p.name`,
    );

    const offenders = rows
      .map(r => ({ ...r, verdict: judgePlaceActivityName(r.name) }))
      .filter(r => !r.verdict.ok)
      .map(r => ({
        id: r.id,
        name: r.name,
        location_type: r.location_type,
        lat: r.lat,
        lng: r.lng,
        matched: r.verdict.matched,
        description_head: r.description_head,
        route_titles: r.route_titles ?? [],
      }));

    return NextResponse.json({
      success: true,
      probe: 'place_activity_census_v1',
      live_total: rows.length,
      offenders_total: offenders.length,
      window: { offset, limit },
      items: offenders.slice(offset, offset + limit),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка переписи имён мест';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
