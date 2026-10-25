/**
 * Действующие предупреждения МЧС из external_alerts для Кузьмича и планера.
 * Отказ чтения — отдельный исход, не пустой список «предупреждений нет».
 */

import { pool } from '@/lib/db-pool';
import { UTC_WALL_NOW_SQL } from '@/lib/db/timestamp-iso';
import {
  formatWarningBlock, MCHS_UNREAD_NOTE, warningsFromRows,
  type ActiveWarning, type AlertWarningRow,
} from '@/lib/safety/mchs-bulletin';

export type ActiveWarningLoad =
  | { ok: true; warnings: ActiveWarning[] }
  | { ok: false; warnings: [] };

export async function loadActiveWarnings(): Promise<ActiveWarningLoad> {
  try {
    const res = await pool.query<AlertWarningRow>(
      `SELECT alert_type, title, description, source_url, volcano_name
         FROM external_alerts
        WHERE (expires_at IS NULL OR expires_at > ${UTC_WALL_NOW_SQL})
          AND severity >= 1
          AND alert_type IN ('volcanic_eruption', 'road_closure')
        ORDER BY severity DESC, created_at DESC
        LIMIT 30`,
    );
    return { ok: true, warnings: warningsFromRows(res?.rows ?? []) };
  } catch (err) {
    const code = (err as { code?: string } | null)?.code ?? 'unknown';
    console.error(`[mchs] действующие предупреждения не прочитаны, SQLSTATE ${code}`);
    return { ok: false, warnings: [] };
  }
}

/** Блок для промпта и для разбора ответа. Пусто — действующих строк нет. */
export async function mchsPromptBlock(): Promise<string> {
  const loaded = await loadActiveWarnings();
  if (!loaded.ok) return MCHS_UNREAD_NOTE;
  return formatWarningBlock(loaded.warnings);
}
