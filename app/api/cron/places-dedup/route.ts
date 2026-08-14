/**
 * POST /api/cron/places-dedup — автоматическое схлопывание высоконадёжных
 * дублей places (напр. «Авачинская сопка» = «Авачинский вулкан»). Bearer
 * CRON_SECRET. Мягкое слияние (merged_into_id, обратимо), с переносом фото и
 * waypoints — как ручной /api/admin/places/merge, но массово и по проду.
 *
 * Body: { limit (1..50, default 20), dry_run (default true),
 *         min_sim (0..1, default 0.45), max_dist_m (default 500) }
 *   ЛИБО { pairs: [{ keep, merge }], dry_run } — поимённый режим.
 *
 * Высокая надёжность = ОБА условия: тот же location_type + реальные (не 0,0/не
 * плейсхолдер) близкие координаты (≤ max_dist_m) + похожесть имени ≥ min_sim.
 * Так «Бараний»(вулкан)/«Бараньи скалы»(скала) не сольются (разный тип), а
 * настоящий дубль одного объекта — сольётся. dry_run печатает план в лог.
 *
 * ── Зачем поимённый режим ──────────────────────────────────────────────────
 *
 * Пороги отбирают ПОЛОСУ, а решение принимается по ПАРАМ. В прогоне 71 из
 * десяти кандидатов бесспорны были пары с похожестью 1.00, 0.58 и 0.53, а
 * отклонены — 0.93 («Смотровая точка Б» и «точка В» — разные площадки, буквы
 * поставлены нарочно), 0.82, 0.70, 0.63, 0.50. Ни одна комбинация min_sim и
 * max_dist_m не выделяет выбранные пять: одобренное и отклонённое перемешаны
 * по шкале. Подгонять пороги «чтобы совпало» — значит закрепить в коде число,
 * которое к смыслу отношения не имеет и на следующих данных отберёт другое.
 * Поэтому выбранное человеком передаётся списком id, а не порогом.
 *
 * Поимённый режим НЕ ослабляет проверок — он их переносит на человека, который
 * пары уже просмотрел. Поэтому неизвестный или уже слитый id — это ошибка 400
 * со списком проблемных, а не тихий пропуск: молча слить четыре пары из пяти и
 * ответить success значило бы выдать неполный результат за полный.
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
  /** Поимённый режим: слить ровно эти пары. Пороги при этом не применяются. */
  pairs: z
    .array(z.object({ keep: z.string().uuid(), merge: z.string().uuid() }))
    .min(1)
    .max(50)
    .optional(),
});

interface PairRow {
  id1: string;
  name1: string;
  ark1: string | null;
  has_photo1: boolean;
  has_safety1: boolean;
  id2: string;
  name2: string;
  ark2: string | null;
  has_photo2: boolean;
  has_safety2: boolean;
  dist_m: number;
  name_sim: number;
}

interface PlanItem {
  keepId: string;
  keepName: string;
  keepArk: string | null;
  mergeId: string;
  mergeName: string;
  mergeArk: string | null;
  distM: number | null;
  sim: number | null;
}

const score = (photo: boolean, safety: boolean) =>
  (photo ? 2 : 0) + (safety ? 1 : 0);

/** Расстояние между двумя строками places, метры. Одно выражение на оба режима. */
const DIST_M_SQL = (
  a: string,
  b: string
) => `6371000 * acos(LEAST(1, GREATEST(-1,
  cos(radians(${a}.lat)) * cos(radians(${b}.lat)) * cos(radians(${b}.lng) - radians(${a}.lng)) +
  sin(radians(${a}.lat)) * sin(radians(${b}.lat))
)))`;

interface NamedRow {
  keep_id: string | null;
  keep_name: string | null;
  keep_ark: string | null;
  keep_merged: string | null;
  merge_id: string | null;
  merge_name: string | null;
  merge_ark: string | null;
  merge_merged: string | null;
  given_keep: string;
  given_merge: string;
  dist_m: number | null;
  name_sim: number | null;
}

/**
 * Что не так со списком пар ещё до похода в базу.
 *
 * Место не может быть одновременно тем, что оставляют, и тем, что сливают:
 * при `A→B` и `B→C` порядок применения решал бы судьбу B, а порядок здесь
 * случаен. Такой список — описка составителя, и его надо вернуть целиком.
 */
export function pairListProblems(
  pairs: Array<{ keep: string; merge: string }>
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const p of pairs) {
    if (p.keep === p.merge)
      problems.push(`${p.keep}: keep и merge — один и тот же id`);
    for (const id of [p.keep, p.merge]) {
      if (seen.has(id)) problems.push(`${id}: встречается в списке дважды`);
      seen.add(id);
    }
  }
  return problems;
}

/**
 * План из поимённого списка. Проблемные пары не пропускаются молча — они
 * возвращаются списком, и слияния не происходит вовсе.
 */
