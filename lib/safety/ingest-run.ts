/**
 * Когда приём тревог отработал в последний раз — один ответ на все экраны.
 *
 * ПОВОД (05.09, замер prod-check run 15). Экран безопасности спрашивал
 * «когда проверяли источник» и получал разные ответы от разных лент: у
 * вулканов время НАЖАТИЯ кнопки, у сейсмики КБГС — время последней ЗАПИСИ
 * (`MAX(created_at)` по external_alerts). Второе особенно обманчиво: перепись
 * показала приём, отработавший минуту назад, при свежайшей записи
 * землетрясения 41-часовой давности. По такому «проверено позавчера» человек
 * читает поломку там, где её нет, — ровно та же подмена, что и наоборот.
 *
 * Возраст ЗАПИСИ отвечает на вопрос «когда случилось событие». Возраст
 * ПРОГОНА — на вопрос «когда мы спрашивали». Это разные вопросы, и на экране
 * нужен второй.
 *
 * Три исхода, не два (§4.0): прогон есть — время, прогонов нет — null,
 * запрос упал — null и строка в логе. Ноль здесь не выдумывается.
 */
import { pool } from '@/lib/db-pool';

/** Агент приёма тревог: он же пишет heartbeat в agent_run_history. */
export const INGEST_AGENT_ID = 'safety-ingest';

export async function lastIngestAt(): Promise<string | null> {
  try {
    const { rows } = await pool.query<{ at: Date | null }>(
      `SELECT MAX(ended_at) AS at FROM agent_run_history
        WHERE agent_id = $1 AND status = 'success'`,
      [INGEST_AGENT_ID],
    );
    const at = rows[0]?.at;
    return at ? new Date(at).toISOString() : null;
  } catch (err) {
    // Ловить можно, молчать нельзя (§4.0).
    console.error('[safety] последний прогон приёма не установлен:', err instanceof Error ? err.message : err);
    return null;
  }
}
