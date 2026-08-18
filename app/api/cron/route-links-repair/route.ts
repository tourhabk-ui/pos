/**
 * GET /api/cron/route-links-repair?dry_run=true[&limit=N]
 *
 * Снятие привязок маршрут→точка, опровергнутых собственным треком маршрута.
 *
 * Решение владельца 18.08: «убираем эти битые данные». Битой считается СВЯЗЬ,
 * а не линия и не место — см. lib/routes/broken-links. Линии трогать нельзя:
 * 277 из 301 доказаны как записи прибора.
 *
 * ПО УМОЛЧАНИЮ СУХОЙ ПРОГОН. Удаление данных, от которых зависит безопасность,
 * не должно случаться от опечатки в параметре: писать разрешает только явное
 * `dry_run=false`.
 *
 * Что делает боевой прогон:
 *   1. удаляет строки `route_waypoints` (место и маршрут остаются целыми);
 *   2. поднимает `route_version` — полевые пакеты на телефонах узнают, что
 *      маршрут изменился, и перекачают его.
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { geometryToTrack } from '@/lib/routes/geometry-audit';
import { trackEvidence } from '@/lib/routes/track-evidence';
import { brokenLinks, safeToRepair, type LinkCandidate } from '@/lib/routes/broken-links';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

interface RouteRow { id: string; title: string | null; geometry: unknown }
interface WpRow { route_id: string; place_id: string; title: string | null; lat: string | null; lng: string | null }

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Умолчание — НЕ писать. Пропущенный параметр означает сухой прогон, а не
  // боевой: цена ошибки здесь несимметрична.
  const dryRun = request.nextUrl.searchParams.get('dry_run') !== 'false';
  const rawLimit = parseInt(request.nextUrl.searchParams.get('limit') ?? '', 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : undefined;

  try {
    const routes = await pool.query<RouteRow>(
      `SELECT id::text, title, geometry FROM kamchatka_routes
        WHERE geometry IS NOT NULL ${limit ? 'LIMIT ' + limit : ''}`,
    );
    const wps = await pool.query<WpRow>(
      `SELECT rw.route_id::text, p.id::text AS place_id, p.name AS title,
              p.lat::text, p.lng::text
         FROM route_waypoints rw
         JOIN places p ON p.id = rw.place_id
        WHERE p.lat IS NOT NULL AND p.lng IS NOT NULL
          AND p.is_visible = TRUE AND p.merged_into_id IS NULL
        ORDER BY rw.route_id, rw.position`,
    );

    const byRoute = new Map<string, WpRow[]>();
    for (const w of wps.rows) {
      const arr = byRoute.get(w.route_id) ?? [];
      arr.push(w);
      byRoute.set(w.route_id, arr);
    }

    const candidates: LinkCandidate[] = [];
    /** Маршруты, где опровергнуто слишком много: случай для человека. */
    const needsHuman: Array<{ id: string; title: string; broken: number; total: number }> = [];
    let provenRoutes = 0;

    for (const r of routes.rows) {
      const track = geometryToTrack(r.geometry);
      const lineProven = trackEvidence(r.geometry).verdict === 'recorded';
      if (lineProven) provenRoutes += 1;
      const mine = byRoute.get(r.id) ?? [];
      const found = brokenLinks({
        routeId: r.id,
        routeTitle: r.title ?? '(без названия)',
        track,
        lineProven,
        waypoints: mine.map((w) => ({
          placeId: w.place_id,
          placeTitle: w.title ?? '(без названия)',
          lat: Number(w.lat),
          lng: Number(w.lng),
        })),
      });
      if (found.length === 0) continue;
      if (!safeToRepair(found.length, mine.length)) {
        needsHuman.push({ id: r.id, title: r.title ?? '(без названия)', broken: found.length, total: mine.length });
        continue;
      }
      candidates.push(...found);
    }

    let removed = 0;
    if (!dryRun && candidates.length > 0) {
      // Удаляем ТОЛЬКО связь. Место и маршрут остаются: место — географический
      // факт, линия — доказанная запись.
      for (const c of candidates) {
        const res = await pool.query(
          `DELETE FROM route_waypoints WHERE route_id = $1 AND place_id = $2`,
          [c.routeId, c.placeId],
        );
        removed += res.rowCount ?? 0;
      }
      // Версия маршрута растёт: сохранённые на телефонах полевые пакеты должны
      // узнать, что состав точек изменился, и перекачаться.
      const ids = [...new Set(candidates.map((c) => c.routeId))];
      await pool.query(
        `UPDATE kamchatka_routes SET route_version = COALESCE(route_version, 1) + 1 WHERE id = ANY($1::uuid[])`,
        [ids],
      );
    }

    return NextResponse.json({
      success: true,
      dry_run: dryRun,
      routes_scanned: routes.rows.length,
      routes_with_proven_line: provenRoutes,
      candidates: candidates.length,
      routes_affected: new Set(candidates.map((c) => c.routeId)).size,
      removed,
      // Случаи для человека печатаются отдельно: молчаливый пропуск выглядел
      // бы как «таких нет».
      needs_human: needsHuman.slice(0, 30),
      needs_human_total: needsHuman.length,
      samples: candidates.slice(0, 40),
    });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Уборка не выполнена' },
      { status: 500 },
    );
  }
}
