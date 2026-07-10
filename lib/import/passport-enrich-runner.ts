/**
 * Раннер обогащения карточек маршрутов из OCR-паспортов (route_passport_ocr,
 * migration 730) — партиями, исполняется НА прод-сервере (файрвол managed PG
 * Timeweb, паттерн osm-import-runner / passport-ocr-runner).
 *
 * Для каждого паспорта без enriched_at (migration 732): markdown → LLM
 * (callAIWaterfall, строгий JSON) → parsePassportFields → buildRouteUpdate
 * (только пустые поля маршрута) → UPDATE kamchatka_routes. Строка помечается
 * enriched_at в любом исходе (даже если писать было нечего) — иначе
 * batched-прогон крутился бы на ней вечно.
 *
 * Всё non-fatal: ошибка одного паспорта копится в errors, партия не падает.
 */

import { pool } from '@/lib/db-pool';
import { callAIWaterfall } from '@/lib/ai/providers';
import {
  PASSPORT_EXTRACT_PROMPT,
  parsePassportFields,
  buildRouteUpdate,
  type ExistingRouteFields,
} from '@/lib/import/passport-fields';

const MAX_MARKDOWN_CHARS = 14000;
const DEFAULT_DELAY_MS = 800; // пауза между LLM-вызовами — щадим waterfall

export interface EnrichParams {
  limit: number;
  dryRun: boolean;
  delayMs?: number;
}

export interface EnrichDetail {
  route_id: string;
  title: string;
  status: 'enriched' | 'no_new_fields' | 'parse_failed' | 'error';
  fields?: string[];
}

export interface EnrichResult {
  dry_run: boolean;
  processed: number;
  enriched: number;
  fields_written: number;
  errors: string[];
  routes_pending: number;
  details: EnrichDetail[];
}

interface Row extends ExistingRouteFields {
  route_id: string;
  title: string;
  markdown: string;
}

export async function runPassportEnrich(params: EnrichParams): Promise<EnrichResult> {
  const { limit, dryRun } = params;
  const delayMs = params.delayMs ?? DEFAULT_DELAY_MS;

  const { rows } = await pool.query<Row>(`
    SELECT o.route_id, r.title, o.markdown,
           r.distance_km, r.elevation_gain_m, r.duration_hours, r.duration_days,
           r.difficulty, r.season, r.route_type, r.mchs_registration_required,
           r.hazards, r.equipment, r.flora_fauna, r.accessibility, r.park_name
    FROM route_passport_ocr o
    JOIN kamchatka_routes r ON r.id = o.route_id
    WHERE o.enriched_at IS NULL
    ORDER BY o.processed_at
    LIMIT $1
  `, [limit]);

  const pendingRes = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM route_passport_ocr WHERE enriched_at IS NULL`,
  );

  let enriched = 0;
  let fieldsWritten = 0;
  const errors: string[] = [];
  const details: EnrichDetail[] = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    try {
      const raw = await callAIWaterfall([
        { role: 'system', content: PASSPORT_EXTRACT_PROMPT },
        { role: 'user', content: r.markdown.slice(0, MAX_MARKDOWN_CHARS) },
      ]);
      const fields = parsePassportFields(raw);

      if (!fields) {
        details.push({ route_id: r.route_id, title: r.title, status: 'parse_failed' });
        if (!dryRun) await markEnriched(r.route_id);
      } else {
        const update = buildRouteUpdate(fields, r);
        if (!update) {
          details.push({ route_id: r.route_id, title: r.title, status: 'no_new_fields' });
          if (!dryRun) await markEnriched(r.route_id);
        } else {
          const cols = update.sets.map((s) => s.split(' = ')[0]);
          if (!dryRun) {
            await pool.query(
              `UPDATE kamchatka_routes SET ${update.sets.join(', ')}, updated_at = NOW() WHERE id = $${update.params.length + 1}`,
              [...update.params, r.route_id],
            );
            await markEnriched(r.route_id);
          }
          enriched++;
          fieldsWritten += cols.length;
          details.push({ route_id: r.route_id, title: r.title, status: 'enriched', fields: cols });
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${r.title}: ${msg}`);
      details.push({ route_id: r.route_id, title: r.title, status: 'error' });
      // enriched_at не ставим — паспорт вернётся в следующую партию
    }

    if (delayMs > 0 && i < rows.length - 1) {
      await new Promise((res) => setTimeout(res, delayMs));
    }
  }

  return {
    dry_run: dryRun,
    processed: rows.length,
    enriched,
    fields_written: fieldsWritten,
    errors,
    routes_pending: parseInt(pendingRes.rows[0].count),
    details,
  };
}

async function markEnriched(routeId: string): Promise<void> {
  await pool.query(`UPDATE route_passport_ocr SET enriched_at = NOW() WHERE route_id = $1`, [routeId]);
}
