/**
 * GET  /api/cron/tour-describe — перепись: у каких туров описание короче
 *      порога чужих витрин и хватит ли их собственных данных на текст.
 * POST /api/cron/tour-describe — собрать и записать. Сухой прогон по
 *      умолчанию, партия ограничена, старое описание возвращается в ответе.
 *
 * Зачем. Из восьми живых туров у шести описание короче 300 знаков, и это
 * второй из двух блокеров выкладки на чужие витрины (первый — «как турист
 * попадает на тур», закрыт миграцией 932). Чинить это было некому: агент
 * Editor переписывает описания МЕСТ и МАРШРУТОВ, до operator_tours он не
 * дотягивается вовсе.
 *
 * Почему текст СОБИРАЕТСЯ, а не пишется моделью — см. шапку lib/tours/describe.
 * Коротко: тур чужой, мы его не водили, и просьба «напиши описание» к модели
 * есть заказ на выдумку под именем оператора.
 *
 * Границы записи, по образцу правки координат (place-coords):
 *   - пишем ТОЛЬКО туда, где описание короче порога: длинный текст оператора
 *     не трогаем никогда;
 *   - партия не больше 10 — правка публичного текста чужого продукта;
 *   - причина у партии обязательна и без умолчания;
 *   - старое описание возвращается в ответе и служит откатом.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';
import { composeTourDescription, MIN_DESCRIPTION_CHARS, type TourFacts } from '@/lib/tours/describe';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface TourRow extends TourFacts {
  id: string;
  operator_name: string | null;
  description: string | null;
}

const SELECT_TOURS = `
  SELECT
    ot.id::text AS id,
    COALESCE(ot.title, '') AS title,
    p.name AS operator_name,
    ot.description,
    ot.location_name,
    ot.activity_type,
    ot.duration_hours,
    ot.duration_type,
    ot.multi_day_count,
    ot.difficulty,
    ot.season_start::text AS season_start,
    ot.season_end::text   AS season_end,
    ot.max_participants,
    ot.min_participants,
    ot.weather_dependent,
    ot.program,
    ot.included,
    ot.what_to_bring,
    ot.pickup_type,
    ot.pickup_details
  FROM operator_tours ot
  LEFT JOIN partners p ON p.id = ot.operator_id
  WHERE ot.is_active = TRUE
    AND ot.deleted_at IS NULL
    AND COALESCE(LENGTH(ot.description), 0) < $1
  ORDER BY ot.id
`;

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const { rows } = await pool.query<TourRow>(SELECT_TOURS, [MIN_DESCRIPTION_CHARS]);
    const perTour = rows.map((r) => {
      const c = composeTourDescription(r);
      return {
        id: r.id,
        title: r.title,
        operator: r.operator_name,
        description_chars: r.description?.length ?? 0,
        composed_chars: c.chars,
        // Три исхода, не два: соберётся, не хватит данных, уже длинное.
        outcome: c.text ? 'composable' : 'not_enough_data',
        used: c.used,
        missing: c.missing,
      };
    });
    const composable = perTour.filter((t) => t.outcome === 'composable');
    return NextResponse.json({
      success: true,
      probe: 'tour_describe_v1',
      short_descriptions: perTour.length,
      composable: composable.length,
      // Чего не хватает — сгруппировано: оператору нужен список полей, а не
      // перечень отказов. Пустых данных больше, чем туров: одно поле может
      // недоставать у нескольких.
      missing_by_field: perTour
        .flatMap((t) => t.missing)
        .reduce<Record<string, number>>((acc, f) => { acc[f] = (acc[f] ?? 0) + 1; return acc; }, {}),
      tours: perTour,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка переписи';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}

const BodySchema = z.object({
  dry_run: z.boolean().default(true),
  limit: z.number().int().min(1).max(10).default(10),
  /** Зачем эта партия. Без умолчания намеренно: правка чужого текста. */
  reason: z.string().min(10),
  /** Ограничить конкретными турами; пусто — все короткие. */
  ids: z.array(z.string()).max(10).optional(),
});

export async function POST(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  let body: unknown;
  try { body = await request.json(); } catch { body = {}; }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: 'Некорректные параметры', detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) },
      { status: 400 },
    );
  }
  const { dry_run, limit, reason, ids } = parsed.data;

  try {
    const { rows } = await pool.query<TourRow>(SELECT_TOURS, [MIN_DESCRIPTION_CHARS]);
    const pool_ = ids?.length ? rows.filter((r) => ids.includes(r.id)) : rows;

    const plan: Array<{ id: string; title: string; chars: number; used: string[]; before: string | null; after: string }> = [];
    const skipped: Array<{ id: string; title: string; missing: string[] }> = [];

    for (const r of pool_) {
      if (plan.length >= limit) break;
      const c = composeTourDescription(r);
      if (!c.text) { skipped.push({ id: r.id, title: r.title, missing: c.missing }); continue; }
      plan.push({ id: r.id, title: r.title, chars: c.chars, used: c.used, before: r.description, after: c.text });
    }

    let written = 0;
    if (!dry_run) {
      for (const p of plan) {
        // Условие в UPDATE повторяет отбор: между переписью и записью оператор
        // мог дописать описание сам, и перетирать его нельзя.
        const res = await pool.query(
          `UPDATE operator_tours
              SET description = $1, updated_at = NOW()
            WHERE id = $2::bigint
              AND deleted_at IS NULL
              AND COALESCE(LENGTH(description), 0) < $3`,
          [p.after, p.id, MIN_DESCRIPTION_CHARS],
        );
        if (res.rowCount && res.rowCount > 0) written++;
      }
    }

    return NextResponse.json({
      success: true,
      dry_run,
      reason,
      planned: plan.length,
      written,
      skipped_not_enough_data: skipped.length,
      // Старый текст едет в ответе: это откат, а не украшение.
      plan,
      skipped,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка сборки';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
