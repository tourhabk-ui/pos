/**
 * /api/cron/route-fields-backfill — дистанция, сложность и активность
 * маршрута из его же данных («го» владельца 21.08, проба 123: без сложности
 * 304 живых из 393, без дистанции 192, без типа активности 270).
 *
 * Три независимых шага, каждый пишет ТОЛЬКО в пустое:
 *   distance   — длина записанной линии тем же вычислителем, что дистанция
 *                профиля (accumulateRelief.distanceM). Набросок прямыми
 *                (waypoints_synthetic) не меряется: прямые занижают путь.
 *   difficulty — по шкале lib/routes/difficulty-scale из набора и дистанции;
 *                только когда известны ОБА числа; след difficulty_source =
 *                'computed_v1' (миграция 895) отличает счёт от слова оператора.
 *   activity   — детерминированный словарь по началу имени; целевое значение
 *                обязано УЖЕ существовать в activity_type БД — новых слов
 *                номенклатуре бэкфилл не выдумывает.
 *
 * GET — датчик и счётчики кандидатов. POST {step, dry_run, limit}. Партия
 * ≤200, dry_run по умолчанию. Bearer CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';
import { extractTrackpoints } from '@/lib/routes/track';
import { accumulateRelief } from '@/lib/routes/relief';
import { computeDifficulty } from '@/lib/routes/difficulty-scale';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Живой маршрут — как во всех переписях кампании. */
const LIVE = `is_visible = true AND merged_into_id IS NULL`;

const DISTANCE_WHERE =
  `${LIVE} AND distance_km IS NULL AND geometry IS NOT NULL` +
  ` AND COALESCE(geometry->>'source', '') <> 'waypoints_synthetic'`;

const DIFFICULTY_WHERE =
  `${LIVE} AND COALESCE(difficulty, '') = ''` +
  ` AND elevation_gain_m IS NOT NULL AND distance_km IS NOT NULL`;

const ACTIVITY_WHERE = `${LIVE} AND COALESCE(activity_type, '') = ''`;

/**
 * Словарь активности: только однозначные признаки имени. Целевое значение
 * проверяется по фактической номенклатуре БД перед записью.
 */
const ACTIVITY_RULES: ReadonlyArray<{ re: RegExp; value: string }> = [
  // Порядок — от сильного признака к слабому, как в travel-mode:
  // «Вертолётная заброска на сплав» — всё ещё вертолёт.
  { re: /вертол[её]т|обл[её]т/i, value: 'helicopter' },
  { re: /сплав|рафтинг/i, value: 'rafting' },
  { re: /^sup[\s-]/i, value: 'sup' },
  { re: /ски-?тур|лыжн/i, value: 'ski' },
  { re: /снегоход/i, value: 'snowmobile' },
  { re: /джип|внедорожн|квадроцикл/i, value: 'auto' },
  { re: /дайвинг|подводн/i, value: 'diving' },
  { re: /рыбалк|рыболов/i, value: 'fishing' },
  { re: /восхождение|поход|треккинг|трекинг|тропа/i, value: 'trekking' },
];

/**
 * Слова, при которых «поход» — не пеший: «Поход на каяках» треккингом не
 * становится. Такие имена честно остаются без типа (unmatched), а не
 * получают неверный.
 */
