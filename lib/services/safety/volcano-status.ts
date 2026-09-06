/**
 * Текущие авиационные коды KVERT — то, что известно про вулканы ПРЯМО СЕЙЧАС.
 *
 * ПОВОД (владелец 06.09). Вкладка «Вулканы» кормилась только новостями МЧС и
 * СМИ через external_alerts. Замер prod-check run 15: за семь суток там одна
 * запись, и той шесть дней. Экран выглядел замершим — а коды KVERT в
 * volcano_status при этом обновлялись синком каждые 6 часов и показывались
 * только на главной. То есть свежее знание у платформы было, а на экране
 * безопасности его не было.
 *
 * Новости и коды отвечают на разные вопросы. Новость говорит «что случилось»,
 * код — «в каком состоянии вулкан сейчас». Тихо в новостях не значит «нечего
 * показать»: у кодов своё время наблюдения, и оно тоже названо (§4.0).
 *
 * Подписи цветов и правило устаревания НЕ заводятся здесь заново — они живут в
 * lib/services/safety/kvert-vona (ACC_META, VOLCANO_STALE_DAYS) и уже кормят
 * карточку места и Кузьмича. Второй словарь тех же цветов разошёлся бы с
 * первым.
 */
import { pool } from '@/lib/db-pool';
import type { AccColor } from '@/lib/services/safety/kvert-vona';

export interface VolcanoStatusRow {
  name: string;
  color: AccColor;
  summary: string | null;
  ash_height_m: number | null;
  observed_at: string | null;
  source_url: string | null;
}

export interface VolcanoStatusFeed {
  /** Вулканы с кодом выше зелёного — те, о ком есть что сказать. */
  elevated: VolcanoStatusRow[];
  /** Сколько вулканов в реестре кодов и сколько из них спокойны. */
  total: number | null;
  green: number | null;
  /** Когда синк KVERT в последний раз обновлял реестр. null — не знаем. */
  updated_at: string | null;
}

const ELEVATED: readonly string[] = ['yellow', 'orange', 'red'];

/**
 * Никогда не бросает: вкладка вулканов не должна падать из-за реестра кодов.
 * Отказ — это `total: null` («не смогли посчитать»), а не ноль вулканов.
 */
export async function getVolcanoStatuses(): Promise<VolcanoStatusFeed> {
  try {
    const { rows } = await pool.query<{
      volcano_name: string;
      aviation_color_code: string;
      summary: string | null;
      ash_height_m: number | null;
      observed_at: Date | null;
      source_url: string | null;
      updated_at: Date | null;
    }>(
      `SELECT volcano_name, aviation_color_code, summary, ash_height_m,
              observed_at, source_url, updated_at
         FROM volcano_status
        ORDER BY CASE aviation_color_code
                   WHEN 'red' THEN 3 WHEN 'orange' THEN 2 WHEN 'yellow' THEN 1 ELSE 0 END DESC,
                 observed_at DESC NULLS LAST
        LIMIT 40`,
    );

    const elevated = rows
      .filter((r) => ELEVATED.includes(r.aviation_color_code))
      .map((r) => ({
        name: r.volcano_name,
        color: r.aviation_color_code as AccColor,
        summary: r.summary,
        ash_height_m: r.ash_height_m,
        observed_at: r.observed_at ? new Date(r.observed_at).toISOString() : null,
        source_url: r.source_url,
      }));

    const updated = rows
      .map((r) => (r.updated_at ? new Date(r.updated_at).getTime() : 0))
      .reduce((a, b) => Math.max(a, b), 0);

    return {
      elevated,
      total: rows.length,
      green: rows.filter((r) => r.aviation_color_code === 'green').length,
      updated_at: updated > 0 ? new Date(updated).toISOString() : null,
    };
  } catch (err) {
    // Ловить можно, молчать нельзя (§4.0). Ноль вулканов здесь был бы враньём:
    // «спокойно везде» и «мы не смогли спросить» — разные вещи.
    console.error('[safety] коды KVERT не прочитаны:', err instanceof Error ? err.message : err);
    return { elevated: [], total: null, green: null, updated_at: null };
  }
}
