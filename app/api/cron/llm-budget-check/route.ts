/**
 * GET /api/cron/llm-budget-check
 * Считает дневные LLM-затраты из llm_usage_log.
 * Если сумма превышает AI_DAILY_BUDGET_USD — отправляет Telegram-алерт владельцу.
 * Запускать ежечасно или реже.
 */

import { pool } from '@/lib/db-pool';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { recordCronRun } from '@/lib/agents/cron-heartbeat';
import { notifyBudgetAlert } from '@/lib/telegram/admin-notify';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const secret = getCronSecret(req);
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return Response.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (!timingSafeCompare(secret, cronSecret)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const startedAt = Date.now();

  const limitUsd = parseFloat(process.env.AI_DAILY_BUDGET_USD ?? '0');
  if (!limitUsd) {
    recordCronRun('llm-budget', startedAt, 'success');
    return Response.json({ ok: true, status: 'skipped', reason: 'AI_DAILY_BUDGET_USD not set' });
  }

  // Heartbeat пишется ПОСЛЕ проверки, по её исходу. Раньше success уходил
  // до запроса к БД, а сам запрос стоял без catch: упавшая БД давала
  // не-JSON 500 и при этом «живой успешный» крон в реестре — проверка,
  // которая не смогла выполниться, отчитывалась хорошей.
  try {
    // #1862: estimated_cost_usd теперь может быть NULL («цену не знаем»,
    // миграция 961) — а SUM(...) молча пропускает NULL, считая её нулём.
    // Бюджет по КАЛЬКУЛИРУЕМЫМ строкам остаётся точным; строки с неизвестной
    // ценой не должны пропадать из ответа — иначе «потрачено X» читалось бы
    // как факт там, где часть трат не посчитана вовсе.
    const { rows } = await pool.query<{ spent: string; unknown_calls: string }>(`
      SELECT
        COALESCE(SUM(estimated_cost_usd), 0)::text AS spent,
        COUNT(*) FILTER (WHERE estimated_cost_usd IS NULL)::text AS unknown_calls
      FROM llm_usage_log
      WHERE created_at >= DATE_TRUNC('day', NOW())
    `);

    const spentUsd = parseFloat(rows[0]?.spent ?? '0');
    const unknownCalls = parseInt(rows[0]?.unknown_calls ?? '0', 10);
    if (unknownCalls > 0) {
      // Не ошибка крона — честная третья форма: посчитано по известному,
      // а часть вызовов сегодня прошла без цены (нет в каталоге и в запасе).
      console.error(`[llm-budget-check] ${unknownCalls} вызовов сегодня без цены — spent_usd занижен на их долю`);
    }
    recordCronRun('llm-budget', startedAt, 'success');

    if (spentUsd >= limitUsd) {
      notifyBudgetAlert(spentUsd, limitUsd);
      return Response.json({
        ok: true,
        status: 'alert_sent',
        spent_usd: spentUsd,
        limit_usd: limitUsd,
        unknown_cost_calls: unknownCalls,
      });
    }

    return Response.json({
      ok: true,
      status: 'ok',
      spent_usd: spentUsd,
      limit_usd: limitUsd,
      unknown_cost_calls: unknownCalls,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка запроса к llm_usage_log';
    console.error('[llm-budget-check] проверка не выполнена:', message);
    recordCronRun('llm-budget', startedAt, 'failed', { error: message });
    return Response.json({ ok: false, status: 'error', error: message }, { status: 502 });
  }
}
