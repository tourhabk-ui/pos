/**
 * GET /api/cron/places-routes-census — какие живые места остались без маршрутов.
 *
 * Вопрос владельца 15.08 после уборки маршрутов (партии 1-4): точка на
 * витрине без единого маршрута — тупик для туриста, с карточки некуда
 * уйти («Маршруты» пустые), и Кузьмичу нечего предложить.
 *
 * Перепись делит живые места (is_visible, не слитые) на три судьбы:
 *   linked — есть хотя бы один ЖИВОЙ маршрут (видимый и не слитый);
 *   lost   — связи есть, но все ведут в скрытые/слитые маршруты:
 *            эти места ПОТЕРЯЛИ маршруты, в т.ч. после нашей уборки;
 *   never  — ни одной записи в route_waypoints вовсе.
 *
 * READ-ONLY, Bearer CRON_SECRET. Списки имён отдаются целиком (lost) и
 * по типам (never); срезание — только явное, с счётчиком dropped
 * (правило «никаких молчаливых потолков»).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const NAMES_PER_TYPE_CAP = 400;

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { rows } = await pool.query<{
      name: string; location_type: string | null; status: 'linked' | 'lost' | 'never';
    }>(
      `SELECT p.name, p.location_type,
              CASE
                WHEN EXISTS (
                  SELECT 1 FROM route_waypoints rw
                  JOIN kamchatka_routes r ON r.id = rw.route_id
                  WHERE rw.place_id = p.id
                    AND r.is_visible = true AND r.merged_into_id IS NULL
                ) THEN 'linked'
                WHEN EXISTS (
                  SELECT 1 FROM route_waypoints rw WHERE rw.place_id = p.id
                ) THEN 'lost'
                ELSE 'never'
              END AS status
       FROM places p
       WHERE p.is_visible = true AND p.merged_into_id IS NULL
       ORDER BY p.location_type NULLS LAST, p.name`,
    );

    const counts = { linked: 0, lost: 0, never: 0 };
    const byType = new Map<string, { total: number; linked: number; lost: number; never: number }>();
    const lostPlaces: Array<{ name: string; type: string }> = [];
    const neverByType = new Map<string, string[]>();

    for (const r of rows) {
      const type = r.location_type ?? 'без типа';
      counts[r.status] += 1;
      const t = byType.get(type) ?? { total: 0, linked: 0, lost: 0, never: 0 };
      t.total += 1;
      t[r.status] += 1;
      byType.set(type, t);
      if (r.status === 'lost') lostPlaces.push({ name: r.name, type });
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

    return NextResponse.json({
      success: true,
      total_live_places: rows.length,
      linked: counts.linked,
      lost: counts.lost,
      never: counts.never,
      by_type: [...byType.entries()]
        .map(([type, t]) => ({ type, ...t }))
        .sort((a, b) => (b.lost + b.never) - (a.lost + a.never)),
      lost_places: lostPlaces,
      never_names: neverNames,
      never_names_dropped: dropped,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка переписи мест';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
