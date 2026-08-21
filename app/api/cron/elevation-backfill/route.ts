/**
 * /api/cron/elevation-backfill — набор высоты маршрута из его же трека.
 *
 * «Го» владельца 21.08 (продолжение «добавляй высоту и сложность в
 * сравнение»): ключ высоты в comparePaths спал — elevation_gain_m пуст
 * почти у всех (проба 117: null у всей выдачи, включая паспортные).
 * При этом ~277 живых линий несут высоту в самой геометрии (перепись
 * track-evidence): набор ВЫЧИСЛЯЕТСЯ из первичных данных маршрута, это
 * не выдумка, а та же арифметика, которой карточка считает профиль.
 *
 * Правила:
 *   - считает accumulateRelief по ПОЛНОМУ треку — тот же вычислитель, что
 *     кормит профиль карточки: два вычислителя одного числа разошлись бы;
 *   - пишет ТОЛЬКО при reliable=true (высоты настоящие: покрытие ≥60%,
 *     порог шума) — «не смог посчитать» не превращается в число;
 *   - только в NULL: паспортное значение (visitkamchatka и любое ручное)
 *     не перетирается никогда;
 *   - только живым записям (is_visible AND merged_into_id IS NULL);
 *   - округление до метра; POST, dry_run по умолчанию, партия ≤200.
 *
 * GET — датчик деплоя и счётчик кандидатов. Bearer CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';
import { extractTrackpoints } from '@/lib/routes/track';
import { accumulateRelief } from '@/lib/routes/relief';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const { rows } = await pool.query<{ candidates: string; filled: string }>(
      `SELECT
         COUNT(*) FILTER (WHERE elevation_gain_m IS NULL AND geometry IS NOT NULL) AS candidates,
         COUNT(*) FILTER (WHERE elevation_gain_m IS NOT NULL) AS filled
       FROM kamchatka_routes
       WHERE is_visible = true AND merged_into_id IS NULL`,
    );
    return NextResponse.json({
      success: true,
      probe: 'elevation_backfill_v1',
      candidates: parseInt(rows[0]?.candidates ?? '0', 10),
      filled: parseInt(rows[0]?.filled ?? '0', 10),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка счётчика';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}

const BodySchema = z.object({
  dry_run: z.boolean().default(true),
  limit: z.number().int().min(1).max(200).default(150),
});

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
    const { rows } = await pool.query<{
      id: string; title: string; geometry: unknown; payload: unknown;
    }>(
      `SELECT r.id::text AS id, r.title, r.geometry, NULL AS payload
       FROM kamchatka_routes r
       WHERE r.is_visible = true AND r.merged_into_id IS NULL
         AND r.elevation_gain_m IS NULL AND r.geometry IS NOT NULL
       ORDER BY r.title
       LIMIT $1`,
      [data.limit],
    );

    const plan: Array<{ id: string; title: string; ascentM: number }> = [];
    let unreliable = 0;
    for (const r of rows) {
      const pts = extractTrackpoints(
        r.geometry as { type?: string; coordinates?: number[][] } | null,
        (r.payload as Record<string, unknown>) ?? {},
      );
      if (pts.length < 2) { unreliable++; continue; }
      const relief = accumulateRelief(pts);
      // reliable=false — высот в данных нет или их мало: «не смог посчитать»
      // остаётся отсутствием, а не нулём и не догадкой.
      if (!relief.reliable) { unreliable++; continue; }
      plan.push({ id: r.id, title: r.title, ascentM: Math.round(relief.ascentM) });
    }

    if (!data.dry_run && plan.length > 0) {
      await pool.query(
        `UPDATE kamchatka_routes r
         SET elevation_gain_m = p.ascent::int, updated_at = NOW()
         FROM (SELECT UNNEST($1::text[]) AS rid, UNNEST($2::int[]) AS ascent) p
         WHERE r.id::text = p.rid
           AND r.elevation_gain_m IS NULL`,
        [plan.map(p => p.id), plan.map(p => p.ascentM)],
      );
    }

    return NextResponse.json({
      success: true,
      dry_run: data.dry_run,
      scanned: rows.length,
      written: data.dry_run ? 0 : plan.length,
      planned: plan.length,
      unreliable,
      sample: plan.slice(0, 12),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка бэкфилла';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
