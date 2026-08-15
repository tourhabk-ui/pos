/**
 * GET /api/cron/places-no-track-census — у каких мест нет линии на карте.
 *
 * Вопрос владельца 15.08 после дооформления: «какие места без треков и
 * сколько их». Связь с маршрутом ещё не значит линию: маршрут может быть
 * привязан, но сам стоять без geometry — тогда на карточке места турист
 * видит точку и ссылку, но не видит, КАК идти.
 *
 * Четыре судьбы живого места (is_visible, не слитое):
 *   tracked         — есть живой маршрут С ТРЕКОМ: линия на карте есть;
 *   linked_no_track — маршруты есть, но ни у одного нет geometry;
 *   lost            — связи ведут только в скрытое или слитое;
 *   never           — в route_waypoints не было никогда.
 *
 * Без линии = всё, кроме tracked. READ-ONLY, Bearer CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type Status = 'tracked' | 'linked_no_track' | 'lost' | 'never';

const NAMES_PER_TYPE_CAP = 60;

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { rows } = await pool.query<{
      name: string; location_type: string | null; status: Status;
    }>(
      `SELECT p.name, p.location_type,
              CASE
                WHEN EXISTS (
                  SELECT 1 FROM route_waypoints rw
                  JOIN kamchatka_routes r ON r.id = rw.route_id
                  WHERE rw.place_id = p.id
                    AND r.is_visible = true AND r.merged_into_id IS NULL
                    AND r.geometry IS NOT NULL
                ) THEN 'tracked'
                WHEN EXISTS (
                  SELECT 1 FROM route_waypoints rw
                  JOIN kamchatka_routes r ON r.id = rw.route_id
                  WHERE rw.place_id = p.id
                    AND r.is_visible = true AND r.merged_into_id IS NULL
                ) THEN 'linked_no_track'
                WHEN EXISTS (
                  SELECT 1 FROM route_waypoints rw WHERE rw.place_id = p.id
                ) THEN 'lost'
                ELSE 'never'
              END AS status
       FROM places p
       WHERE p.is_visible = true AND p.merged_into_id IS NULL
       ORDER BY p.location_type NULLS LAST, p.name`,
    );

    const counts: Record<Status, number> = { tracked: 0, linked_no_track: 0, lost: 0, never: 0 };
    const byType = new Map<string, Record<Status, number> & { total: number }>();
    const linkedNoTrack: Array<{ name: string; type: string }> = [];
    const lostNames: Array<{ name: string; type: string }> = [];
    const neverByType = new Map<string, string[]>();

    for (const r of rows) {
      const type = r.location_type ?? 'без типа';
      counts[r.status] += 1;
      const t = byType.get(type)
        ?? { total: 0, tracked: 0, linked_no_track: 0, lost: 0, never: 0 };
      t.total += 1;
      t[r.status] += 1;
      byType.set(type, t);

      if (r.status === 'linked_no_track') linkedNoTrack.push({ name: r.name, type });
      if (r.status === 'lost') lostNames.push({ name: r.name, type });
      if (r.status === 'never') {
        const list = neverByType.get(type) ?? [];
        list.push(r.name);
        neverByType.set(type, list);
      }
    }

    let dropped = 0;
    const neverNames: Record<string, string[]> = {};
    for (const [type, names] of neverByType) {
      if (names.length > NAMES_PER_TYPE_CAP) dropped += names.length - NAMES_PER_TYPE_CAP;
      neverNames[type] = names.slice(0, NAMES_PER_TYPE_CAP);
    }

    const withoutLine = counts.linked_no_track + counts.lost + counts.never;

    return NextResponse.json({
      success: true,
      total_live_places: rows.length,
      with_line_on_map: counts.tracked,
      without_line_on_map: withoutLine,
      breakdown: counts,
      by_type: [...byType.entries()]
        .map(([type, t]) => ({ type, ...t }))
        .sort((a, b) => (b.total - b.tracked) - (a.total - a.tracked)),
      linked_no_track: linkedNoTrack,
      lost: lostNames,
      never_names: neverNames,
      never_names_dropped: dropped,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка переписи';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
