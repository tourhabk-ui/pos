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

export const dynamic     = 'force-dynamic';
export const maxDuration = 60;

/** Порог описания — тот же, по которому работает Editor. */
export const MIN_DESCRIPTION_CHARS = 300;

export interface ReadinessRow {
  id: number;
  title: string;
  description_chars: number;
  photo_count: number;
  base_price: number | null;
  duration_hours: number | null;
  has_meeting_point: boolean;
  has_coords: boolean;
  has_operator_contact: boolean;
  included_count: number;
  program_steps: number;
}

/** Чего не хватает конкретному туру. Пустой список — тур годен. */
export function missingFields(r: ReadinessRow): string[] {
  const missing: string[] = [];
  if (!r.title.trim()) missing.push('title');
  if (r.description_chars < MIN_DESCRIPTION_CHARS) missing.push('description');
  if (r.photo_count < 1) missing.push('photos');
  if (r.base_price === null || r.base_price <= 0) missing.push('base_price');
  if (r.duration_hours === null) missing.push('duration_hours');
  if (!r.has_meeting_point) missing.push('meeting_point');
  if (!r.has_coords) missing.push('coordinates');
  if (!r.has_operator_contact) missing.push('operator_contact');
  return missing;
}

/**
 * Поля, которых нет НИ У ОДНОГО тура, потому что под них нет колонок.
 * Это факт о схеме, а не о данных: их нельзя «заполнить», их надо заводить.
 */
export const SCHEMA_GAPS = [
  { field: 'language',            note: 'язык проведения тура — колонки нет; для иностранной витрины это обычно обязательное поле' },
  { field: 'cancellation_policy', note: 'политика отмены — колонки нет; сейчас правило отмены живёт только в коде крона (24 часа без оплаты)' },
  { field: 'instant_confirmation',note: 'подтверждается ли бронь мгновенно — колонки нет; у нас подтверждение делает оператор' },
] as const;

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
        COALESCE(LENGTH(ot.description), 0)                 AS description_chars,
        COALESCE(ARRAY_LENGTH(ot.photos, 1), 0)             AS photo_count,
        ot.base_price,
        ot.duration_hours,
        (ot.meeting_point IS NOT NULL AND LENGTH(TRIM(ot.meeting_point)) > 0) AS has_meeting_point,
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
