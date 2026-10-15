/**
 * GET /api/cron/zh-translate — машинный перевод публичных текстов живых туров
 * и мест на китайский (аудит 15.10, CN-pages; Китай, шаг 7, вариант «в»).
 *
 * Кто зовёт: workflow zh-translate.yml по маркеру
 * .github/triggers/zh-translate.json (интеграция Claude не имеет права на
 * workflow_dispatch). Под CRON_SECRET.
 *
 * Что переводится — lib/zh/fields (ZH_TOUR_FIELDS, ZH_PLACE_FIELDS), у кого —
 * lib/zh/content: живые туры под шлюзом витрины и места на их маршрутах.
 * Как и с какими сверками — lib/zh/translate.
 *
 * Параметры:
 *   apply=1 — переводить и писать. Без него — сухой прогон: только счёт, что
 *             свежо, что устарело, чего нет; модель не зовётся и токены не
 *             тратятся;
 *   limit   — полей за прогон, 1–10 (по умолчанию 10): партия ограничена,
 *             чтобы один вызов не жёг бюджет вслепую и укладывался во время;
 *   kind    — tour | place | all (по умолчанию all).
 *
 * Исходы (§4.0), все в ответе:
 *   translated     — переведено и записано;
 *   not_translated — модель не ответила, ответ не прошёл сверку или запись
 *                    упала: с причиной. Пустая строка как перевод не
 *                    пишется никогда;
 *   skipped_fresh  — уже переведено с нынешнего текста;
 *   pending_left   — сколько полей ждёт следующей партии.
 * Боевой прогон, у которого была работа и не переведено ничего, — 502: ноль
 * результатов при ненулевом входе — отказ, а не успех. Отказ базы — 500 с
 * SQLSTATE.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';
import {
  ZH_LANG, ZH_PLACE_FIELDS, ZH_TOUR_FIELDS, encodeStored, normalizeSource, sourceHash,
  type ZhEntityType, type ZhFieldKind, type ZhFieldValue,
} from '@/lib/zh/fields';
import { translateFieldValue } from '@/lib/zh/translate';
import {
  loadTranslations, loadZhPlaceSources, loadZhTourSources, logZhFailure,
} from '@/lib/zh/content';

export const dynamic = 'force-dynamic';
export const maxDuration = 600;

export const ZH_TRANSLATE_LIMIT_MAX = 10;

const QuerySchema = z.object({
  apply: z.enum(['0', '1', 'true', 'false']).default('0').transform((v) => v === '1' || v === 'true'),
  limit: z.coerce.number().int().min(1).max(ZH_TRANSLATE_LIMIT_MAX).default(ZH_TRANSLATE_LIMIT_MAX),
  kind: z.enum(['tour', 'place', 'all']).default('all'),
});

/** Поле, которое ждёт перевода. */
export interface ZhWorkItem {
  entity_type: ZhEntityType;
  entity_id: string;
  field: string;
  kind: ZhFieldKind;
  /** missing — перевода нет; stale — исходник менялся после перевода. */
  state: 'missing' | 'stale';
  source: ZhFieldValue;
  hash: string;
}

interface Census { fields_total: number; fresh: number; work: ZhWorkItem[] }

function planEntity(
  census: Census,
  entityType: ZhEntityType,
  id: string,
  fields: Record<string, ZhFieldKind>,
  row: Record<string, unknown>,
  stored: Map<string, { source_hash: string }> | undefined,
): void {
  for (const [field, kind] of Object.entries(fields)) {
    const source = normalizeSource(kind, row[field]);
    if (source === null) continue;
    census.fields_total++;
    const hash = sourceHash(kind, source);
    const prev = stored?.get(field);
    if (prev && prev.source_hash === hash) { census.fresh++; continue; }
    census.work.push({ entity_type: entityType, entity_id: id, field, kind, state: prev ? 'stale' : 'missing', source, hash });
  }
}

