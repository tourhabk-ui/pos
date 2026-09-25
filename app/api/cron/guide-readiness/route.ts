/**
 * GET /api/cron/guide-readiness?secret=<CRON_SECRET>
 *
 * Перепись: скольким гидам есть чем наполнить AI-визитку (#1926). Только
 * чтение — ни UPDATE, ни INSERT здесь нет ни при каком аргументе.
 *
 * Правило готовности и объяснение, почему блокирует именно это, живут в
 * `lib/guides/card-readiness.ts`. Здесь — запрос и счёт.
 *
 * ЧЕГО ЭТА ПЕРЕПИСЬ НЕ ЗНАЕТ и не берётся узнать: захочет ли гид такую
 * страницу и будет ли ей пользоваться турист. Она отвечает ровно на один
 * вопрос — есть ли в базе то, чем ассистенту отвечать.
 */
import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { publicGuideWhere } from '@/lib/guides/visibility';
import { blockingGaps, contentSignals, type GuideReadinessRow } from '@/lib/guides/card-readiness';

export const dynamic     = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const secret = getCronSecret(req);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const startedAt = Date.now();

  try {
    // Отбор тот же, которым живёт сама страница гида, — publicGuideWhere
    // (lib/guides/visibility.ts). Своя копия условия показывала бы готовность
    // тех, кого на сайте нет (§12); прежняя копия `profile_status = 'active'`
    // при CHECK без такого значения отбирала ноль по построению.
    const { rows } = await pool.query<GuideReadinessRow>(`
      SELECT
        g.id::text                                              AS id,
        COALESCE(g.name, '')                                    AS name,
        g.guide_operator_id::text                               AS operator_id,
        op.name                                                 AS operator_name,
        COALESCE((
          SELECT COUNT(*)::int FROM operator_tours t
           WHERE t.operator_id = g.guide_operator_id
             AND t.is_active = TRUE AND t.deleted_at IS NULL
        ), 0)                                                   AS operator_active_tours,
        COALESCE(LENGTH(TRIM(g.description)), 0)                AS description_chars,
        COALESCE((
          SELECT COUNT(*)::int FROM guide_certifications c
           WHERE c.guide_id = g.id AND c.is_verified = TRUE
        ), 0)                                                   AS verified_certs,
        COALESCE((
          SELECT COUNT(*)::int FROM guide_reviews r
           WHERE r.guide_id = g.id AND r.is_public = TRUE
        ), 0)                                                   AS public_reviews,
        (g.photo_url IS NOT NULL AND LENGTH(TRIM(g.photo_url)) > 0) AS has_photo,
        COALESCE(ARRAY_LENGTH(g.languages, 1), 0)               AS languages_count,
        COALESCE(ARRAY_LENGTH(g.specializations, 1), 0)         AS specializations_count
      FROM partners g
      LEFT JOIN partners op ON op.id = g.guide_operator_id
      WHERE ${publicGuideWhere('g')}
      ORDER BY g.id
    `);

    const perGuide = rows.map((r) => ({
      id: r.id,
      name: r.name,
      operator: r.operator_name,
      operator_active_tours: r.operator_active_tours,
      description_chars: r.description_chars,
      blocking: blockingGaps(r),
      has: contentSignals(r),
    }));

    const ready = perGuide.filter((g) => g.blocking.length === 0);

    // Что чем чинится: привязка к оператору — одной правкой на гида, туры
    // оператора — одной правкой на ОПЕРАТОРА сразу на всех его гидов.
    const byGap: Record<string, number> = {};
    for (const g of perGuide) {
      for (const gap of g.blocking) byGap[gap] = (byGap[gap] ?? 0) + 1;
    }

    // Длины описаний — вместо выдуманного порога. По ним владелец увидит,
    // нужен ли порог вообще и какой.
    const lengths = perGuide.map((g) => g.description_chars).sort((a, b) => a - b);
    const median = lengths.length ? lengths[Math.floor(lengths.length / 2)] : null;

    return NextResponse.json({
      ok: true,
      probe: 'guide_readiness_v1',
      guides_active: rows.length,
      ready: ready.length,
      not_ready: perGuide.length - ready.length,
      // Ноль живых гидов — отказ переписи, а не «все готовы» (§4.0).
      meaningful: rows.length > 0,
      blocking_by_gap: byGap,
      linked_to_operator: perGuide.filter((g) => g.operator !== null).length,
      description_chars: {
        median,
        min: lengths[0] ?? null,
        max: lengths[lengths.length - 1] ?? null,
        empty: lengths.filter((n) => n === 0).length,
        note: 'Порога длины у профиля гида в платформе нет. Выдумывать его перепись не стала — см. lib/guides/card-readiness.ts.',
      },
      guides: perGuide,
      duration_ms: Date.now() - startedAt,
    });

  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Ошибка';
    const code = typeof (err as { code?: unknown })?.code === 'string' ? (err as { code: string }).code : '—';
    console.error('[guide-readiness] перепись не удалась:', code, msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
