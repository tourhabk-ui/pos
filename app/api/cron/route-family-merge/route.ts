/**
 * POST /api/cron/route-family-merge — слить скрытый дубль в живую запись.
 *
 * Правила и их обоснование — lib/routes/family-merge.ts. Пары поимённые,
 * авто-режима нет: перепись предлагает, человек (или проверенный список)
 * решает. Для каждой пары:
 *   1) скрытая должна быть скрытой и не слитой, живая — живой и не слитой;
 *   2) имена — одна семья (равенство множества слов), иначе отказ ПАРЫ;
 *   3) трек скрытой переезжает живой, если у живой пусто или перезаписываемый
 *      источник; снятый трек живой не перетирается — тогда трек скрытой
 *      остаётся при ней (слитая запись хранит своё);
 *   4) путевые точки скрытой доезжают до живой (ON CONFLICT пропускается);
 *   5) скрытая получает merged_into_id — исчезает из переписей навсегда.
 *
 * Боевая партия не больше 10 пар (правило владельца). dry_run по умолчанию.
 * Bearer CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';
import { sameNameFamily, canTransferTrack } from '@/lib/routes/family-merge';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const BodySchema = z.object({
  dry_run: z.boolean().default(true),
  pairs: z.array(z.object({
    hidden: z.string().min(8).max(64),
    live: z.string().min(8).max(64),
  })).min(1).max(50),
});

const LIVE_BATCH_MAX = 10;

/** Датчик выката для пробы: POST на несуществующем роуте сгорел бы без ретраев. */
export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return NextResponse.json({ success: true, probe: 'family_merge_v1', live_batch_max: LIVE_BATCH_MAX });
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

  if (!data.dry_run && data.pairs.length > LIVE_BATCH_MAX) {
    return NextResponse.json({
      success: false,
      error: `боевая партия не больше ${LIVE_BATCH_MAX} пар (получено ${data.pairs.length})`,
    }, { status: 400 });
  }

  try {
    const { rows } = await pool.query<{
      given_hidden: string; given_live: string;
      h_id: string | null; h_title: string | null; h_has_geom: boolean | null;
      l_id: string | null; l_title: string | null;
      l_has_geom: boolean | null; l_geom_source: string | null;
    }>(
      `SELECT t.hidden AS given_hidden, t.live AS given_live,
              h.id::text AS h_id, h.title AS h_title, (h.geometry IS NOT NULL) AS h_has_geom,
              l.id::text AS l_id, l.title AS l_title,
              (l.geometry IS NOT NULL) AS l_has_geom, l.geometry->>'source' AS l_geom_source
       FROM unnest($1::text[], $2::text[]) AS t(hidden, live)
       LEFT JOIN kamchatka_routes h
         ON h.id::text = t.hidden AND h.is_visible = false AND h.merged_into_id IS NULL
       LEFT JOIN kamchatka_routes l
         ON l.id::text = t.live AND l.is_visible = true AND l.merged_into_id IS NULL`,
      [data.pairs.map(p => p.hidden), data.pairs.map(p => p.live)],
    );

    interface PlanItem {
      hiddenId: string; hiddenTitle: string; liveId: string; liveTitle: string;
      trackMove: 'move' | 'keep_live_track' | 'hidden_has_no_track';
    }
    const problems: string[] = [];
    const plan: PlanItem[] = [];

    for (const r of rows) {
      if (!r.h_id) { problems.push(`${r.given_hidden}: скрытой не слитой записи с таким id нет`); continue; }
      if (!r.l_id) { problems.push(`${r.given_live}: живой не слитой записи с таким id нет`); continue; }
      if (!sameNameFamily(r.h_title ?? '', r.l_title ?? '')) {
        problems.push(`«${r.h_title}» → «${r.l_title}»: имена не одна семья — сливать нечем оправдать`);
        continue;
      }
      plan.push({
        hiddenId: r.h_id, hiddenTitle: r.h_title ?? '',
        liveId: r.l_id, liveTitle: r.l_title ?? '',
        trackMove: !r.h_has_geom
          ? 'hidden_has_no_track'
          : canTransferTrack(r.l_geom_source, r.l_has_geom ?? false) ? 'move' : 'keep_live_track',
      });
    }

    if (problems.length > 0) {
      return NextResponse.json(
        { success: false, error: 'Пары не прошли проверку — не слито ничего', problems },
        { status: 400 },
      );
    }

    if (data.dry_run) {
      return NextResponse.json({ success: true, dry_run: true, plan_total: plan.length, plan });
    }

    const results: Array<Record<string, unknown>> = [];
    for (const p of plan) {
      // eslint-disable-next-line no-await-in-loop
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        let trackMoved = false;
        if (p.trackMove === 'move') {
          const res = await client.query(
            `UPDATE kamchatka_routes l
             SET geometry = h.geometry, updated_at = NOW()
             FROM kamchatka_routes h
             WHERE l.id::text = $1 AND h.id::text = $2
               AND h.geometry IS NOT NULL
               AND (l.geometry IS NULL OR l.geometry->>'source' IN ('waypoints_synthetic', 'kml_inbox'))`,
            [p.liveId, p.hiddenId],
          );
          trackMoved = (res.rowCount ?? 0) > 0;
        }
        const wp = await client.query(
          `INSERT INTO route_waypoints (route_id, place_id, position, link_kind, link_kind_at)
           SELECT l.id, rw.place_id,
                  COALESCE((SELECT MAX(x.position) FROM route_waypoints x WHERE x.route_id = l.id), 0)
                    + ROW_NUMBER() OVER (ORDER BY rw.position),
                  rw.link_kind, rw.link_kind_at
           FROM route_waypoints rw
           JOIN kamchatka_routes h ON h.id = rw.route_id AND h.id::text = $2
           JOIN kamchatka_routes l ON l.id::text = $1
           WHERE NOT EXISTS (
             SELECT 1 FROM route_waypoints x WHERE x.route_id = l.id AND x.place_id = rw.place_id
           )
           ON CONFLICT (route_id, place_id) DO NOTHING`,
          [p.liveId, p.hiddenId],
        );
        await client.query(
          `UPDATE kamchatka_routes SET merged_into_id = $1, updated_at = NOW()
           WHERE id::text = $2 AND merged_into_id IS NULL`,
          [p.liveId, p.hiddenId],
        );
        await client.query('COMMIT');
        results.push({
          hidden: p.hiddenTitle, live: p.liveTitle,
          track: p.trackMove === 'move' ? (trackMoved ? 'перенесён' : 'не перенесён (гонка/уже занят)') : p.trackMove,
          waypoints_moved: wp.rowCount ?? 0,
        });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }

    return NextResponse.json({ success: true, dry_run: false, merged_count: results.length, results });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка слияния семей';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