const UPSERT_SQL = `
  INSERT INTO content_translations
    (entity_type, entity_id, field, lang, source_hash, text, back_translation, model, translated_at, reviewed_by, reviewed_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NULL, NULL)
  ON CONFLICT (entity_type, entity_id, field, lang) DO UPDATE
     SET source_hash = EXCLUDED.source_hash,
         text = EXCLUDED.text,
         back_translation = EXCLUDED.back_translation,
         model = EXCLUDED.model,
         translated_at = NOW(),
         -- Новый текст никем не вычитан: прежняя отметка относилась к прежнему.
         reviewed_by = NULL,
         reviewed_at = NULL`;

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (!timingSafeCompare(getCronSecret(request), cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const sp = request.nextUrl.searchParams;
  const parsed = QuerySchema.safeParse({
    apply: sp.get('apply') ?? undefined,
    limit: sp.get('limit') ?? undefined,
    kind: sp.get('kind') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: `параметры: ${parsed.error.issues[0]?.message ?? 'неверны'}` }, { status: 400 });
  }
  const { apply, limit, kind } = parsed.data;

  const census: Census = { fields_total: 0, fresh: 0, work: [] };
  let entities = { tours: 0, places: 0 };
  try {
    if (kind !== 'place') {
      const tours = await loadZhTourSources();
      const stored = await loadTranslations('tour', tours.map((t) => t.id));
      for (const t of tours) {
        planEntity(census, 'tour', t.id, ZH_TOUR_FIELDS, t as unknown as Record<string, unknown>, stored.get(t.id));
      }
      entities = { ...entities, tours: tours.length };
    }
    if (kind !== 'tour') {
      const places = await loadZhPlaceSources();
      const stored = await loadTranslations('place', places.map((p) => p.id));
      for (const p of places) {
        planEntity(census, 'place', p.id, ZH_PLACE_FIELDS, p as unknown as Record<string, unknown>, stored.get(p.id));
      }
      entities = { ...entities, places: places.length };
    }
  } catch (err) {
    logZhFailure('zh-translate: исходники и переводы', err);
    const code = (err as { code?: unknown } | null)?.code;
    return NextResponse.json({
      ok: false,
      error: 'база не прочитана — переводить не из чего, и это не «всё переведено»',
      sqlstate: typeof code === 'string' ? code : null,
    }, { status: 500 });
  }

  const pendingList = census.work.map(({ entity_type, entity_id, field, state }) => ({ entity_type, entity_id, field, state }));
  const base = {
    probe: 'zh_translate_v1',
    measured_at: new Date().toISOString(),
    mode: apply ? 'apply' : 'dry',
    lang: ZH_LANG,
    entities,
    fields_total: census.fields_total,
    skipped_fresh: census.fresh,
    pending: census.work.length,
    pending_stale: census.work.filter((w) => w.state === 'stale').length,
  };

  if (!apply) {
    return NextResponse.json({ ok: true, ...base, pending_sample: pendingList.slice(0, 30) });
  }

  const batch = census.work.slice(0, limit);
  const translated: Array<{ entity_type: ZhEntityType; entity_id: string; field: string }> = [];
  const notTranslated: Array<{ entity_type: ZhEntityType; entity_id: string; field: string; reason: string }> = [];

  for (const item of batch) {
    const key = { entity_type: item.entity_type, entity_id: item.entity_id, field: item.field };
    const outcome = await translateFieldValue(item.kind, item.source);
    if (!outcome.ok) {
      console.error('[zh-translate] не переведено:', item.entity_type, item.entity_id, item.field, outcome.reason);
      notTranslated.push({ ...key, reason: outcome.reason });
      continue;
    }
    try {
      await pool.query(UPSERT_SQL, [
        item.entity_type, item.entity_id, item.field, ZH_LANG, item.hash,
        encodeStored(item.kind, outcome.zh),
        outcome.back === null ? null : encodeStored(item.kind, outcome.back),
        outcome.model,
      ]);
      translated.push(key);
    } catch (err) {
      logZhFailure(`zh-translate: запись ${item.entity_type}/${item.entity_id}/${item.field}`, err);
      const code = (err as { code?: unknown } | null)?.code;
      notTranslated.push({ ...key, reason: `запись не прошла${typeof code === 'string' ? ` (SQLSTATE ${code})` : ''}` });
    }
  }

  // Работа была, а не переведено ничего — отказ, а не «всё хорошо» (§4.0).
  const failed = batch.length > 0 && translated.length === 0;
  return NextResponse.json({
    ok: !failed,
    ...base,
    attempted: batch.length,
    translated,
    not_translated: notTranslated,
    pending_left: census.work.length - translated.length,
  }, { status: failed ? 502 : 200 });
}
