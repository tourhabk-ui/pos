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
 *
 * С 22.10 (1310, «всю не правду») — и итог снятия: у скольких описаний без
 * журнала источник ГВП (подпись карточки ставится по тому же равенству
 * текстов), сколько значений лежит в архиве 1310 по полям и сколько сути,
 * доступа, сезона и заметок Кузьмича осталось на видимых карточках. После
 * 1310 на карточке остаётся только текст с записанным автором или
 * источником: `no_journal_without_source` обязан быть 0.
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { descriptionWrittenByModel, isModelDescriptionWriter, type LastDescriptionWrite } from '@/lib/places/description-by-model';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface Row { last_write: LastDescriptionWrite | null; chars: number | null; gvp: boolean }
interface FieldsRow {
  essence: string; access_info: string; best_season: string; seasonal_notes: string; kuzmich_review: string;
}

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
              char_length(p.description) AS chars,
              -- Источник ГВП — то же равенство текстов, что ставит подпись
              -- на карточке (lib/places/place-detail.ts).
              EXISTS (SELECT 1 FROM place_description_drafts gvp
                       WHERE gvp.place_id = p.id AND gvp.source = 'gvp'
                         AND gvp.status = 'approved' AND gvp.translated_text = p.description) AS gvp
         FROM places p
        WHERE p.is_visible = TRUE AND p.merged_into_id IS NULL
          AND p.description IS NOT NULL AND btrim(p.description) <> ''`,
    );
    let byModel = 0, modelThenEdited = 0, ownerOrOther = 0, noJournal = 0, gvpSource = 0, noJournalWithoutSource = 0;
    const writers: Record<string, number> = {};
    for (const r of rows) {
      if (r.gvp) gvpSource++;
      const last = r.last_write;
      if (!last) {
        noJournal++;
        if (!r.gvp) noJournalWithoutSource++;
        continue;
      }
      const by = last.by ?? 'не записан';
      writers[by] = (writers[by] ?? 0) + 1;
      if (descriptionWrittenByModel(last, r.chars != null ? Number(r.chars) : null)) byModel++;
      else if (isModelDescriptionWriter(last.by)) modelThenEdited++;
      else ownerOrOther++;
    }

    const archived = await pool.query<{ field: string; n: string }>(
      `SELECT field, COUNT(*)::text AS n FROM place_text_archive WHERE migration = '1310' GROUP BY field`,
    );
    const fields = await pool.query<FieldsRow>(
      `SELECT COUNT(*) FILTER (WHERE btrim(COALESCE(essence, '')) <> '')::text        AS essence,
              COUNT(*) FILTER (WHERE btrim(COALESCE(access_info, '')) <> '')::text    AS access_info,
              COUNT(*) FILTER (WHERE btrim(COALESCE(best_season, '')) <> '')::text    AS best_season,
              COUNT(*) FILTER (WHERE seasonal_notes IS NOT NULL)::text                AS seasonal_notes,
              COUNT(*) FILTER (WHERE btrim(COALESCE(kuzmich_review, '')) <> '')::text AS kuzmich_review
         FROM places
        WHERE is_visible = TRUE AND merged_into_id IS NULL`,
    );
    const f = fields.rows[0];

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
      /** Перевод ГВП слово в слово — источник подписан на карточке. */
      gvp_source: gvpSource,
      /** Ни журнала, ни ГВП. После 1310 — 0. */
      no_journal_without_source: noJournalWithoutSource,
      last_writer: writers,
      /** Снято миграцией 1310, по полям (архив place_text_archive). */
      archived_1310: Object.fromEntries(archived.rows.map((r) => [r.field, Number(r.n)])),
      /** Сколько видимых карточек ещё несут текст в остальных полях. */
      visible_with_field: f ? {
        essence: Number(f.essence),
        access_info: Number(f.access_info),
        best_season: Number(f.best_season),
        seasonal_notes: Number(f.seasonal_notes),
        kuzmich_review: Number(f.kuzmich_review),
      } : null,
    });
  } catch (err) {
    const code = (err as { code?: string }).code;
    console.error('[description-writers-census] перепись не выполнилась:', code ?? (err instanceof Error ? err.message : err));
    return NextResponse.json({ ok: false, error: 'перепись не выполнилась', sqlstate: code ?? null }, { status: 500 });
  }
}
