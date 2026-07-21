/**
 * KVERT ACC sync — тянет авиационные цветовые коды вулканов из KVERT VONA
 * и пишет в volcano_status (migration 728). Сопоставляет вулкан с точкой
 * places (location_type='volcano') по русскому имени.
 *
 * Сетевая выборка идёт с прод-сервера (российский IP Timeweb — KVERT доступен;
 * с других IP отдаёт 403). Парсинг — в lib/services/kvert-vona.ts (чистый, тестируемый).
 *
 * Источник настраивается через env KVERT_VONA_URL (дефолт — страница релизов KVERT).
 * ВАЖНО: точный URL/формат ленты VONA у KVERT нужно подтвердить одним прогоном
 * на проде — при расхождении скорректировать KVERT_VONA_URL. Ручной путь
 * (setVolcanoAcc через PATCH /api/admin/safety/kvert-sync) работает независимо.
 */

import { pool } from '@/lib/db-pool';
import { parseVonaFeed, normalizeVolcanoName, type AccColor } from '@/lib/services/safety/kvert-vona';

const DEFAULT_KVERT_URL = 'http://www.kscnet.ru/ivs/kvert/van/index.php?type=3';

export interface KvertSyncResult {
  fetched: number;    // распознано VONA-блоков
  upserted: number;   // записано в volcano_status
  matched: number;    // сопоставлено с точкой places
  unmatched: string[];// имена вулканов без привязки к точке
}

/**
 * Резолвит ark_id точки-вулкана по русскому имени. Возвращает null, если точки нет.
 * Отдельная функция — чтобы sync не падал на одном вулкане.
 */
async function resolvePlaceArkId(nameRu: string): Promise<string | null> {
  const { rows } = await pool.query<{ ark_id: string }>(
    `SELECT ark_id FROM places
      WHERE location_type = 'volcano' AND ark_id IS NOT NULL
        AND (name ILIKE $1 OR name ILIKE $1 || '%')
      ORDER BY length(name) ASC
      LIMIT 1`,
    [nameRu]
  );
  return rows[0]?.ark_id ?? null;
}

/** UPSERT одной записи по name_normalized. Идемпотентно. */
async function upsertStatus(params: {
  slug: string;
  volcanoName: string;
  nameRu: string | null;
  placeArkId: string | null;
  color: AccColor;
  activityLevel: string | null;
  ashHeightM: number | null;
  summary: string | null;
  sourceUrl: string | null;
  observedAt: Date | null;
}): Promise<void> {
  await pool.query(
    `INSERT INTO volcano_status
       (place_ark_id, volcano_name, name_normalized, aviation_color_code,
        activity_level, ash_height_m, summary, source_url, source_name, observed_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'KVERT', $9, NOW())
     ON CONFLICT (name_normalized) DO UPDATE SET
       place_ark_id        = COALESCE(EXCLUDED.place_ark_id, volcano_status.place_ark_id),
       volcano_name        = EXCLUDED.volcano_name,
       aviation_color_code = EXCLUDED.aviation_color_code,
       activity_level      = EXCLUDED.activity_level,
       ash_height_m        = EXCLUDED.ash_height_m,
       summary             = EXCLUDED.summary,
       source_url          = EXCLUDED.source_url,
       observed_at         = EXCLUDED.observed_at,
       updated_at          = NOW()`,
    [
      params.placeArkId, params.volcanoName, params.slug, params.color,
      params.activityLevel, params.ashHeightM, params.summary, params.sourceUrl, params.observedAt,
    ]
  );
}

/** Полный синк: fetch → parse → resolve → upsert. Non-fatal по каждому вулкану. */
export async function syncKvertAcc(): Promise<KvertSyncResult> {
  const url = process.env.KVERT_VONA_URL || DEFAULT_KVERT_URL;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'TourHabKamchatka/1.0 (safety monitoring)' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`KVERT недоступен: HTTP ${res.status}`);
  const text = await res.text();

  const parsed = parseVonaFeed(text);
  const result: KvertSyncResult = { fetched: parsed.length, upserted: 0, matched: 0, unmatched: [] };

  for (const v of parsed) {
    if (!v.nameSlug) { result.unmatched.push(v.volcanoName); continue; }
    try {
      const placeArkId = v.nameRu ? await resolvePlaceArkId(v.nameRu) : null;
      await upsertStatus({
        slug: v.nameSlug,
        volcanoName: v.volcanoName,
        nameRu: v.nameRu,
        placeArkId,
        color: v.color,
        activityLevel: v.summary ? v.summary.slice(0, 200) : null,
        ashHeightM: v.ashHeightM,
        summary: v.summary,
        sourceUrl: url,
        observedAt: v.observedAt,
      });
      result.upserted++;
      if (placeArkId) result.matched++;
      else result.unmatched.push(v.volcanoName);
    } catch {
      result.unmatched.push(v.volcanoName);
    }
  }

  return result;
}

/**
 * Ручная установка цвета одного вулкана (админ). Работает независимо от KVERT-фетча —
 * коды меняются редко, поэтому ручной путь надёжен и доступен сразу.
 */
export async function setVolcanoAcc(params: {
  volcanoName: string;
  color: AccColor;
  ashHeightM?: number | null;
  summary?: string | null;
}): Promise<{ ok: boolean; matched: boolean }> {
  const norm = normalizeVolcanoName(params.volcanoName);
  const slug = norm?.slug ?? params.volcanoName.trim().toLowerCase().replace(/\s+/g, '-');
  const nameRu = norm?.ru ?? params.volcanoName.trim();
  const placeArkId = await resolvePlaceArkId(nameRu);

  await upsertStatus({
    slug,
    volcanoName: params.volcanoName.trim(),
    nameRu,
    placeArkId,
    color: params.color,
    activityLevel: params.summary ?? null,
    ashHeightM: params.ashHeightM ?? null,
    summary: params.summary ?? null,
    sourceUrl: null,
    observedAt: new Date(),
  });

  return { ok: true, matched: !!placeArkId };
}
