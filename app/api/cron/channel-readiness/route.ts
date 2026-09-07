/**
 * GET /api/cron/channel-readiness?secret=<CRON_SECRET>
 *
 * Перепись: сколько наших туров годится к выкладке на ЧУЖУЮ витрину
 * (Trip.com и любой следующий канал). Только чтение, ничего не меняет.
 *
 * ЗАЧЕМ. Разговор про выход на внешний канал упирается в цифру, которой ни у
 * кого нет: сколько туров вообще можно показать. Двадцать строк в таблице и
 * двадцать пригодных строк — разные вещи, и вторая цифра считается по нашей
 * же базе, без переговоров и без чьего-либо разрешения.
 *
 * ЧЕМ ОБОСНОВАН СПИСОК ТРЕБОВАНИЙ. Не догадками о правилах Trip.com — их
 * никто из нас не читал. Обязательными считаются поля, без которых
 * объявление не собирается в ПРИНЦИПЕ и которые уже требует наш собственный
 * контракт канала `ChannelTour` (lib/channels/types.ts), работающий с
 * Tripster и Avito. Порог описания в 300 символов — тоже наш: по нему
 * работает Editor (lib/agents/editor.ts).
 *
 * ЧЕГО ЭТА ПЕРЕПИСЬ НЕ ЗНАЕТ. Требований конкретно Trip.com. Поэтому третий
 * блок ответа называется honestly `unknown_requirements`: там поля, которых у
 * нас НЕТ НИ У ОДНОГО тура, потому что под них нет колонок вовсе (язык
 * проведения, политика отмены, мгновенное подтверждение). Что из этого
 * площадка потребует — выяснится в переговорах; выдавать ожидание за факт
 * здесь нельзя, потому что по этой цифре будут принимать решение.
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { MIN_DESCRIPTION_CHARS, missingFields, SCHEMA_GAPS, type ReadinessRow } from '@/lib/tours/readiness';

export const dynamic     = 'force-dynamic';
export const maxDuration = 60;

/** Порог описания — тот же, по которому работает Editor. */
export {
  MIN_DESCRIPTION_CHARS,
  missingFields,
  SCHEMA_GAPS,
  type ReadinessRow,
} from '@/lib/tours/readiness';

export async function GET(req: NextRequest) {
  const secret = getCronSecret(req);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const startedAt = Date.now();

  try {
    const { rows } = await pool.query<ReadinessRow>(`
      SELECT
        ot.id,
        COALESCE(ot.title, '')                              AS title,
        ot.operator_id,
        p.name                                              AS operator_name,
        COALESCE(LENGTH(ot.description), 0)                 AS description_chars,
        COALESCE(ARRAY_LENGTH(ot.photos, 1), 0)             AS photo_count,
        ot.base_price,
        ot.duration_hours,
        ot.pickup_type,
        COALESCE(LENGTH(TRIM(ot.pickup_details)), 0)        AS pickup_details_chars,
        (ot.meeting_point IS NOT NULL AND LENGTH(TRIM(ot.meeting_point)) > 0) AS has_meeting_point,
        (ot.cancellation_policy IS NOT NULL AND LENGTH(TRIM(ot.cancellation_policy)) > 0) AS has_cancellation_policy,
        (ot.latitude IS NOT NULL AND ot.longitude IS NOT NULL)               AS has_coords,
        (p.contact IS NOT NULL AND p.contact::text <> '{}')                  AS has_operator_contact,
        COALESCE(ARRAY_LENGTH(ot.included, 1), 0)           AS included_count,
        COALESCE(JSONB_ARRAY_LENGTH(
          CASE WHEN JSONB_TYPEOF(ot.program) = 'array' THEN ot.program ELSE '[]'::jsonb END
        ), 0)                                               AS program_steps
      FROM operator_tours ot
      LEFT JOIN partners p ON p.id = ot.operator_id
      WHERE ot.is_active = TRUE
        AND ot.deleted_at IS NULL
      ORDER BY ot.id
    `);

    const perTour = rows.map((r) => ({
      id: r.id,
      title: r.title,
      // Оператор нужен потому, что часть пробелов чинится ОДНОЙ фразой на
      // оператора, а не правкой каждого тура: как турист попадает на тур —
      // свойство перевозки оператора, а не отдельной поездки.
      operator: r.operator_name,
      missing: missingFields(r),
      photo_count: r.photo_count,
      description_chars: r.description_chars,
      program_steps: r.program_steps,
    }));

    const ready = perTour.filter((t) => t.missing.length === 0);

    // Сколько туров спотыкается о каждое поле — это и есть список работ:
    // видно, что чинится одной правкой на все, а что поштучно.
    const byField: Record<string, number> = {};
    for (const t of perTour) {
      for (const f of t.missing) byField[f] = (byField[f] ?? 0) + 1;
    }

    return NextResponse.json({
      ok: true,
      probe: 'channel_readiness_v1',
      tours_active: rows.length,
      ready: ready.length,
      not_ready: perTour.length - ready.length,
      // Ноль активных туров — это отказ переписи, а не «всё готово».
      meaningful: rows.length > 0,
      blocking_by_field: byField,
      min_description_chars: MIN_DESCRIPTION_CHARS,
      unknown_requirements: SCHEMA_GAPS,
      tours: perTour,
      duration_ms: Date.now() - startedAt,
    });

  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Ошибка';
    console.error('[channel-readiness] перепись не удалась:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