const NOT_ON_FOOT_RE = /каяк|байдар|катер|яхт|морск|круиз|теплоход|лодк/i;

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const counts = await pool.query<{ d: string; f: string; a: string }>(
      `SELECT
         COUNT(*) FILTER (WHERE ${DISTANCE_WHERE}) AS d,
         COUNT(*) FILTER (WHERE ${DIFFICULTY_WHERE}) AS f,
         COUNT(*) FILTER (WHERE ${ACTIVITY_WHERE}) AS a
       FROM kamchatka_routes`,
    );
    const values = await pool.query<{ activity_type: string; n: string }>(
      `SELECT activity_type, COUNT(*)::text AS n FROM kamchatka_routes
       WHERE ${LIVE} AND COALESCE(activity_type, '') <> ''
       GROUP BY activity_type ORDER BY COUNT(*) DESC`,
    );
    return NextResponse.json({
      success: true,
      probe: 'route_fields_backfill_v1',
      distance_candidates: parseInt(counts.rows[0]?.d ?? '0', 10),
      difficulty_candidates: parseInt(counts.rows[0]?.f ?? '0', 10),
      activity_candidates: parseInt(counts.rows[0]?.a ?? '0', 10),
      activity_values: values.rows,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка счётчиков';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}

const BodySchema = z.object({
  step: z.enum(['distance', 'difficulty', 'activity']),
  dry_run: z.boolean().default(true),
  limit: z.number().int().min(1).max(200).default(200),
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
    if (data.step === 'distance') {
      const { rows } = await pool.query<{ id: string; title: string; geometry: unknown }>(
        `SELECT id::text AS id, title, geometry FROM kamchatka_routes
         WHERE ${DISTANCE_WHERE} ORDER BY title LIMIT $1`,
        [data.limit],
      );
      const plan: Array<{ id: string; title: string; km: number }> = [];
      let unmeasurable = 0;
      for (const r of rows) {
        const pts = extractTrackpoints(
          r.geometry as { type?: string; coordinates?: number[][] } | null, {},
        );
        if (pts.length < 2) { unmeasurable++; continue; }
        const km = accumulateRelief(pts).distanceM / 1000;
        // Короче 100 м — это точка, а не путь: длину такой линии дистанцией
        // маршрута не объявляем.
        if (km < 0.1) { unmeasurable++; continue; }
        plan.push({ id: r.id, title: r.title, km: Math.round(km * 10) / 10 });
      }
      if (!data.dry_run && plan.length > 0) {
        await pool.query(
          `UPDATE kamchatka_routes r
           SET distance_km = p.km::numeric, updated_at = NOW()
           FROM (SELECT UNNEST($1::text[]) AS rid, UNNEST($2::float8[]) AS km) p
           WHERE r.id::text = p.rid AND r.distance_km IS NULL`,
          [plan.map(p => p.id), plan.map(p => p.km)],
        );
      }
      return NextResponse.json({
        success: true, step: 'distance', dry_run: data.dry_run,
        scanned: rows.length, planned: plan.length,
        written: data.dry_run ? 0 : plan.length, unmeasurable,
        sample: plan.slice(0, 10),
      });
    }

    if (data.step === 'difficulty') {
      const { rows } = await pool.query<{
        id: string; title: string; gain: number; km: string;
      }>(
        `SELECT id::text AS id, title, elevation_gain_m AS gain, distance_km::text AS km
         FROM kamchatka_routes WHERE ${DIFFICULTY_WHERE} ORDER BY title LIMIT $1`,
        [data.limit],
      );
      const plan = rows.map(r => ({
        id: r.id, title: r.title,
        level: computeDifficulty(Number(r.gain), Number(r.km)),
      }));
      if (!data.dry_run && plan.length > 0) {
        await pool.query(
          `UPDATE kamchatka_routes r
           SET difficulty = p.level, difficulty_source = 'computed_v1', updated_at = NOW()
           FROM (SELECT UNNEST($1::text[]) AS rid, UNNEST($2::text[]) AS level) p
           WHERE r.id::text = p.rid AND COALESCE(r.difficulty, '') = ''`,
          [plan.map(p => p.id), plan.map(p => p.level)],
        );
      }
      const byLevel: Record<string, number> = {};
      for (const p of plan) byLevel[p.level] = (byLevel[p.level] ?? 0) + 1;
      return NextResponse.json({
        success: true, step: 'difficulty', dry_run: data.dry_run,
        scanned: rows.length, planned: plan.length,
        written: data.dry_run ? 0 : plan.length, by_level: byLevel,
        sample: plan.slice(0, 10),
      });
    }

    // step === 'activity'
    const existing = await pool.query<{ activity_type: string }>(
      `SELECT DISTINCT activity_type FROM kamchatka_routes
       WHERE COALESCE(activity_type, '') <> ''`,
    );
    const known = new Set(existing.rows.map(r => r.activity_type));
    const { rows } = await pool.query<{ id: string; title: string }>(
      `SELECT id::text AS id, title FROM kamchatka_routes
       WHERE ${ACTIVITY_WHERE} ORDER BY title LIMIT $1`,
      [data.limit],
    );
    const plan: Array<{ id: string; title: string; value: string }> = [];
    let unmatched = 0;
    let unknownTarget = 0;
    for (const r of rows) {
      const rule = ACTIVITY_RULES.find(x => x.re.test(r.title));
      if (!rule) { unmatched++; continue; }
      if (rule.value === 'trekking' && NOT_ON_FOOT_RE.test(r.title)) { unmatched++; continue; }
      // Новых слов номенклатуре не выдумываем: значение обязано уже жить в БД.
      if (!known.has(rule.value)) { unknownTarget++; continue; }
      plan.push({ id: r.id, title: r.title, value: rule.value });
    }
    if (!data.dry_run && plan.length > 0) {
      await pool.query(
        `UPDATE kamchatka_routes r
         SET activity_type = p.value, updated_at = NOW()
         FROM (SELECT UNNEST($1::text[]) AS rid, UNNEST($2::text[]) AS value) p
         WHERE r.id::text = p.rid AND COALESCE(r.activity_type, '') = ''`,
        [plan.map(p => p.id), plan.map(p => p.value)],
      );
    }
    return NextResponse.json({
      success: true, step: 'activity', dry_run: data.dry_run,
      scanned: rows.length, planned: plan.length,
      written: data.dry_run ? 0 : plan.length, unmatched, unknown_target: unknownTarget,
      sample: plan.slice(0, 10),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка бэкфилла полей';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
