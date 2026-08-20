/**
 * POST /api/cron/place-link — привязать место к маршруту (route_waypoints).
 *
 * ТОЛЬКО поимённые пары. Авто-режима по радиусу нет и не будет: миграция
 * 167 уже связала всё со всем в 15 км, и её наследство — «паутины», где
 * маршрут собрал десяток чужих вершин просто потому, что они рядом.
 *
 * Правила:
 *   - обе стороны обязаны быть живыми (видимыми и не слитыми): привязка к
 *     скрытому маршруту не вернёт место на витрину, а только создаст вид
 *     работы;
 *   - позиция ставится В КОНЕЦ (max+1), is_start/is_end не трогаются:
 *     порядок существующих точек — чужое знание, его не пересобираем;
 *   - существующая пара не дублируется (UNIQUE route_id+place_id), в
 *     отчёте она помечается как already_linked;
 *   - dry_run по умолчанию: сначала план с фактами, потом запись;
 *   - боевая партия не больше 10 пар (правило владельца 15.08: «лучше по
 *     10, чтоб меньше ошибок допустить») — сухой прогон размера не
 *     ограничивает;
 *   - род связи (миграция 874): kind='waypoint' пишется только при улике
 *     имени (nameScore > 0) — точка пути назначается потому, что маршрут
 *     её НАЗЫВАЕТ, а не потому, что она рядом. Без kind — 'unknown', как
 *     и было. Выводить род из расстояния запрещено (§4.1 CLAUDE.md).
 *
 * Bearer CRON_SECRET. Body: { pairs: [{place, route, kind?}] (1..50), dry_run }.
 * Откат — POST /api/cron/place-unlink.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';
import { linkPairProblems, nameMatchScore, distanceKm } from '@/lib/routes/place-link';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const BodySchema = z.object({
  dry_run: z.boolean().default(true),
  pairs: z.array(z.object({
    place: z.string().min(8).max(64),
    route: z.string().min(8).max(64),
    kind: z.enum(['waypoint', 'nearby']).optional(),
  })).min(1).max(50),
});

/** Боевой потолок партии — правило владельца «лучше по 10». */
const LIVE_BATCH_MAX = 10;

interface PairRow {
  given_place: string; given_route: string;
  place_id: string | null; place_name: string | null;
  place_lat: number | null; place_lng: number | null;
  route_id: string | null; route_title: string | null;
  route_lat: number | null; route_lng: number | null;
  already_linked: boolean;
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
      error: `боевая партия не больше ${LIVE_BATCH_MAX} пар (получено ${data.pairs.length}) — сухой прогон без ограничения`,
    }, { status: 400 });
  }

  const problems = linkPairProblems(data.pairs);
  const kindByPair = new Map(data.pairs.map(p => [`${p.place}→${p.route}`, p.kind]));

  try {
    const { rows } = await pool.query<PairRow>(
      `SELECT t.place AS given_place, t.route AS given_route,
              p.id::text AS place_id, p.name AS place_name, p.lat AS place_lat, p.lng AS place_lng,
              r.id::text AS route_id, r.title AS route_title, r.lat AS route_lat, r.lng AS route_lng,
              EXISTS (
                SELECT 1 FROM route_waypoints rw
                WHERE rw.place_id = p.id AND rw.route_id = r.id
              ) AS already_linked
       FROM unnest($1::text[], $2::text[]) AS t(place, route)
       LEFT JOIN places p
         ON p.id::text = t.place AND p.is_visible = true AND p.merged_into_id IS NULL
       LEFT JOIN kamchatka_routes r
         ON r.id::text = t.route AND r.is_visible = true AND r.merged_into_id IS NULL`,
      [data.pairs.map(p => p.place), data.pairs.map(p => p.route)],
    );

    interface PlanItem {
      placeId: string; placeName: string; routeId: string; routeTitle: string;
      nameScore: number; distanceKm: number | null; alreadyLinked: boolean;
      kind: 'waypoint' | 'nearby' | undefined;
    }
    const plan: PlanItem[] = [];

    for (const r of rows) {
      if (!r.place_id) { problems.push(`${r.given_place}: живого места с таким id нет`); continue; }
      if (!r.route_id) { problems.push(`${r.given_route}: живого маршрута с таким id нет`); continue; }
      const kind = kindByPair.get(`${r.given_place}→${r.given_route}`);

      const pLat = r.place_lat == null ? null : Number(r.place_lat);
      const pLng = r.place_lng == null ? null : Number(r.place_lng);
      const rLat = r.route_lat == null ? null : Number(r.route_lat);
      const rLng = r.route_lng == null ? null : Number(r.route_lng);
      const d = (pLat != null && pLng != null && rLat != null && rLng != null)
        ? Math.round(distanceKm(pLat, pLng, rLat, rLng) * 10) / 10
        : null;

      const nameScore = nameMatchScore(r.place_name ?? '', r.route_title ?? '');
      // Род «точка пути» требует улики происхождения — маршрут называет
      // место. Близость уликой не является: род, выведенный из расстояния,
      // и есть выключение сигнализации, о котором предупреждает §4.1.
      if (kind === 'waypoint' && nameScore === 0) {
        problems.push(`${r.given_place}→${r.given_route}: kind=waypoint без совпадения имён — улики нет, размечать нечем`);
        continue;
      }

      plan.push({
        placeId: r.place_id, placeName: r.place_name ?? '',
        routeId: r.route_id, routeTitle: r.route_title ?? '',
        nameScore,
        distanceKm: d,
        alreadyLinked: r.already_linked,
        kind,
      });
    }

    if (problems.length > 0) {
      return NextResponse.json(
        { success: false, error: 'Пары не прошли проверку — не привязано ничего', problems },
        { status: 400 },
      );
    }

    if (data.dry_run) {
      return NextResponse.json({ success: true, dry_run: true, candidate_total: plan.length, plan });
    }

    const linked: PlanItem[] = [];
    for (const p of plan) {
      if (p.alreadyLinked) continue;
      // eslint-disable-next-line no-await-in-loop
      const res = await pool.query(
        `INSERT INTO route_waypoints (route_id, place_id, position, link_kind, link_kind_at)
         SELECT r.id, pl.id,
                COALESCE((SELECT MAX(rw.position) FROM route_waypoints rw WHERE rw.route_id = r.id), 0) + 1,
                COALESCE($3, 'unknown'),
                CASE WHEN $3 IS NULL THEN NULL ELSE NOW() END
         FROM kamchatka_routes r, places pl
         WHERE r.id::text = $1 AND pl.id::text = $2
         ON CONFLICT (route_id, place_id) DO NOTHING`,
        [p.routeId, p.placeId, p.kind ?? null],
      );
      if ((res.rowCount ?? 0) > 0) linked.push(p);
    }

    return NextResponse.json({
      success: true, dry_run: false,
      linked_count: linked.length,
      skipped_already_linked: plan.filter(p => p.alreadyLinked).length,
      linked: linked.map(p => ({ place: p.placeName, route: p.routeTitle, nameScore: p.nameScore, distanceKm: p.distanceKm, kind: p.kind ?? 'unknown' })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка привязки';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
