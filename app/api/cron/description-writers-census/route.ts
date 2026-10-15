/**
 * GET /api/cron/description-writers-census — кто написал описания, которые
 * видит турист на карточках мест. Bearer CRON_SECRET, только чтение.
 *
 * ЗАЧЕМ (15.10, §0 «честность»). Карточка подписывает описание «написала
 * модель», когда последняя запись журнала происхождения (911) — писатель-
 * модель и длина текста с тех пор та же (lib/places/description-by-model).
 * Сколько таких карточек, сколько текстов правлено после модели и у скольких
 * журнала нет вовсе, не знал никто. Перепись считает тем же правилом — его
 * копии на SQL здесь нет: строки читаются и судятся функцией карточки.
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { descriptionWrittenByModel, isModelDescriptionWriter, type LastDescriptionWrite } from '@/lib/places/description-by-model';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface Row { last_write: LastDescriptionWrite | null; chars: number | null }

export async function GET(req: NextRequest) {
  if (!timingSafeCompare(getCronSecret(req), process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const { rows } = await pool.query<Row>(
      `SELECT (SELECT json_build_object('by', dp.written_by, 'chars', dp.chars)
                 FROM description_provenance dp
                WHERE dp.entity_id = p.ark_id
                ORDER BY dp.written_at DESC, dp.id DESC
                LIMIT 1) AS last_write,
              char_length(p.description) AS chars
         FROM places p
        WHERE p.is_visible = TRUE AND p.merged_into_id IS NULL
          AND p.description IS NOT NULL AND btrim(p.description) <> ''`,
    );
    let byModel = 0, modelThenEdited = 0, ownerOrOther = 0, noJournal = 0;
    const writers: Record<string, number> = {};
    for (const r of rows) {
      const last = r.last_write;
      if (!last) { noJournal++; continue; }
      const by = last.by ?? 'не записан';
      writers[by] = (writers[by] ?? 0) + 1;
      if (descriptionWrittenByModel(last, r.chars != null ? Number(r.chars) : null)) byModel++;
      else if (isModelDescriptionWriter(last.by)) modelThenEdited++;
      else ownerOrOther++;
    }
    return NextResponse.json({
      ok: true,
      checked_at: new Date().toISOString(),
      visible_with_description: rows.length,
      /** Подписаны на карточке «написала модель». */
      by_model: byModel,
      /** Последней писала модель, но текст с тех пор правлен — подписи нет. */
      model_then_edited: modelThenEdited,
      owner_or_other_writer: ownerOrOther,
      /** Журнала нет: откуда текст, не записано. */
      no_journal: noJournal,
      last_writer: writers,
    });
  } catch (err) {
    const code = (err as { code?: string }).code;
    console.error('[description-writers-census] перепись не выполнилась:', code ?? (err instanceof Error ? err.message : err));
    return NextResponse.json({ ok: false, error: 'перепись не выполнилась', sqlstate: code ?? null }, { status: 500 });
  }
}
