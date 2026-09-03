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
  operator_id: string | null;
  operator_name: string | null;
  description_chars: number;
  photo_count: number;
  base_price: number | null;
  duration_hours: number | null;
  has_meeting_point: boolean;
  /** Условия отмены записаны оператором (колонка с миграции 931). */
  has_cancellation_policy: boolean;
  has_coords: boolean;
  has_operator_contact: boolean;
  included_count: number;
  program_steps: number;
}

/**
 * Чего не хватает конкретному туру. Пустой список — тур годен.
 *
 * ПРО `pickup` — поправка владельца 23.08. Первая версия называла это
 * «meeting_point» и считала пустое поле забывчивостью оператора. Это неверно:
 * операторы ЗАБИРАЮТ туристов сами, фиксированной точки сбора у таких туров
 * нет и быть не должно. Поэтому пустое поле здесь означает не «оператор не
 * заполнил», а «у нас не записано, КАК турист попадает на тур».
 *
 * Блокировать это всё равно приходится: чужая витрина обязана сказать
 * покупателю, ждать ли его у отеля или ехать самому, и «не знаю» тут не
 * публикуется. Но чинится оно не восемью письмами про точки сбора, а одной
 * фразой на оператора — где и в каких границах он забирает.
 */
export function missingFields(r: ReadinessRow): string[] {
  const missing: string[] = [];
  if (!r.title.trim()) missing.push('title');
  if (r.description_chars < MIN_DESCRIPTION_CHARS) missing.push('description');
  if (r.photo_count < 1) missing.push('photos');
  if (r.base_price === null || r.base_price <= 0) missing.push('base_price');
  if (r.duration_hours === null) missing.push('duration_hours');
  if (!r.has_meeting_point) missing.push('pickup');
  // Условия отмены: покупатель на чужой витрине обязан знать, что будет с
  // деньгами при отмене, и «не знаю» тут не публикуется. До 931 это был
  // пробел схемы; теперь — пробел данных, чинится оператором в кабинете.
  if (!r.has_cancellation_policy) missing.push('cancellation_policy');
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
  // 'cancellation_policy' снят 03.09: колонка заведена миграцией 931, поле
  // переехало из пробелов схемы в пробелы данных (missingFields выше).
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
        ot.operator_id,
        p.name                                              AS operator_name,
        COALESCE(LENGTH(ot.description), 0)                 AS description_chars,
        COALESCE(ARRAY_LENGTH(ot.photos, 1), 0)             AS photo_count,
        ot.base_price,
        ot.duration_hours,
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