async function planFromPairs(
  pairs: Array<{ keep: string; merge: string }>
): Promise<{ plan: PlanItem[]; problems: string[] }> {
  const problems = pairListProblems(pairs);

  const { rows } = await pool.query<NamedRow>(
    `SELECT t.keep AS given_keep, t.merge AS given_merge,
            k.id AS keep_id, k.name AS keep_name, k.ark_id AS keep_ark, k.merged_into_id AS keep_merged,
            m.id AS merge_id, m.name AS merge_name, m.ark_id AS merge_ark, m.merged_into_id AS merge_merged,
            similarity(k.name, m.name) AS name_sim,
            ${DIST_M_SQL('k', 'm')} AS dist_m
       FROM unnest($1::uuid[], $2::uuid[]) AS t(keep, merge)
       LEFT JOIN places k ON k.id = t.keep
       LEFT JOIN places m ON m.id = t.merge`,
    [pairs.map(p => p.keep), pairs.map(p => p.merge)]
  );

  const plan: PlanItem[] = [];
  for (const r of rows) {
    if (!r.keep_id) {
      problems.push(`${r.given_keep}: места с таким id нет`);
      continue;
    }
    if (!r.merge_id) {
      problems.push(`${r.given_merge}: места с таким id нет`);
      continue;
    }
    if (r.keep_merged) {
      problems.push(`${r.keep_name}: уже слито в другое место`);
      continue;
    }
    if (r.merge_merged) {
      problems.push(`${r.merge_name}: уже слито в другое место`);
      continue;
    }
    plan.push({
      keepId: r.keep_id,
      keepName: r.keep_name ?? '',
      keepArk: r.keep_ark,
      mergeId: r.merge_id,
      mergeName: r.merge_name ?? '',
      mergeArk: r.merge_ark,
      distM: r.dist_m === null ? null : Math.round(r.dist_m),
      sim: r.name_sim === null ? null : Math.round(r.name_sim * 100) / 100,
    });
  }
  return { plan, problems };
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
    const msg =
      err instanceof z.ZodError ? err.issues[0]?.message : 'Некорректное тело';
    return NextResponse.json({ success: false, error: msg }, { status: 400 });
  }

  try {
    const plan = data.pairs
      ? await namedPlan(data.pairs)
      : await thresholdPlan(data);
    if ('problems' in plan) {
      return NextResponse.json(
        {
          success: false,
          error: 'Пары не прошли проверку — не слито ничего',
          problems: plan.problems,
        },
        { status: 400 }
      );
    }

    if (data.dry_run) {
      return NextResponse.json({
        success: true,
        dry_run: true,
        mode: data.pairs ? 'named' : 'thresholds',
        candidate_total: plan.length,
        plan,
      });
    }

    const merged = await applyPlan(plan);
    return NextResponse.json({
      success: true,
      dry_run: false,
      mode: data.pairs ? 'named' : 'thresholds',
      merged_count: merged.length,
      merged,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка дедупа мест';
    return NextResponse.json(
      { success: false, error: message },
      { status: 502 }
    );
  }
}

/** Поимённый план: либо все пары годны, либо не делаем ничего. */
async function namedPlan(
  pairs: Array<{ keep: string; merge: string }>
): Promise<PlanItem[] | { problems: string[] }> {
  const { plan, problems } = await planFromPairs(pairs);
  return problems.length > 0 ? { problems } : plan;
}

/** Прежний отбор по порогам: расстояние + похожесть имени + совпадение типа. */
async function thresholdPlan(
  data: z.infer<typeof BodySchema>
): Promise<PlanItem[]> {
  const { rows } = await pool.query<PairRow>(
    `WITH pairs AS (
         SELECT
           p1.id AS id1, p1.name AS name1, p1.ark_id AS ark1,
           p2.id AS id2, p2.name AS name2, p2.ark_id AS ark2,
           similarity(p1.name, p2.name) AS name_sim,
           ${DIST_M_SQL('p1', 'p2')} AS dist_m
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
    [data.max_dist_m, data.min_sim]
  );

  // Жадно выбираем непересекающиеся пары: место не может быть и keep, и merge
  // в одном прогоне. Keep — у кого больше данных (фото > safety > меньший id).
  const touched = new Set<string>();
  const plan: PlanItem[] = [];
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
    touched.add(r.id1);
    touched.add(r.id2);
    plan.push({
      keepId,
      keepName,
      keepArk,
      mergeId,
      mergeName,
      mergeArk,
      distM: Math.round(r.dist_m),
      sim: Math.round(r.name_sim * 100) / 100,
    });
    if (plan.length >= data.limit) break;
  }
  return plan;
}

/** Применение плана. Одно и то же для обоих режимов: мягко и обратимо. */
async function applyPlan(
  plan: PlanItem[]
): Promise<Array<{ keep: string; merge: string; warning?: string }>> {
  const merged: Array<{ keep: string; merge: string; warning?: string }> = [];
  for (const p of plan) {
    // eslint-disable-next-line no-await-in-loop
    await transaction(async client => {
      if (p.keepArk && p.mergeArk) {
        await client.query(
          `INSERT INTO ai_route_images (route_id, image_data, mime_type, prompt, model, width, height)
             SELECT $1, image_data, mime_type, prompt, model, width, height
             FROM ai_route_images WHERE route_id = $2
             ON CONFLICT (route_id) DO NOTHING`,
          [p.keepArk, p.mergeArk]
        );
      }
      await client.query(
        `UPDATE route_waypoints rw SET place_id = $1
           WHERE rw.place_id = $2
             AND NOT EXISTS (SELECT 1 FROM route_waypoints rw2 WHERE rw2.route_id = rw.route_id AND rw2.place_id = $1)`,
        [p.keepId, p.mergeId]
      );
      await client.query(`DELETE FROM route_waypoints WHERE place_id = $1`, [
        p.mergeId,
      ]);

      let warning: string | undefined;
      if (p.mergeArk) {
        const safety = await client.query<{ exists: boolean }>(
          `SELECT EXISTS(SELECT 1 FROM location_safety_profile WHERE agent_route_id = $1) AS exists`,
          [p.mergeArk]
        );
        if (safety.rows[0]?.exists)
          warning = `${p.mergeName}: свой safety-профиль не перенесён — проверить вручную`;
      }
      await client.query(
        `UPDATE places SET merged_into_id = $1, merged_at = NOW() WHERE id = $2 AND merged_into_id IS NULL`,
        [p.keepId, p.mergeId]
      );
      merged.push({ keep: p.keepName, merge: p.mergeName, warning });
    });
  }
  return merged;
}
