/**
 * POST /api/cron/places-dedup — автоматическое схлопывание высоконадёжных
 * дублей places (напр. «Авачинская сопка» = «Авачинский вулкан»). Bearer
 * CRON_SECRET. Мягкое слияние (merged_into_id, обратимо), с переносом фото и
 * waypoints — как ручной /api/admin/places/merge, но массово и по проду.
 *
 * Body: { limit (1..50, default 20), dry_run (default true),
 *         min_sim (0..1, default 0.45), max_dist_m (default 500) }.
 *
 * Высокая надёжность = ОБА условия: тот же location_type + реальные (не 0,0/не
 * плейсхолдер) близкие координаты (≤ max_dist_m) + похожесть имени ≥ min_sim.
 * Так «Бараний»(вулкан)/«Бараньи скалы»(скала) не сольются (разный тип), а
 * настоящий дубль одного объекта — сольётся. dry_run печатает план в лог.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';
import { transaction } from '@/lib/database';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const BodySchema = z.object({
  limit: z.number().int().min(1).max(50).default(20),
  dry_run: z.boolean().default(true),
  min_sim: z.number().min(0).max(1).default(0.45),
  max_dist_m: z.number().int().min(10).max(2000).default(500),
});

interface PairRow {
  id1: string; name1: string; ark1: string | null; has_photo1: boolean; has_safety1: boolean;
  id2: string; name2: string; ark2: string | null; has_photo2: boolean; has_safety2: boolean;
  dist_m: number; name_sim: number;
}

const score = (photo: boolean, safety: boolean) => (photo ? 2 : 0) + (safety ? 1 : 0);

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
    const { rows } = await pool.query<PairRow>(
      `WITH pairs AS (
         SELECT
           p1.id AS id1, p1.name AS name1, p1.ark_id AS ark1,
           p2.id AS id2, p2.name AS name2, p2.ark_id AS ark2,
           similarity(p1.name, p2.name) AS name_sim,
           6371000 * acos(LEAST(1, GREATEST(-1,
             cos(radians(p1.lat)) * cos(radians(p2.lat)) * cos(radians(p2.lng) - radians(p1.lng)) +
             sin(radians(p1.lat)) * sin(radians(p2.lat))
           ))) AS dist_m
         FROM places p1
         JOIN places p2
           ON p2.id > p1.id
          AND p1.location_type IS NOT DISTINCT FROM p2.location_type
          AND p2.lat BETWEEN p1.lat - 0.02 AND p1.lat + 0.02
          AND p2.lng BETWEEN p1.lng - 0.03 AND p1.lng + 0.03
         WHERE p1.merged_into_id IS NULL AND p2.merged_into_id IS NULL
           AND p1.lat IS NOT NULL AND p1.lng IS NOT NULL
           AND p2.lat IS NOT NULL AND p2.lng IS NOT NULL
           AND NOT (p1.lat = 0 AND p1.lng = 0) AND NOT (p2.lat = 0 AND p2.lng = 0)
           AND NOT (ROUND(p1.lat::numeric,4) = 53.0444 AND ROUND(p1.lng::numeric,4) = 158.6483)
           AND NOT (ROUND(p2.lat::numeric,4) = 53.0444 AND ROUND(p2.lng::numeric,4) = 158.6483)
       )
       SELECT
         pairs.*,
         (ari1.route_id IS NOT NULL) AS has_photo1,
         (ari2.route_id IS NOT NULL) AS has_photo2,
         (lsp1.agent_route_id IS NOT NULL) AS has_safety1,
         (lsp2.agent_route_id IS NOT NULL) AS has_safety2
       FROM pairs
       LEFT JOIN ai_route_images ari1 ON ari1.route_id = pairs.ark1
       LEFT JOIN ai_route_images ari2 ON ari2.route_id = pairs.ark2
       LEFT JOIN location_safety_profile lsp1 ON lsp1.agent_route_id = pairs.ark1
       LEFT JOIN location_safety_profile lsp2 ON lsp2.agent_route_id = pairs.ark2
       WHERE pairs.dist_m <= $1 AND pairs.name_sim >= $2
       ORDER BY pairs.name_sim DESC, pairs.dist_m ASC
       LIMIT 500`,
      [data.max_dist_m, data.min_sim],
    );

    // Жадно выбираем непересекающиеся пары: место не может быть и keep, и merge
    // в одном прогоне. Keep — у кого больше данных (фото > safety > меньший id).
    const touched = new Set<string>();
    const plan: Array<{ keepId: string; keepName: string; keepArk: string | null; mergeId: string; mergeName: string; mergeArk: string | null; distM: number; sim: number }> = [];
    for (const r of rows) {
      if (touched.has(r.id1) || touched.has(r.id2)) continue;
      const s1 = score(r.has_photo1, r.has_safety1);
      const s2 = score(r.has_photo2, r.has_safety2);
      const keepFirst = s1 !== s2 ? s1 > s2 : r.id1 < r.id2;
      const keepId = keepFirst ? r.id1 : r.id2;
      const keepName = keepFirst ? r.name1 : r.name2;
      const keepArk = keepFirst ? r.ark1 : r.ark2;
      const mergeId = keepFirst ? r.id2 : r.id1;
      const mergeName = keepFirst ? r.name2 : r.name1;
      const mergeArk = keepFirst ? r.ark2 : r.ark1;
      touched.add(r.id1); touched.add(r.id2);
      plan.push({ keepId, keepName, keepArk, mergeId, mergeName, mergeArk, distM: Math.round(r.dist_m), sim: Math.round(r.name_sim * 100) / 100 });
      if (plan.length >= data.limit) break;
    }

    if (data.dry_run) {
      return NextResponse.json({ success: true, dry_run: true, candidate_total: plan.length, plan });
    }

    const merged: Array<{ keep: string; merge: string; warning?: string }> = [];
    for (const p of plan) {
      // eslint-disable-next-line no-await-in-loop
      await transaction(async (client) => {
        if (p.keepArk && p.mergeArk) {
          await client.query(
            `INSERT INTO ai_route_images (route_id, image_data, mime_type, prompt, model, width, height)
             SELECT $1, image_data, mime_type, prompt, model, width, height
             FROM ai_route_images WHERE route_id = $2
             ON CONFLICT (route_id) DO NOTHING`,
            [p.keepArk, p.mergeArk],
          );
        }
        await client.query(
          `UPDATE route_waypoints rw SET place_id = $1
           WHERE rw.place_id = $2
             AND NOT EXISTS (SELECT 1 FROM route_waypoints rw2 WHERE rw2.route_id = rw.route_id AND rw2.place_id = $1)`,
          [p.keepId, p.mergeId],
        );
        await client.query(`DELETE FROM route_waypoints WHERE place_id = $1`, [p.mergeId]);

        let warning: string | undefined;
        if (p.mergeArk) {
          const safety = await client.query<{ exists: boolean }>(
            `SELECT EXISTS(SELECT 1 FROM location_safety_profile WHERE agent_route_id = $1) AS exists`,
            [p.mergeArk],
          );
          if (safety.rows[0]?.exists) warning = `${p.mergeName}: свой safety-профиль не перенесён — проверить вручную`;
        }
        await client.query(
          `UPDATE places SET merged_into_id = $1, merged_at = NOW() WHERE id = $2 AND merged_into_id IS NULL`,
          [p.keepId, p.mergeId],
        );
        merged.push({ keep: p.keepName, merge: p.mergeName, warning });
      });
    }

    return NextResponse.json({ success: true, dry_run: false, merged_count: merged.length, merged });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка дедупа мест';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
