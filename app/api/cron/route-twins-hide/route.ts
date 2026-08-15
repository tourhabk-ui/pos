/**
 * POST /api/cron/route-twins-hide — убрать с витрины «маршруты»,
 * маскирующиеся под маршруты (решение владельца 15.08: «без точек, что
 * маскируется под маршруты, — мусор, засоряет базу»).
 *
 * Критерий и его обоснование — lib/routes/twins.ts. Коротко: убираются
 * только записи, у которых СРАЗУ имя живого места-тёзки, ноль путевых
 * точек и отсутствие дистанции.
 *
 * Убирание — скрытие (is_visible = false), не DELETE: на kamchatka_routes
 * смотрят FK (route_waypoints, operator_tours.route_id), и физическое
 * удаление способно уронить тур. Скрытие убирает запись из каталога,
 * карты и поиска — витрина читает только is_visible = true — и обратимо
 * тем же эндпоинтом с action=restore.
 *
 * Bearer CRON_SECRET. Body: { action: hide|restore, dry_run (default true),
 * limit (1..300), ids? } — ids сужают набор до перечисленных.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';
import { isTwinJunk, blockers, hasRealTrack, type TwinFacts } from '@/lib/routes/twins';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const BodySchema = z.object({
  action: z.enum(['hide', 'restore']).default('hide'),
  dry_run: z.boolean().default(true),
  limit: z.number().int().min(1).max(300).default(300),
  ids: z.array(z.string().min(8).max(64)).max(300).optional(),
});

interface TwinRow {
  id: string; title: string; place_id: string;
  waypoint_count: number; has_distance: boolean;
  has_geometry: boolean; geometry_source: string | null;
  tour_count: number;
}

export async function POST(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let data: z.infer<typeof BodySchema>;
  try {
    data = BodySchema.parse(await request.json().catch(() => ({})));
  } catch (err) {
    const msg = err instanceof z.ZodError ? err.issues[0]?.message : 'Некорректное тело';
    return NextResponse.json({ success: false, error: msg }, { status: 400 });
  }

  try {
    if (data.action === 'restore') {
      if (!data.ids || data.ids.length === 0) {
        return NextResponse.json(
          { success: false, error: 'Для отката нужен явный список ids' },
          { status: 400 },
        );
      }
      if (data.dry_run) {
        return NextResponse.json({ success: true, dry_run: true, would_restore: data.ids.length });
      }
      const { rows } = await pool.query<{ title: string }>(
        `UPDATE kamchatka_routes SET is_visible = true, updated_at = NOW()
         WHERE id::text = ANY($1) AND is_visible = false
         RETURNING title`,
        [data.ids],
      );
      return NextResponse.json({
        success: true, action: 'restore',
        restored_count: rows.length, restored: rows.map(r => r.title),
      });
    }

    // Кандидаты: видимые, не слитые, с местом-тёзкой (сравнение имён —
    // регистр и ё не считаются различием, всё остальное считается).
    const { rows } = await pool.query<TwinRow>(
      `SELECT r.id::text AS id, r.title, p.id::text AS place_id,
              (SELECT COUNT(*)::int FROM route_waypoints rw WHERE rw.route_id = r.id) AS waypoint_count,
              (r.distance_km IS NOT NULL) AS has_distance,
              (r.geometry IS NOT NULL) AS has_geometry,
              r.geometry->>'source' AS geometry_source,
              (SELECT COUNT(*)::int FROM operator_tours ot WHERE ot.route_id::text = r.id::text) AS tour_count
       FROM kamchatka_routes r
       JOIN places p
         ON p.is_visible = true AND p.merged_into_id IS NULL
        AND lower(translate(btrim(p.name), 'ё', 'е')) = lower(translate(btrim(r.title), 'ё', 'е'))
       WHERE r.is_visible = true AND r.merged_into_id IS NULL
       ORDER BY r.title`,
    );

    const chosen = data.ids ? rows.filter(r => data.ids!.includes(r.id)) : rows;

    const toHide: Array<{ id: string; title: string }> = [];
    const held: Array<{ id: string; title: string; reasons: string[] }> = [];
    const notJunk: Array<{ id: string; title: string; waypoints: number; hasDistance: boolean }> = [];

    for (const r of chosen) {
      const facts: TwinFacts = {
        title: r.title, hasPlaceTwin: true,
        waypointCount: r.waypoint_count, hasDistance: r.has_distance,
        tourCount: r.tour_count, geometrySource: r.geometry_source,
        hasGeometry: r.has_geometry,
      };
      if (!isTwinJunk(facts)) {
        notJunk.push({ id: r.id, title: r.title, waypoints: r.waypoint_count, hasDistance: r.has_distance });
        continue;
      }
      const stop = blockers(facts);
      if (stop.length > 0) { held.push({ id: r.id, title: r.title, reasons: stop }); continue; }
      toHide.push({ id: r.id, title: r.title });
    }

    const batch = toHide.slice(0, data.limit);
    const dropped = toHide.length - batch.length;

    if (data.dry_run) {
      return NextResponse.json({
        success: true, dry_run: true,
        twins_total: chosen.length,
        would_hide: batch.length,
        over_limit_left: dropped,
        held_back: held,
        real_routes_kept: notJunk,
        plan: batch,
      });
    }

    const { rows: hidden } = await pool.query<{ title: string }>(
      `UPDATE kamchatka_routes SET is_visible = false, updated_at = NOW()
       WHERE id::text = ANY($1) AND is_visible = true
       RETURNING title`,
      [batch.map(b => b.id)],
    );

    return NextResponse.json({
      success: true, action: 'hide', dry_run: false,
      hidden_count: hidden.length,
      over_limit_left: dropped,
      held_back_count: held.length,
      hidden: hidden.map(r => r.title),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка уборки двойников';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
