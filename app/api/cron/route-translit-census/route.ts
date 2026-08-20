/**
 * GET /api/cron/route-translit-census — латинские транслит-дубли на витрине.
 *
 * Правила сличения и их происхождение — lib/routes/translit-twins.ts.
 * Для каждого ЖИВОГО маршрута с целиком латинским заголовком ищется живой
 * кириллический родственник: точная семья (exact) или надмножество слов.
 * Выход — поимённые пары с id и наличием линии у обеих сторон: по ним
 * человек решает, кого куда сливать. Латинские без родни — отдельным
 * списком: их судьбу тоже решать человеку (перевести или скрыть).
 *
 * READ-ONLY, Bearer CRON_SECRET: ничего не пишет и не сливает.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';
import { isLatinOnlyTitle, twinMatch, type TwinMatchKind } from '@/lib/routes/translit-twins';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { rows } = await pool.query<{
      id: string; title: string; has_line: boolean; wp_count: number;
    }>(
      `SELECT r.id::text AS id, r.title,
              (r.geometry IS NOT NULL) AS has_line,
              (SELECT COUNT(*)::int FROM route_waypoints rw WHERE rw.route_id = r.id) AS wp_count
       FROM kamchatka_routes r
       WHERE r.is_visible = true AND r.merged_into_id IS NULL`,
    );

    const latins = rows.filter(r => isLatinOnlyTitle(r.title));
    const cyrs = rows.filter(r => !isLatinOnlyTitle(r.title));

    interface Pair {
      latin_id: string; latin_title: string; latin_has_line: boolean; latin_wp: number;
      match: TwinMatchKind;
      twin_id: string; twin_title: string; twin_has_line: boolean; twin_wp: number;
    }
    const pairs: Pair[] = [];
    const unmatched: Array<{ id: string; title: string; has_line: boolean; wp: number }> = [];

    for (const lat of latins) {
      // Точная семья важнее надмножества: если есть exact — берём только их.
      const found: Pair[] = [];
      for (const cyr of cyrs) {
        const m = twinMatch(lat.title, cyr.title);
        if (m === null) continue;
        found.push({
          latin_id: lat.id, latin_title: lat.title,
          latin_has_line: lat.has_line, latin_wp: lat.wp_count,
          match: m,
          twin_id: cyr.id, twin_title: cyr.title,
          twin_has_line: cyr.has_line, twin_wp: cyr.wp_count,
        });
      }
      const exact = found.filter(p => p.match === 'exact');
      if (exact.length > 0) pairs.push(...exact);
      else if (found.length > 0) pairs.push(...found);
      else unmatched.push({ id: lat.id, title: lat.title, has_line: lat.has_line, wp: lat.wp_count });
    }

    return NextResponse.json({
      success: true,
      probe: 'translit_census_v1',
      live_total: rows.length,
      latin_titled: latins.length,
      matched_exact: pairs.filter(p => p.match === 'exact').length,
      matched_superset: pairs.filter(p => p.match !== 'exact').length,
      unmatched: unmatched.length,
      pairs,
      unmatched_items: unmatched,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка транслит-переписи';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
