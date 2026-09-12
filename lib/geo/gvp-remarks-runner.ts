/**
 * Раннер: тянет Remarks с WFS ГВП, переводит через AI, пишет ЧЕРНОВИК —
 * #1830. НИКОГДА не пишет в `places.description` напрямую: только в
 * `place_description_drafts`, и только для мест, у которых ещё нет
 * рассмотренного (`approved`/`rejected`) черновика — уже принятое решение
 * человека этот прогон не переписывает молча.
 *
 * Перевод — `callAIQualityOrNull`, а не `callAIWaterfall`/`callAIFast`:
 * тот же выбор, что у Editor (`lib/agents/editor.ts`) для текста, который
 * читают люди — цена ошибки там не в токенах, а в доверии к описанию места.
 */

import { pool } from '@/lib/db-pool';
import { KAMCHATKA_BOUNDS } from '@/lib/services/routes/geocode';
import { buildGvpRemarksUrl, parseGvpRemarks, type GvpRemark } from '@/lib/geo/gvp-remarks';
import { GVP_CONFIRMED_PAIRS } from '@/lib/geo/gvp-confirmed-pairs';
import { callAIQualityOrNull } from '@/lib/ai/providers';

const GVP_HEADERS = {
  'Accept': 'application/json',
  'User-Agent': 'KamchatourHub-GVP-Remarks/1.0 (+https://vedarai.ru)',
};
const GVP_TIMEOUT_MS = 30_000;
const TRANSLATION_MODEL_LABEL = 'callAIQuality (waterfall)';

export async function fetchGvpRemarks(bounds = KAMCHATKA_BOUNDS): Promise<GvpRemark[]> {
  const url = buildGvpRemarksUrl(bounds);
  const res = await fetch(url, { headers: GVP_HEADERS, signal: AbortSignal.timeout(GVP_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`GVP WFS HTTP ${res.status}`);
  return parseGvpRemarks(await res.json());
}

function translationPrompt(placeName: string, remarks: string) {
  return [
    {
      role: 'system' as const,
      content:
        'Ты переводчик геологических текстов о вулканах Камчатки для туристической платформы. ' +
        'Переводи ТОЧНО: даты извержений, высоту, тип вулкана и другие факты нельзя менять, ' +
        'домысливать или упускать. Стиль — понятный турист-friendly русский, не подстрочник, ' +
        'но факт в тексте обязан совпадать с оригиналом один в один. Ответ — только сам ' +
        'переведённый текст, без вступлений вида "Вот перевод:" и без своих комментариев.',
    },
    {
      role: 'user' as const,
      content:
        `Название вулкана по-русски (карточка места на нашей платформе): ${placeName}.\n\n` +
        `Оригинал (Global Volcanism Program, Смитсоновский институт):\n\n${remarks}`,
    },
  ];
}

export interface DraftOutcome {
  placeId: string;
  placeName: string;
  volcanoNumber: number;
  status: 'written' | 'skipped_reviewed' | 'skipped_no_remarks' | 'skipped_translation_failed';
}

export interface RunDraftsParams {
  dryRun: boolean;
  bounds?: typeof KAMCHATKA_BOUNDS;
}

export interface RunDraftsResult {
  outcomes: DraftOutcome[];
  remarksFetchedTotal: number;
}

/**
 * dryRun=true не зовёт AI и не пишет в БД — только показывает, у какого места
 * что бы произошло и сколько символов Remarks нашлось. Дёшево проверить
 * охват до того, как тратить токены на перевод (тот же приём, что у
 * `place-coords`/`images-to-s3`: сухой прогон по умолчанию).
 */
export async function runGvpRemarksDrafts(params: RunDraftsParams): Promise<RunDraftsResult> {
  const bounds = params.bounds ?? KAMCHATKA_BOUNDS;
  const remarks = await fetchGvpRemarks(bounds);
  const remarksByVolcano = new Map(remarks.map(r => [r.volcanoNumber, r.remarks]));

  // Уже рассмотренные (approved/rejected) — решение человека, не переписывать молча.
  const { rows: reviewedRows } = await pool.query<{ place_id: string }>(
    `SELECT place_id FROM place_description_drafts WHERE source = 'gvp' AND status <> 'pending'`,
  );
  const reviewed = new Set(reviewedRows.map(r => r.place_id));

  const translationCache = new Map<number, string | null>();
  const outcomes: DraftOutcome[] = [];

  for (const pair of GVP_CONFIRMED_PAIRS) {
    if (reviewed.has(pair.placeId)) {
      outcomes.push({ placeId: pair.placeId, placeName: pair.placeName, volcanoNumber: pair.volcanoNumber, status: 'skipped_reviewed' });
      continue;
    }

    const remarksText = remarksByVolcano.get(pair.volcanoNumber);
    if (!remarksText) {
      outcomes.push({ placeId: pair.placeId, placeName: pair.placeName, volcanoNumber: pair.volcanoNumber, status: 'skipped_no_remarks' });
      continue;
    }

    if (params.dryRun) {
      outcomes.push({ placeId: pair.placeId, placeName: pair.placeName, volcanoNumber: pair.volcanoNumber, status: 'written' });
      continue;
    }

    let translated = translationCache.get(pair.volcanoNumber);
    if (translated === undefined) {
      translated = await callAIQualityOrNull(translationPrompt(pair.placeName, remarksText), { maxTokens: 1200 });
      translationCache.set(pair.volcanoNumber, translated);
    }

    if (!translated) {
      outcomes.push({ placeId: pair.placeId, placeName: pair.placeName, volcanoNumber: pair.volcanoNumber, status: 'skipped_translation_failed' });
      continue;
    }

    await pool.query(
      `INSERT INTO place_description_drafts
         (place_id, source, source_ref, original_text, translated_text, model, status, created_at)
       VALUES ($1, 'gvp', $2, $3, $4, $5, 'pending', NOW())
       ON CONFLICT (place_id, source) DO UPDATE
         SET source_ref = EXCLUDED.source_ref,
             original_text = EXCLUDED.original_text,
             translated_text = EXCLUDED.translated_text,
             model = EXCLUDED.model,
             created_at = NOW(),
             reviewed_at = NULL
         WHERE place_description_drafts.status = 'pending'`,
      [pair.placeId, String(pair.volcanoNumber), remarksText, translated, TRANSLATION_MODEL_LABEL],
    );
    outcomes.push({ placeId: pair.placeId, placeName: pair.placeName, volcanoNumber: pair.volcanoNumber, status: 'written' });
  }

  return { outcomes, remarksFetchedTotal: remarks.length };
}
